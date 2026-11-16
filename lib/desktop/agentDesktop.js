const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { desktopError, safeDesktopError, positiveInteger, resolveBinary, supportsBatchStdin, execute } = require('./agentDesktopProcess');
const { validateCommand, normalizeBatchSteps, text, HEADED_COMMANDS } = require('./agentDesktopPolicy');
const appRegistry = require('./appRegistry');
const winHelper = require('./winHelper');

const CHROME_CAPTION_NAMES = new Set([
  '系统', '最小化', '最大化', '关闭', '还原', '向下还原', '帮助',
  'system', 'minimize', 'maximize', 'close', 'restore', 'restore down', 'help',
]);
const CHROME_AUTOMATION_IDS = new Set([
  'TitleBar', 'SystemMenuBar', 'Minimize-Restore', 'Maximize-Restore', 'Close', 'Minimize', 'Maximize',
]);
const EDITABLE_ROLES = new Set(['textfield', 'edit', 'document', 'searchbox', 'combobox']);
const TEXT_WRITE_COMMANDS = new Set(['type', 'set-value', 'clipboard-set']);

function scrubSensitiveFields(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) scrubSensitiveFields(item);
    return;
  }
  delete obj.value;
  delete obj.text;
  delete obj.stdin;
  delete obj.image;
  delete obj.file_url;
  delete obj.fileUrl;
  delete obj.fileUrls;
  for (const val of Object.values(obj)) scrubSensitiveFields(val);
}

function redactQuotedStrings(msg) {
  return typeof msg === 'string'
    ? msg.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '"<redacted>"')
    : msg;
}

function sanitizeBatchResponse(body, hasTextWrite = false) {
  if (!body || !Array.isArray(body.results)) return body;
  for (const entry of body.results) {
    if (!entry || typeof entry !== 'object') continue;
    const isReadCmd = entry.command === 'get' || entry.command === 'clipboard-get';
    if (TEXT_WRITE_COMMANDS.has(entry.command)) {
      if (entry.data) scrubSensitiveFields(entry.data);
      if (entry.error?.details) scrubSensitiveFields(entry.error.details);
    } else if (hasTextWrite && !isReadCmd && entry.data && typeof entry.data === 'object') {
      if (entry.data.post_state && typeof entry.data.post_state === 'object') {
        scrubSensitiveFields(entry.data.post_state);
      }
    }
    if (hasTextWrite && entry.error) {
      if (typeof entry.error.message === 'string') entry.error.message = redactQuotedStrings(entry.error.message);
      if (entry.error.details) scrubSensitiveFields(entry.error.details);
    }
  }
  return body;
}

function isMockBinaryClient(config) {
  if (Array.isArray(config.binaryArgs) && config.binaryArgs.length > 0) return true;
  if (!config.binaryPath) return false;
  const norm = String(config.binaryPath).toLowerCase();
  const tmp = String(os.tmpdir() || '').toLowerCase();
  return (tmp && norm.startsWith(tmp))
    || /\.(c?js|mjs|bat|cmd|ps1)$/i.test(norm)
    || path.basename(norm) === path.basename(process.execPath).toLowerCase();
}

function summarizeSnapshotCapabilities(snapshotData) {
  const refCount = Number(snapshotData?.ref_count ?? 0);
  const editableRefs = [];
  const readOnlyEditableRefs = [];
  const buttonRefs = [];
  let clientInteractiveCount = 0;

  function visit(node, depth, parentInChrome = false) {
    if (!node || typeof node !== 'object') return;
    const role = String(node.role || '').toLowerCase();
    const name = String(node.name || '').trim();
    const autoId = node.native_id?.kind === 'automation_id' ? String(node.native_id.value || '') : '';
    const inChrome = parentInChrome
      || role === 'titlebar'
      || (depth <= 2 && (autoId === 'TitleBar' || autoId === 'SystemMenuBar'));
    const ref = typeof node.ref_id === 'string' ? node.ref_id : (typeof node.ref === 'string' ? node.ref : '');
    if (ref) {
      const isCaptionChrome = inChrome
        || (depth === 0 && role === 'window')
        || (depth <= 3 && CHROME_AUTOMATION_IDS.has(autoId))
        || (depth <= 3 && (role === 'button' || role === 'menuitem' || role === 'menubar' || role === 'menu') && CHROME_CAPTION_NAMES.has(name.toLowerCase()));
      if (!isCaptionChrome) {
        const states = Array.isArray(node.states) ? node.states.map(s => String(s).toLowerCase()) : [];
        const availableActions = Array.isArray(node.available_actions) ? node.available_actions.map(String) : [];
        const isDisabled = states.includes('disabled') || states.includes('unavailable');
        const isReadOnly = states.includes('readonly')
          || (role === 'textfield' && availableActions.length > 0 && !availableActions.includes('SetValue') && !availableActions.includes('TypeText'));
        if (!isDisabled) clientInteractiveCount += 1;
        if (EDITABLE_ROLES.has(role)) {
          const entry = {
            ref,
            role,
            name,
            ...(isReadOnly ? { readonly: true } : {}),
            ...(isDisabled ? { disabled: true } : {}),
            ...(states.length ? { states } : {}),
            ...(availableActions.length ? { availableActions } : {}),
          };
          if (isReadOnly || isDisabled) readOnlyEditableRefs.push(entry);
          else editableRefs.push(entry);
        } else if (role === 'button' && !isDisabled) {
          buttonRefs.push({ ref, role, name });
        }
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child, depth + 1, inChrome);
    }
  }

  if (snapshotData?.tree) visit(snapshotData.tree, 0, false);
  const mode = (refCount === 0 || clientInteractiveCount === 0) ? 'custom_ui_visual' : 'uia_semantic';
  return { mode, refCount, clientInteractiveCount, editableRefs, readOnlyEditableRefs, buttonRefs };
}

