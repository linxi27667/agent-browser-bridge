const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { desktopError, positiveInteger, resolveBinary, supportsBatchStdin, execute } = require('./agentDesktopProcess');
const { validateCommand, normalizeBatchSteps, text } = require('./agentDesktopPolicy');
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
  return typeof msg === 'string' ? msg.replace(/"(?:\\.|[^"\\])*"/g, '"<redacted>"') : msg;
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
  async function run(args, call = {}) {
    const parsed = validateCommand(args, call.input, config);
    args = [...args];
    if (parsed.command === 'version') return version(call);
    if (config.expectedVersion && !checkedVersion) await version(call);
    if (parsed.command === 'mouse-click') await verifyCoordinateTarget(parsed.flags['--xy'], call);
    const nativeArgs = [...args];
    if (['type', 'press', 'mouse-click', 'open-system-surface'].includes(parsed.command)) nativeArgs.unshift('--headed');
    return execute(await binary(), config.binaryArgs, nativeArgs, executionOptions(call), parsed.mutating);
  }
  async function verifyCoordinateTarget(xy, call) {
    if (!call.windowId || !/^w-[A-Za-z0-9_-]+$/.test(call.windowId)) throw desktopError('INVALID_ARGS', 'Coordinate input requires an explicit windowId');
    const list = await run(['list-windows'], { signal: call.signal, timeoutMs: call.timeoutMs });
    const windows = Array.isArray(list) ? list : list?.windows;
    const matching = windows?.filter(win => win.id === call.windowId) || [];
    const target = matching.length === 1 ? matching[0] : null;
    const [x, y] = xy.split(',').map(Number), bounds = target?.bounds;
    if (!target?.is_focused || !bounds || ![bounds.x, bounds.y, bounds.width, bounds.height, x, y].every(Number.isFinite)
      || x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) {
      throw desktopError('DESKTOP_TARGET_UNVERIFIED', 'Coordinate target is not the focused window or the point is outside its bounds');
    }
  }
  function scope(args, app, call = {}) {
    if (app !== undefined) args.push(`--app=${text(app, 'App')}`);
    if (call.windowId !== undefined) args.push(`--window-id=${text(call.windowId, 'Window ID')}`);
    return args;
  }
  function option(args, call, key, flag) { if (call[key] !== undefined) args.push(`${flag}=${String(call[key])}`); }

  async function adBatch(steps, call = {}) {
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
            ? error.message.replace(/"(?:\\.|[^"\\])*"/g, '"[redacted]"').replace(/--(?:image|file-url)=\S+/g, '--path=[redacted]')
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
  }

  async function adInspectCapabilities(app, call = {}) {
    const hasTitle = typeof call.titleIncludes === 'string' && call.titleIncludes.trim().length > 0;
    if (app === undefined && !call.windowId && !hasTitle) {
      throw desktopError('INVALID_ARGS', 'Capability inspection requires an explicit app, windowId, or titleIncludes');
    }
    const list = await client.adListWindows(app, { signal: call.signal, timeoutMs: call.timeoutMs });
    const windows = Array.isArray(list) ? list : (list?.windows || []);
    let matched = windows;
    if (call.windowId) matched = matched.filter(w => w.id === call.windowId);
    if (call.titleIncludes) matched = matched.filter(w => String(w.title || '').includes(call.titleIncludes));
    if (matched.length === 0 && app !== undefined && !call.windowId) {
      const appSpec = appRegistry.resolveAppSpec(app);
      if (appSpec.knownPreset) {
        const allList = await client.adListWindows(undefined, { signal: call.signal, timeoutMs: call.timeoutMs });
        matched = appRegistry.matchWindowsList(allList, appSpec, { titleIncludes: call.titleIncludes });
      }
    }
    if (matched.length === 0) throw desktopError('WINDOW_NOT_FOUND', 'Target window was not found');
    let win = null;
    if (matched.length === 1) {
      win = matched[0];
    } else if (call.preferFocused) {
      const sorted = appRegistry.matchWindowsList(matched, app ? appRegistry.resolveAppSpec(app) : null, {});
      win = sorted[0] || matched[0];
    }
    if (!win) throw desktopError('INVALID_ARGS', 'Multiple windows matched; pass an explicit windowId');
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
      snapshot: snapshotData,
    };
  }

  const client = {
    adPolicy: () => ({ mode: config.mode, readOnly: config.readOnly }),
    adRaw: (args, call = {}) => run(args, call),
    adBatch,
    adInspectCapabilities,
    adVersion: call => version(call),
    adStatus: call => run(['status'], call),
    adOpenSystemSurface: (surface, call = {}) => run(['open-system-surface', `--surface=${text(surface, 'Shell surface')}`], call),
    adRestoreWindow: (app, call = {}) => run(scope(['restore'], app, call), call),
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
      for (const key of ['role', 'name', 'root']) option(args, call, key, `--${key}`);
      return run(args, call);
    },
    async adGet(ref, property = 'text', call = {}) { const data = await run(['get', ref, `--property=${property}`], call); return data.value !== undefined ? data.value : data; },
    adClick: (ref, call = {}) => run(['click', ref], call),
    async adType(ref, value, call = {}) {
      const args = ['type', ref, '--stdin'];
      option(args, call, 'intervalMs', '--interval-ms');
      return run(args, { ...call, input: String(value ?? '') });
    },
    adSetValue: (ref, value, call = {}) => run(['set-value', ref, '--stdin'], { ...call, input: String(value ?? '') }),
    adPress: (combo, call = {}) => run(scope(['press', combo], call.app, call), call),
    adFocusWindow: (app, call = {}) => run(scope(['focus-window'], app, call), call),
    async adLaunch(target, call = {}) {
      const args = ['launch', target];
      if (call.args !== undefined) {
        if (!Array.isArray(call.args)) throw desktopError('INVALID_ARGS', 'Launch args must be an array');
        for (const arg of call.args) args.push(`--arg=${text(arg, 'Launch argument')}`);
      }
      return run(args, call);
    },
    adCloseApp: (app, call = {}) => run(['close-app', app], call),
    async adMouseClick(x, y, call = {}) {
      if (![x, y].every(Number.isFinite)) throw desktopError('INVALID_ARGS', 'Coordinates must be finite numbers');
      const args = ['mouse-click', `--xy=${Math.round(x)},${Math.round(y)}`];
      for (const key of ['button', 'count']) option(args, call, key, `--${key}`);
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
    async adClipboardGet(call = {}) { const data = await run(['clipboard-get'], call); return data.text !== undefined ? data.text : data; },
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
          signal: call.signal,
          timeoutMs: call.timeoutMs,
        });
        if (!found.windows.length) throw desktopError('WINDOW_NOT_FOUND', 'Target window for OCR was not found');
        targetWin = found.windows[0];
      } else {
        throw desktopError('INVALID_ARGS', 'adOcrWindow requires app, windowId, or titleIncludes');
      }
      if (appRegistry.isWindowMinimized(targetWin)) {
        throw desktopError('DESKTOP_WINDOW_MINIMIZED', 'Cannot OCR a minimized window; restore it first');
      }
      const keepShot = typeof call.outputPath === 'string' && path.isAbsolute(call.outputPath);
      const tempDir = keepShot ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'abb-ocr-win-'));
      const shotPath = keepShot ? call.outputPath : path.join(tempDir, 'window.png');
      try {
        await client.adScreenshot(undefined, shotPath, {
          windowId: targetWin.id,
          signal: call.signal,
          timeoutMs: call.timeoutMs,
        });
        const ocr = await winHelper.ocrImage(shotPath, {
          region: call.region,
          find: call.find,
          scale: call.scale,
          lang: call.lang,
          bounds: targetWin.bounds || null,
          signal: call.signal,
          timeoutMs: call.timeoutMs,
        });
        return {
          window: targetWin,
          windowId: targetWin.id,
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