function createDesktopClient(options = {}) {
  const config = {
    mode: options.mode ?? 'cooperative', readOnly: options.readOnly ?? true,
    timeoutMs: options.timeoutMs ?? 30000, maxOutputBytes: options.maxOutputBytes ?? 8 * 1024 * 1024,
    binaryPath: options.binaryPath, expectedVersion: options.expectedVersion,
    desktopHome: options.desktopHome ?? process.env.AGENT_DESKTOP_HOME,
    binaryArgs: options.binaryArgs ?? [], signal: options.signal,
    cursorHooks: options.cursorHooks,
  };
  if (!['cooperative', 'exclusive'].includes(config.mode) || typeof config.readOnly !== 'boolean') throw desktopError('INVALID_ARGS', 'Invalid desktop mode or readOnly setting');
  positiveInteger(config.timeoutMs, 'timeoutMs');
  positiveInteger(config.maxOutputBytes, 'maxOutputBytes', 64 * 1024 * 1024);
  if (config.desktopHome !== undefined && (typeof config.desktopHome !== 'string' || !path.isAbsolute(config.desktopHome) || config.desktopHome.includes('\0'))) throw desktopError('INVALID_ARGS', 'desktopHome must be an absolute path');
  if (!Array.isArray(config.binaryArgs) || config.binaryArgs.some(a => typeof a !== 'string' || a.includes('\0'))) throw desktopError('INVALID_ARGS', 'binaryArgs must be an array of strings');
  config.binaryArgs = [...config.binaryArgs];
  if (config.expectedVersion !== undefined && !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(config.expectedVersion)) throw desktopError('INVALID_ARGS', 'expectedVersion must be an exact semantic version');
  let resolvedBinary, checkedVersion;

  async function binary() { return resolvedBinary ||= await resolveBinary(config); }
  function executionOptions(call = {}) {
    return {
      timeoutMs: call.timeoutMs ?? config.timeoutMs,
      maxOutputBytes: call.maxOutputBytes ?? config.maxOutputBytes,
      signal: call.signal ?? config.signal, input: call.input, desktopHome: config.desktopHome,
    };
  }
  async function version(call = {}) {
    const data = await execute(await binary(), config.binaryArgs, ['version'], executionOptions({ ...call, input: undefined }), false);
    if (typeof data?.version !== 'string') throw desktopError('AGENT_DESKTOP_PROTOCOL_ERROR', 'Desktop version response is missing the binary version');
    if (config.expectedVersion && data.version !== config.expectedVersion) throw desktopError('AGENT_DESKTOP_VERSION_MISMATCH', 'Installed agent-desktop does not match expectedVersion');
    checkedVersion = data.version;
    return data;
  }
  function shouldUseCursorHooks(call = {}) {
    return process.platform === 'win32'
      && config.cursorHooks !== false
      && call.cursorHooks !== false
      && !isMockBinaryClient(config);
  }

  async function run(args, call = {}) {
    if (call.clickMode !== undefined && !['physical_restore', 'message'].includes(call.clickMode)) {
      throw desktopError('INVALID_ARGS', 'clickMode must be physical_restore or message');
    }
    const parsed = validateCommand(args, call.input, config);
    args = [...args];
    if (parsed.command === 'version') return version(call);
    if (config.expectedVersion && !checkedVersion) await version(call);
    if (parsed.command === 'mouse-click' || (parsed.command === 'hover' && parsed.flags['--xy'])) {
      await verifyCoordinateTarget(parsed.flags['--xy'], call);
    } else if (parsed.command === 'mouse-wheel') {
      await verifyCoordinateTarget(`${parsed.flags['--x']},${parsed.flags['--y']}`, call);
    }
    if (parsed.command === 'mouse-click' && shouldUseCursorHooks(call)) {
      const [cx, cy] = String(parsed.flags['--xy'] || '').split(',').map(Number);
      if (call.clickMode === 'message' && call.windowId) {
        if (call.ripple !== false) winHelper.spawnClickRipple(cx, cy);
        return winHelper.postMessageClick(call.windowId, cx, cy, {
          button: parsed.flags['--button'],
          count: parsed.flags['--count'] ? Number(parsed.flags['--count']) : 1,
          signal: call.signal,
          timeoutMs: call.timeoutMs,
        });
      }
      if (call.ripple !== false) winHelper.spawnClickRipple(cx, cy);
      return winHelper.clickAndRestore(cx, cy, {
        button: parsed.flags['--button'],
        count: parsed.flags['--count'] ? Number(parsed.flags['--count']) : 1,
        restoreCursor: call.restoreCursor !== false,
        humanGuardMs: call.humanGuardMs ?? 120,
        settleMs: call.cursorRestoreSettleMs ?? 14,
        signal: call.signal,
        timeoutMs: call.timeoutMs,
      });
    }
    const nativeArgs = [...args];
    if (HEADED_COMMANDS.has(parsed.command)) nativeArgs.unshift('--headed');
    return execute(await binary(), config.binaryArgs, nativeArgs, executionOptions(call), parsed.mutating);
  }
  async function verifyCoordinateTarget(xy, call) {
    if (!call.windowId || !/^w-[A-Za-z0-9_-]+$/.test(call.windowId)) throw safeDesktopError('INVALID_ARGS', 'Coordinate input requires an explicit windowId');
    const list = await run(['list-windows'], { signal: call.signal, timeoutMs: call.timeoutMs });
    const windows = Array.isArray(list) ? list : list?.windows;
    const matching = windows?.filter(win => win.id === call.windowId) || [];
    const target = matching.length === 1 ? matching[0] : null;
    const [x, y] = xy.split(',').map(Number), bounds = target?.bounds;
    if (!target?.is_focused || !bounds || ![bounds.x, bounds.y, bounds.width, bounds.height, x, y].every(Number.isFinite)
      || x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) {
      throw safeDesktopError('DESKTOP_TARGET_UNVERIFIED', 'Coordinate target is not the focused window or the point is outside its bounds');
    }
  }
  function scope(args, app, call = {}) {
    if (app !== undefined) args.push(`--app=${text(app, 'App')}`);
    if (call.windowId !== undefined) args.push(`--window-id=${text(call.windowId, 'Window ID')}`);
    return args;
  }
  function option(args, call, key, flag) { if (call[key] !== undefined) args.push(`${flag}=${String(call[key])}`); }

  async function adBatch(steps, call = {}) {
    if (call.clickMode !== undefined && !['physical_restore', 'message'].includes(call.clickMode)) {
      throw desktopError('INVALID_ARGS', 'clickMode must be physical_restore or message');
    }
    const plan = normalizeBatchSteps(steps, config, call.windowId);
    const bin = await binary();
    if (config.expectedVersion && !checkedVersion) await version(call);
    const verifiedCoords = new Set();
    for (const check of plan.coordinateChecks) {
      const coordKey = `${check.windowId}::${check.xy}`;
      if (!verifiedCoords.has(coordKey)) {
        await verifyCoordinateTarget(check.xy, { ...call, windowId: check.windowId });
        verifiedCoords.add(coordKey);
      }
    }
    const timeoutMs = positiveInteger(call.timeoutMs ?? config.timeoutMs, 'timeoutMs');
    const nativeTimeoutMs = call.nativeTimeoutMs !== undefined
      ? positiveInteger(call.nativeTimeoutMs, 'nativeTimeoutMs')
      : (timeoutMs > 2500 ? timeoutMs - 1500 : Math.max(1, Math.floor(timeoutMs * 0.7)));
    const execTimeoutMs = call.nativeTimeoutMs !== undefined
      ? Math.max(timeoutMs, nativeTimeoutMs + 1500)
      : timeoutMs;
    const canBatchStdin = await supportsBatchStdin(bin, config.binaryArgs, executionOptions(call));

    const executeBatchPlan = async () => {
      if (canBatchStdin || !plan.hasText) {
        const payload = JSON.stringify(plan.items.map(it => ({ command: it.command, args: it.batchArgs })));
        const maxBytes = canBatchStdin ? 1024 * 1024 : 256 * 1024;
        if (Buffer.byteLength(payload, 'utf8') > maxBytes) throw desktopError('INVALID_ARGS', 'Desktop batch payload exceeds size limit');
        const nativeArgs = [
          ...(plan.anyHeaded ? ['--headed'] : []),
          'batch',
          ...(canBatchStdin ? ['--stdin'] : [payload]),
          '--stop-on-error',
          `--timeout-ms=${nativeTimeoutMs}`,
        ];
        const res = await execute(
          bin,
          config.binaryArgs,
          nativeArgs,
          executionOptions({ ...call, timeoutMs: execTimeoutMs, input: canBatchStdin ? payload : undefined }),
          plan.anyMutating,
        );
        sanitizeBatchResponse(res, plan.hasText);
        return { ...res, transport: canBatchStdin ? 'native-batch-stdin' : 'native-batch-arg' };
      }

      const startedAt = Date.now();
      const results = [];
      let completed = 0;
      let stopped = null;
      let idx = 0;
      while (idx < plan.items.length) {
        const item = plan.items[idx];
        if (!item.hasText) {
          let end = idx + 1;
          while (end < plan.items.length && !plan.items[end].hasText) end += 1;
          const segment = plan.items.slice(idx, end);
          const segPayload = JSON.stringify(segment.map(s => ({ command: s.command, args: s.batchArgs })));
          const segHeaded = segment.some(s => s.headed);
          const segMutating = segment.some(s => s.mutating);
          const segRes = await execute(
            bin,
            config.binaryArgs,
            [...(segHeaded ? ['--headed'] : []), 'batch', segPayload, '--stop-on-error', `--timeout-ms=${nativeTimeoutMs}`],
            executionOptions({ ...call, timeoutMs: execTimeoutMs, input: undefined }),
            segMutating,
          );
          sanitizeBatchResponse(segRes, plan.hasText);
          const segEntries = Array.isArray(segRes?.results) ? segRes.results : [];
          for (let k = 0; k < segEntries.length; k += 1) {
            const entry = { ...segEntries[k], index: idx + k };
            results.push(entry);
            if (entry.execution === 'completed') completed += 1;
            if (entry.ok === false) {
              stopped = { reason: 'stop_on_error', index: idx + k };
              break;
            }
          }
          if (stopped || segRes?.stopped) {
            stopped ||= { ...segRes.stopped, index: idx + (segRes.stopped.index ?? 0) };
            break;
          }
          idx = end;
        } else {
          const nativeArgs = [...(item.headed ? ['--headed'] : []), ...item.cliArgs];
          try {
            const data = await execute(
              bin,
              config.binaryArgs,
              nativeArgs,
              executionOptions({ ...call, timeoutMs, input: item.cliInput }),
              item.mutating,
            );
            if (data && typeof data === 'object') scrubSensitiveFields(data);
            results.push({ index: idx, command: item.command, execution: 'completed', ok: true, data });
            completed += 1;
          } catch (error) {
            const safeMsg = typeof error.message === 'string'
              ? redactQuotedStrings(error.message).replace(/--(?:image|file-url)=\S+/g, '--path=<redacted>')
              : 'Desktop command failed';
            results.push({
              index: idx,
              command: item.command,
              execution: 'completed',
              ok: false,
              error: {
                code: error.code || 'AGENT_DESKTOP_ERROR',
                message: safeMsg,
                disposition: error.disposition || { delivery: 'unknown', retry: 'unsafe' },
                ...(error.recovery ? { recovery: error.recovery } : {}),
              },
            });
            stopped = { reason: 'stop_on_error', index: idx };
            break;
          }
          idx += 1;
        }
      }
      return {
        results,
        total_entries: plan.items.length,
        completed_entries: completed,
        not_started_entries: Math.max(0, plan.items.length - completed),
        elapsed_ms: Date.now() - startedAt,
        ...(stopped ? { stopped } : {}),
        transport: 'hybrid-1.3.1',
      };
    };

    const useHooks = plan.coordinateChecks.length > 0 && shouldUseCursorHooks(call);
    const savedCursor = (useHooks && call.restoreCursor !== false)
      ? await winHelper.prepareCoordinateCursor({
        humanGuardMs: call.humanGuardMs ?? 120,
        signal: call.signal,
      }).catch(() => null)
      : null;
    if (useHooks && call.ripple !== false) {
      const clickItem = plan.items.find(it => it.command === 'mouse-click');
      if (clickItem?.batchArgs?.xy) {
        const [rx, ry] = String(clickItem.batchArgs.xy).split(',').map(Number);
        if (Number.isFinite(rx) && Number.isFinite(ry)) winHelper.spawnClickRipple(rx, ry);
      }
    }
    try {
      return await executeBatchPlan();
    } finally {
      if (savedCursor && !savedCursor.skipped && Number.isFinite(savedCursor.x) && Number.isFinite(savedCursor.y)) {
        await winHelper.restoreCursorPosition(savedCursor.x, savedCursor.y, call.cursorRestoreSettleMs ?? 12).catch(() => null);
      }
    }
  }

  function describeMissingWindow(app, appSpec, actionLabel) {
    if (process.platform === 'win32' && appSpec?.exeNames?.length && typeof winHelper.queryRunningProcessPathSync === 'function') {
      const proc = winHelper.queryRunningProcessPathSync(appSpec.exeNames);
      if (proc && (proc.count > 0 || proc.exePath)) {
        const appToken = app || appSpec.key || 'target';
        return `Target window for ${actionLabel} was not found (process is running in background/system tray; wake it first via "open-app --app ${appToken}" or "tray --click")`;
      }
    }
    return `Target window for ${actionLabel} was not found`;
  }

  async function adInspectCapabilities(app, call = {}) {
    const hasTitle = typeof call.titleIncludes === 'string' && call.titleIncludes.trim().length > 0;
    if (app === undefined && !call.windowId && !hasTitle) {
      throw safeDesktopError('INVALID_ARGS', 'Capability inspection requires an explicit app, windowId, or titleIncludes');
    }
    const appSpec = app !== undefined ? appRegistry.resolveAppSpec(app) : null;
    const matchCriteria = {
      windowId: call.windowId,
      titleIncludes: call.titleIncludes,
      preferMainWindow: !call.windowId && !hasTitle,
      enforceAppSpec: true,
    };
    let matched = [];
    if (appSpec?.knownPreset) {
      const allList = await client.adListWindows(undefined, { signal: call.signal, timeoutMs: call.timeoutMs });
      matched = appRegistry.matchWindowsList(allList, appSpec, matchCriteria);
    } else {
      const list = await client.adListWindows(app, { signal: call.signal, timeoutMs: call.timeoutMs });
      matched = appRegistry.matchWindowsList(list, appSpec, matchCriteria);
      if (matched.length === 0 && app !== undefined) {
        const allList = await client.adListWindows(undefined, { signal: call.signal, timeoutMs: call.timeoutMs });
        matched = appRegistry.matchWindowsList(allList, appSpec, matchCriteria);
      }
    }
    if (matched.length === 0) throw safeDesktopError('WINDOW_NOT_FOUND', describeMissingWindow(app, appSpec, 'desktop inspect'));
    let win = null;
    if (matched.length === 1) {
      win = matched[0];
    } else if (call.preferFocused) {
      win = matched[0];
    }
    if (!win) throw safeDesktopError('INVALID_ARGS', 'Multiple windows matched; pass an explicit windowId');
    const bounds = win.bounds || null;
    const minimized = Boolean(win.minimized || win.is_minimized || (bounds && (bounds.width <= 0 || bounds.height <= 0)));
    if (minimized) {
      return {
        window: win,
        windowId: win.id,
        minimized: true,
        isFocused: Boolean(win.is_focused),
        bounds,
        mode: 'minimized_unobservable',
        refCount: 0,
        clientInteractiveCount: 0,
        editableRefs: [],
        readOnlyEditableRefs: [],
        buttonRefs: [],
      };
    }
    const snapshotData = await client.adSnapshot(undefined, {
      signal: call.signal,
      timeoutMs: call.timeoutMs,
      nativeTimeoutMs: call.nativeTimeoutMs,
      windowId: win.id,
      interactiveOnly: true,
      compact: true,
    });
    const summary = summarizeSnapshotCapabilities(snapshotData);
    return {
      window: win,
      windowId: win.id,
      minimized: false,
      isFocused: Boolean(win.is_focused),
      bounds,
      snapshotId: snapshotData?.snapshot_id || null,
      ...summary,
      ...(call.includeSnapshot === false ? {} : { snapshot: snapshotData }),
    };
  }

  const client = {
    adPolicy: () => ({ mode: config.mode, readOnly: config.readOnly }),
    adRaw: (args, call = {}) => run(args, call),
    adBatch,
    adInspectCapabilities,
    adVersion: call => version(call),
    adStatus: call => run(['status'], call),
    adListDisplays: (call = {}) => run(['list-displays'], call),
    adListSurfaces: (app, call = {}) => run(scope(['list-surfaces'], app), call),
    adOpenSystemSurface: (surface, call = {}) => run(['open-system-surface', `--surface=${text(surface, 'Shell surface')}`], call),
    adRestoreWindow: (app, call = {}) => run(scope(['restore'], app, call), call),
    adMinimizeWindow: (app, call = {}) => run(scope(['minimize'], app, call), call),
    adMaximizeWindow: (app, call = {}) => run(scope(['maximize'], app, call), call),
    adResizeWindow(app, width, height, call = {}) {
      if (![width, height].every(Number.isFinite)) throw desktopError('INVALID_ARGS', 'Window width and height must be finite numbers');
      const args = scope(['resize-window'], app, call);
      args.push(`--width=${Math.round(width)}`, `--height=${Math.round(height)}`);
      return run(args, call);
    },
    adMoveWindow(app, x, y, call = {}) {
      if (![x, y].every(Number.isFinite)) throw desktopError('INVALID_ARGS', 'Window coordinates must be finite numbers');
      const args = scope(['move-window'], app, call);
      args.push(`--x=${Math.round(x)}`, `--y=${Math.round(y)}`);
      return run(args, call);
    },
    async adAvailable() { try { await version(); return true; } catch { return false; } },
    async adDiagnostics() {
      try {
        const result = await version();
        return { available: true, binaryPath: await binary(), version: result.version, expectedVersion: config.expectedVersion ?? null, mode: config.mode, readOnly: config.readOnly };
      } catch (error) {
        return { available: false, code: error.code, mode: config.mode, readOnly: config.readOnly, expectedVersion: config.expectedVersion ?? null };
      }
    },
    async adListApps(call = {}) { const data = await run(['list-apps'], call); return data.apps || data; },
    async adListWindows(app, call = {}) { const data = await run(scope(['list-windows'], app), call); return data.windows || data; },
    async adSnapshot(app, call = {}) {
      const args = scope(['snapshot'], app, call);
      for (const key of ['surface', 'root']) option(args, call, key, `--${key}`);
      if (call.skeleton) args.push('--skeleton');
      if (call.interactiveOnly !== false) args.push('-i');
      if (call.compact !== false) args.push('--compact');
      if (call.nativeTimeoutMs !== undefined) option(args, call, 'nativeTimeoutMs', '--timeout-ms');
      return run(args, call);
    },
    async adFind(app, call = {}) {
      const args = scope(['find'], app, call);
      for (const [key, flag] of [
        ['role', '--role'],
        ['name', '--name'],
        ['value', '--value'],
        ['text', '--text'],
        ['description', '--description'],
        ['nativeId', '--native-id'],
        ['surface', '--surface'],
        ['root', '--root'],
        ['nth', '--nth'],
        ['limit', '--limit'],
        ['nativeTimeoutMs', '--timeout-ms'],
      ]) option(args, call, key, flag);
      if (Array.isArray(call.states)) {
        for (const st of call.states) args.push(`--state=${String(st)}`);
      }
      if (call.exact) args.push('--exact');
      if (call.count) args.push('--count');
      if (call.first) args.push('--first');
      if (call.last) args.push('--last');
      return run(args, call);
    },
    async adGet(ref, property = 'text', call = {}) { const data = await run(['get', ref, `--property=${property}`], call); return data.value !== undefined ? data.value : data; },
    async adIs(ref, property = 'visible', call = {}) { const data = await run(['is', ref, `--property=${property}`], call); return data.value !== undefined ? data.value : data; },
    adClick: (ref, call = {}) => run(['click', ref], call),
    adDoubleClick: (ref, call = {}) => run(['double-click', ref], call),
    adRightClick: (ref, call = {}) => run(['right-click', ref], call),
    adClear: (ref, call = {}) => run(['clear', ref], call),
    adFocus: (ref, call = {}) => run(['focus', ref], call),
    async adSelect(ref, value, call = {}) {
      const optVal = text(String(value ?? ''), 'Option value');
      try {
        return await run(['select', ref, optVal], call);
      } catch (err) {
        if (err?.code === 'ACTION_NOT_SUPPORTED' && err?.disposition?.delivery === 'not_delivered') {
          const fb = await run(['set-value', ref, '--stdin'], { ...call, input: optVal });
          return (fb && typeof fb === 'object') ? { ...fb, fallback: 'set-value' } : fb;
        }
        throw err;
      }
    },
    adToggle: (ref, call = {}) => run(['toggle', ref], call),
    adCheck: (ref, call = {}) => run(['check', ref], call),
    adUncheck: (ref, call = {}) => run(['uncheck', ref], call),
    adExpand: (ref, call = {}) => run(['expand', ref], call),
    adCollapse: (ref, call = {}) => run(['collapse', ref], call),
    adScroll(ref, call = {}) {
      const args = ['scroll', ref];
      for (const key of ['direction', 'amount']) option(args, call, key, `--${key}`);
      return run(args, call);
    },
    adScrollTo: (ref, call = {}) => run(['scroll-to', ref], call),
    adHover(target, call = {}) {
      if (typeof target === 'string') return run(['hover', target], call);
      if (target && typeof target === 'object' && [target.x, target.y].every(Number.isFinite)) {
        return run(['hover', `--xy=${Math.round(target.x)},${Math.round(target.y)}`], call);
      }
      throw desktopError('INVALID_ARGS', 'adHover requires a qualified ref string or { x, y } coordinates');
    },
    adWait(spec, call = {}) {
      if (typeof spec === 'number') return run(['wait', String(Math.round(spec))], call);
      const opts = spec && typeof spec === 'object' ? spec : {};
      const args = ['wait'];
      if (opts.ms !== undefined) args.push(String(Math.round(opts.ms)));
      for (const [key, flag] of [
        ['element', '--element'],
        ['window', '--window'],
        ['text', '--text'],
        ['predicate', '--predicate'],
        ['value', '--value'],
        ['action', '--action'],
        ['count', '--count'],
        ['event', '--event'],
        ['windowId', '--window-id'],
        ['app', '--app'],
        ['timeout', '--timeout'],
      ]) option(args, opts, key, flag);
      if (opts.menu) args.push('--menu');
      if (opts.menuClosed) args.push('--menu-closed');
      if (opts.notification) args.push('--notification');
      return run(args, call);
    },
    async adType(ref, value, call = {}) {
      const args = ['type', ref, '--stdin'];
      option(args, call, 'intervalMs', '--interval-ms');
      return run(args, { ...call, input: String(value ?? '') });
    },
    adSetValue: (ref, value, call = {}) => run(['set-value', ref, '--stdin'], { ...call, input: String(value ?? '') }),
    adPress: (combo, call = {}) => run(scope(['press', combo], call.app, call), call),
    adFocusWindow(app, call = {}) {
      const args = scope(['focus-window'], app, call);
      option(args, call, 'title', '--title');
      return run(args, call);
    },
    async adLaunch(target, call = {}) {
      const args = ['launch', target];
      if (call.args !== undefined) {
        if (!Array.isArray(call.args)) throw desktopError('INVALID_ARGS', 'Launch args must be an array');
        for (const arg of call.args) args.push(`--arg=${text(arg, 'Launch argument')}`);
      }
      if (call.activate) args.push('--activate');
      option(args, call, 'timeout', '--timeout');
      return run(args, call);
    },
    adCloseApp: (app, call = {}) => run(['close-app', app], call),
    async adCursorOverlay(subcommand = 'enable', call = {}) {
      const sub = text(subcommand === undefined ? 'enable' : String(subcommand), 'Cursor overlay subcommand');
      const args = ['cursor-overlay', sub];
      for (const [key, flag] of [
        ['label', '--label'],
        ['maxWords', '--max-words'],
        ['fill', '--fill'],
        ['rim', '--rim'],
        ['accent', '--accent'],
        ['size', '--size'],
        ['image', '--image'],
        ['pointerImage', '--pointer-image'],
        ['travelMs', '--travel-ms'],
        ['dwellMs', '--dwell-ms'],
      ]) option(args, call, key, flag);
      if (call.noRipple) args.push('--no-ripple');
      if (call.noHighlight) args.push('--no-highlight');
      return run(args, call);
    },
    async adMouseClick(x, y, call = {}) {
      if (![x, y].every(Number.isFinite)) throw desktopError('INVALID_ARGS', 'Coordinates must be finite numbers');
      const args = ['mouse-click', `--xy=${Math.round(x)},${Math.round(y)}`];
      for (const key of ['button', 'count']) option(args, call, key, `--${key}`);
      return run(args, call);
    },
    async adMouseWheel(x, y, call = {}) {
      if (![x, y].every(Number.isFinite)) throw desktopError('INVALID_ARGS', 'Coordinates must be finite numbers');
      const args = ['mouse-wheel', `--x=${Math.round(x)}`, `--y=${Math.round(y)}`];
      for (const key of ['dy', 'dx']) option(args, call, key, `--${key}`);
      return run(args, call);
    },
    adClipboardSet: (value, call = {}) => run(['clipboard-set', '--stdin'], { ...call, input: String(value ?? '') }),
    adClipboardSetImage: (imagePath, call = {}) => {
      if (typeof imagePath !== 'string' || !path.isAbsolute(imagePath)) {
        throw desktopError('INVALID_ARGS', 'adClipboardSetImage requires an absolute PNG path');
      }
      return run(['clipboard-set', `--image=${imagePath}`], call);
    },
    adClipboardSetFiles: (filePaths, call = {}) => {
      const list = Array.isArray(filePaths) ? filePaths : [filePaths];
      if (!list.length || list.some(p => typeof p !== 'string' || !path.isAbsolute(p))) {
        throw desktopError('INVALID_ARGS', 'adClipboardSetFiles requires one or more absolute file paths');
      }
      return run(['clipboard-set', ...list.map(p => `--file-url=${p}`)], call);
    },
    adClipboardClear: (call = {}) => run(['clipboard-clear'], call),
    async adClipboardGet(call = {}) {
      const args = ['clipboard-get'];
      for (const key of ['format', 'out']) option(args, call, key, `--${key}`);
      const data = await run(args, call);
      return data.text !== undefined ? data.text : data;
    },
    async adScreenshot(app, outputPath, call = {}) {
      const args = scope(['screenshot'], app, call);
      option(args, call, 'screen', '--screen');
      if (outputPath !== undefined) {
        if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) throw desktopError('INVALID_ARGS', 'Screenshot output must be an absolute path');
        args.push(outputPath);
      }
      return run(args, call);
    },
    async adOcrWindow(app, call = {}) {
      let targetWin = null;
      if (call.windowId || app || call.titleIncludes) {
        const found = await appRegistry.findMatchingWindows(client, app, {
          windowId: call.windowId,
          titleIncludes: call.titleIncludes,
          preferMainWindow: !call.windowId && !call.titleIncludes,
          signal: call.signal,
          timeoutMs: call.timeoutMs,
        });
        if (!found.windows.length) throw safeDesktopError('WINDOW_NOT_FOUND', describeMissingWindow(app, found.appSpec, 'OCR'));
        targetWin = found.windows[0];
      } else {
        throw safeDesktopError('INVALID_ARGS', 'desktop ocr requires --app, --window-id, or --title-includes');
      }
      if (appRegistry.isWindowMinimized(targetWin)) {
        throw safeDesktopError('DESKTOP_WINDOW_MINIMIZED', 'Cannot OCR a minimized window; run open-app or ensure-ready to restore it first');
      }
      const keepShot = typeof call.outputPath === 'string' && path.isAbsolute(call.outputPath);
      const tempDir = keepShot ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'abb-ocr-win-'));
      const shotPath = keepShot ? call.outputPath : path.join(tempDir, 'window.png');
      try {
        if (keepShot) {
          await client.adScreenshot(undefined, shotPath, {
            windowId: targetWin.id,
            signal: call.signal,
            timeoutMs: call.timeoutMs,
          });
        } else {
          const rawShot = await client.adScreenshot(undefined, undefined, {
            windowId: targetWin.id,
            signal: call.signal,
            timeoutMs: call.timeoutMs,
          });
          if (typeof rawShot?.data === 'string' && rawShot.data.length > 0) {
            fs.writeFileSync(shotPath, Buffer.from(rawShot.data, 'base64'));
          } else if (!config.readOnly) {
            await client.adScreenshot(undefined, shotPath, {
              windowId: targetWin.id,
              signal: call.signal,
              timeoutMs: call.timeoutMs,
            });
          } else {
            throw desktopError('AGENT_DESKTOP_PROTOCOL_ERROR', 'Desktop screenshot response did not return base64 image data');
          }
        }
        const ocr = await winHelper.ocrImage(shotPath, {
          region: call.region,
          find: call.find,
          scale: call.scale,
          lang: call.lang,
          bounds: targetWin.bounds || null,
          includeWords: Boolean(call.includeWords),
          includeLines: call.includeLines,
          maxLines: call.maxLines,
          signal: call.signal,
          timeoutMs: call.timeoutMs,
        });
        return {
          ...(call.compactWindow ? {} : { window: targetWin }),
          windowId: targetWin.id,
          bounds: targetWin.bounds || null,
          ...(keepShot ? { screenshotPath: shotPath } : {}),
          ...ocr,
        };
      } finally {
        if (tempDir) {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }
      }
    },
  };
  return Object.freeze(client);
}

module.exports = { createDesktopClient, summarizeSnapshotCapabilities, ...createDesktopClient() };
