const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const pkg = require('../../package.json');

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_HTTP_PORT = 19235;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LIB_ROOT = path.resolve(__dirname, '..');

const WATCHED_DIRS = [
  path.resolve(__dirname),
  path.resolve(__dirname, 'scenes'),
  path.resolve(LIB_ROOT, 'desktop'),
  path.resolve(LIB_ROOT, 'cdp'),
];

function scanWatchedMaxMtimeMs() {
  let maxMtime = 0;
  for (const dir of WATCHED_DIRS) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.js')) continue;
      try {
        const st = fs.statSync(path.join(dir, ent.name));
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
      } catch {}
    }
  }
  return maxMtime;
}

const mcpRuntime = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  reloadCount: 0,
  lastReloadAt: null,
};
let lastWatchedMtimeMs = scanWatchedMaxMtimeMs();
let lastMtimeCheckAt = Date.now();
let activeDispatchCalls = 0;

function reloadModulesIfChanged({ force = false } = {}) {
  if (activeDispatchCalls > 0) return false;
  const now = Date.now();
  if (!force && now - lastMtimeCheckAt < 250) return false;
  lastMtimeCheckAt = now;
  const latest = scanWatchedMaxMtimeMs();
  if (latest <= lastWatchedMtimeMs) return false;
  lastWatchedMtimeMs = latest;
  for (const cacheKey of Object.keys(require.cache)) {
    if (cacheKey === __filename) continue;
    if (cacheKey.startsWith(LIB_ROOT + path.sep)) {
      delete require.cache[cacheKey];
    }
  }
  mcpRuntime.reloadCount += 1;
  mcpRuntime.lastReloadAt = new Date().toISOString();
  return true;
}

function getDeps() {
  const automationMod = require('./index');
  const errorsMod = require('./errors');
  const appRegistry = require('../desktop/appRegistry');
  const policyMod = require('../desktop/agentDesktopPolicy');
  return {
    createAutomation: automationMod.createAutomation,
    doctor: automationMod.doctor,
    exclusiveLock: automationMod.exclusiveLock,
    loadLocalConfig: automationMod.loadLocalConfig,
    fail: errorsMod.fail,
    normalizeOptions: errorsMod.normalizeOptions,
    serializeError: errorsMod.serializeError,
    appRegistry,
    policyMod,
  };
}

function readJsonArg(args, key) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return args[key];
}

function buildServerOptions(baseOptions = {}, overrides = {}, signal) {
  const { loadLocalConfig, normalizeOptions } = getDeps();
  const loaded = loadLocalConfig({
    ...baseOptions,
    ...overrides,
  });
  return normalizeOptions({
    ...loaded.options,
    configInfo: loaded.config,
    signal,
  });
}

function enforceWriteMode(options, actionName, { requireExclusive = false } = {}) {
  const { fail } = getDeps();
  if (options.readOnly) {
    throw fail('READ_ONLY_BLOCKED', `${actionName} requires server --write authorization`);
  }
  if (requireExclusive && options.mode !== 'exclusive') {
    throw fail('DESKTOP_FOREGROUND_REQUIRED', `${actionName} requires exclusive mode`);
  }
}

function capSnapshotNodes(snapshotData, maxNodes) {
  if (!snapshotData?.tree || !Number.isInteger(maxNodes) || maxNodes < 1) return snapshotData;
  let seen = 0;
  let truncatedNodes = 0;
  function cloneLimited(node) {
    if (!node || typeof node !== 'object') return node;
    seen += 1;
    const copy = { ...node };
    if (Array.isArray(node.children) && node.children.length > 0) {
      const kept = [];
      for (const child of node.children) {
        if (seen < maxNodes) kept.push(cloneLimited(child));
        else truncatedNodes += 1;
      }
      if (kept.length > 0) copy.children = kept;
      else delete copy.children;
    }
    return copy;
  }
  const tree = cloneLimited(snapshotData.tree);
  return {
    ...snapshotData,
    tree,
    ...(truncatedNodes > 0 ? { truncatedNodes } : {}),
  };
}

function buildToolDefinitions() {
  return [
    {
      name: 'desktop_doctor',
      description: 'Inspect Windows desktop session (isInteractiveDefaultDesktop, threadDesktop), OCR readiness, agent-desktop status, and browser bridge readiness.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { doctor } = getDeps();
        const opts = buildServerOptions(baseOptions, { timeoutMs: readJsonArg(args, 'timeoutMs') }, signal);
        const report = await doctor(opts);
        return { ...report, mcpRuntime: { ...mcpRuntime } };
      },
    },
    {
      name: 'desktop_apps',
      description: 'Discover supported Windows desktop app aliases (wecom, wechat, qq, feishu, dingtalk, notepad, explorer, calc, mspaint) and running apps.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string', description: 'Optional app alias or process name to resolve.' },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { createAutomation, exclusiveLock, appRegistry } = getDeps();
        const opts = buildServerOptions(baseOptions, { timeoutMs: readJsonArg(args, 'timeoutMs') }, signal);
        return exclusiveLock(opts, async (_assertHeld, leaseSignal) => {
          const desktop = createAutomation({ ...opts, signal: leaseSignal }).desktop;
          const running = await desktop.adListApps().catch(() => []);
          const appName = readJsonArg(args, 'app');
          const known = appName ? [appRegistry.resolveAppSpec(appName)] : appRegistry.listKnownApps();
          return { knownApps: known, runningApps: running };
        });
      },
    },
    {
      name: 'desktop_windows',
      description: 'List visible desktop windows, optionally filtered by app alias/process, windowId, or title substring.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string' },
          exePath: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { createAutomation, exclusiveLock, appRegistry } = getDeps();
        const opts = buildServerOptions(baseOptions, {
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        return exclusiveLock(opts, async (_assertHeld, leaseSignal) => {
          const desktop = createAutomation({ ...opts, signal: leaseSignal }).desktop;
          const found = await appRegistry.findMatchingWindows(desktop, readJsonArg(args, 'app'), {
            windowId: opts.windowId,
            titleIncludes: readJsonArg(args, 'titleIncludes'),
            exePath: readJsonArg(args, 'exePath'),
            signal: leaseSignal,
            timeoutMs: opts.timeoutMs,
          });
          return { count: found.windows.length, windows: found.windows };
        });
      },
    },
    {
      name: 'desktop_capabilities',
      description: 'Inspect window accessibility capabilities (uia_semantic vs custom_ui_visual) and separate writable vs read-only edit boxes (compact summary by default; pass includeSnapshot:true for raw UIA tree).',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          preferFocused: { type: 'boolean' },
          includeSnapshot: { type: 'boolean', default: false },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { createAutomation, exclusiveLock } = getDeps();
        const opts = buildServerOptions(baseOptions, {
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        return exclusiveLock(opts, (_assertHeld, leaseSignal) => (
          createAutomation({ ...opts, signal: leaseSignal }).desktop.adInspectCapabilities(
            readJsonArg(args, 'app'),
            {
              windowId: opts.windowId,
              titleIncludes: readJsonArg(args, 'titleIncludes'),
              preferFocused: Boolean(readJsonArg(args, 'preferFocused')),
              includeSnapshot: Boolean(readJsonArg(args, 'includeSnapshot')),
            },
          )
        ));
      },
    },
    {
      name: 'desktop_snapshot',
      description: 'Capture a compact UIA accessibility tree snapshot (@snapshot:eN refs) for standard uia_semantic desktop apps without stealing focus.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string' },
          windowId: { type: 'string' },
          surface: { type: 'string', description: 'window | focused | menu | menubar | sheet | popover | alert | taskbar | system-tray | start-menu | action-center' },
          root: { type: 'string', description: 'Optional @snapshot:eN subtree root ref.' },
          interactiveOnly: { type: 'boolean', default: true },
          compact: { type: 'boolean', default: true },
          skeleton: { type: 'boolean', default: false },
          maxNodes: { type: 'integer', minimum: 10, maximum: 5000, default: 250 },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { createAutomation, exclusiveLock } = getDeps();
        const opts = buildServerOptions(baseOptions, {
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        const maxNodes = readJsonArg(args, 'maxNodes') ?? 250;
        return exclusiveLock(opts, async (_assertHeld, leaseSignal) => {
          const snap = await createAutomation({ ...opts, signal: leaseSignal }).desktop.adSnapshot(
            readJsonArg(args, 'app'),
            {
              windowId: opts.windowId,
              surface: readJsonArg(args, 'surface'),
              root: readJsonArg(args, 'root'),
              interactiveOnly: readJsonArg(args, 'interactiveOnly') !== false,
              compact: readJsonArg(args, 'compact') !== false,
              skeleton: Boolean(readJsonArg(args, 'skeleton')),
              signal: leaseSignal,
              timeoutMs: opts.timeoutMs,
            },
          );
          return capSnapshotNodes(snap, maxNodes);
        });
      },
    },
    {
      name: 'desktop_query',
      description: 'Run read-only UIA or tray queries: find controls (role/name/text/value/states), get control property, check boolean state (is), list displays, list surfaces, or list system tray icons ("tray").',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['find', 'get', 'is', 'displays', 'surfaces', 'tray'] },
          app: { type: 'string' },
          windowId: { type: 'string' },
          ref: { type: 'string', description: 'Snapshot-qualified ref (@snapshot:eN) for get/is.' },
          property: { type: 'string', description: 'For get: text|value|title|bounds|role|states; for is: visible|enabled|checked|focused|expanded|selected.' },
          role: { type: 'string' },
          name: { type: 'string' },
          value: { type: 'string' },
          text: { type: 'string' },
          description: { type: 'string' },
          nativeId: { type: 'string' },
          find: { type: 'string', description: 'Optional tray icon name filter when action is "tray".' },
          openOverflow: { type: 'boolean', default: false, description: 'When action is "tray", temporarily expand taskbar hidden icons panel (requires --write exclusive).' },
          exact: { type: 'boolean' },
          surface: { type: 'string' },
          states: { type: 'array', items: { type: 'string' } },
          root: { type: 'string' },
          count: { type: 'boolean' },
          first: { type: 'boolean' },
          last: { type: 'boolean' },
          nth: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { createAutomation, exclusiveLock, fail } = getDeps();
        const action = readJsonArg(args, 'action');
        if (action === 'tray') {
          const openOverflow = Boolean(readJsonArg(args, 'openOverflow'));
          const opts = buildServerOptions(baseOptions, {
            ...(openOverflow ? { mode: 'exclusive' } : {}),
            timeoutMs: readJsonArg(args, 'timeoutMs'),
          }, signal);
          if (openOverflow) {
            enforceWriteMode(opts, 'desktop_query:tray-overflow', { requireExclusive: true });
          }
          const winHelper = require('../desktop/winHelper');
          return exclusiveLock(opts, (_assertHeld, leaseSignal) => winHelper.listSystemTrayIcons({
            find: readJsonArg(args, 'find'),
            openOverflow,
            closeAfter: true,
            signal: leaseSignal,
            timeoutMs: opts.timeoutMs,
          }));
        }
        const opts = buildServerOptions(baseOptions, {
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        return exclusiveLock(opts, async (_assertHeld, leaseSignal) => {
          const desktop = createAutomation({ ...opts, signal: leaseSignal }).desktop;
          if (action === 'displays') {
            return desktop.adListDisplays({ signal: leaseSignal, timeoutMs: opts.timeoutMs });
          }
          if (action === 'surfaces') {
            return desktop.adListSurfaces(readJsonArg(args, 'app'), { signal: leaseSignal, timeoutMs: opts.timeoutMs });
          }
          if (action === 'get') {
            const ref = readJsonArg(args, 'ref');
            const property = readJsonArg(args, 'property') || 'text';
            const value = await desktop.adGet(ref, property, { signal: leaseSignal, timeoutMs: opts.timeoutMs });
            return { ref, property, value };
          }
          if (action === 'is') {
            const ref = readJsonArg(args, 'ref');
            const property = readJsonArg(args, 'property') || 'visible';
            const value = await desktop.adIs(ref, property, { signal: leaseSignal, timeoutMs: opts.timeoutMs });
            return { ref, property, value };
          }
          if (action === 'find') {
            return desktop.adFind(readJsonArg(args, 'app'), {
              windowId: opts.windowId,
              role: readJsonArg(args, 'role'),
              name: readJsonArg(args, 'name'),
              value: readJsonArg(args, 'value'),
              text: readJsonArg(args, 'text'),
              description: readJsonArg(args, 'description'),
              nativeId: readJsonArg(args, 'nativeId'),
              exact: Boolean(readJsonArg(args, 'exact')),
              surface: readJsonArg(args, 'surface'),
              states: readJsonArg(args, 'states'),
              root: readJsonArg(args, 'root'),
              count: Boolean(readJsonArg(args, 'count')),
              first: Boolean(readJsonArg(args, 'first')),
              last: Boolean(readJsonArg(args, 'last')),
              nth: readJsonArg(args, 'nth'),
              limit: readJsonArg(args, 'limit'),
              signal: leaseSignal,
              timeoutMs: opts.timeoutMs,
            });
          }
          throw fail('INVALID_ARGS', `Unsupported desktop_query action "${String(action)}"`);
        });
      },
    },
    {
      name: 'desktop_act',
      description: 'Execute a single UIA/window/tray command or a sequential stop-on-error steps[] batch (non-atomic; launch, close-app, cursor-overlay, and wake-tray are single-command only). Supports click, set-value, clear, focus, select, toggle, check, uncheck, expand, collapse, scroll, scroll-to, double-click, right-click, hover, type, press, mouse-click, mouse-wheel, focus-window, resize-window, move-window, minimize, maximize, restore, launch, close-app, cursor-overlay, wake-tray, wait, get, is. Automatically uses cooperative mode for background semantic UIA and exclusive mode for foreground/input actions.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', description: 'Single command when not passing steps[].' },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: { type: 'object' },
            description: 'Sequential stop-on-error multi-step batch executed in a single agent-desktop process (non-atomic).',
          },
          mode: { type: 'string', enum: ['cooperative', 'exclusive'] },
          windowId: { type: 'string' },
          app: { type: 'string' },
          name: { type: 'string', description: 'Tray icon keyword for wake-tray.' },
          doubleClick: { type: 'boolean', default: false },
          target: { type: 'string', description: 'Executable path for launch, or app name for close-app.' },
          launchArgs: { type: 'array', items: { type: 'string' } },
          activate: { type: 'boolean' },
          ref: { type: 'string' },
          value: { type: 'string' },
          text: { type: 'string' },
          intervalMs: { type: 'integer', minimum: 1, maximum: 2000 },
          combo: { type: 'string' },
          property: { type: 'string' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'integer', minimum: 1, maximum: 100 },
          title: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          xy: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          dy: { type: 'number' },
          dx: { type: 'number' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          count: { type: 'integer', minimum: 1 },
          ms: { type: 'integer', minimum: 1, maximum: 30000 },
          element: { type: 'string' },
          window: { type: 'string' },
          predicate: { type: 'string' },
          action: { type: 'string' },
          event: { type: 'string' },
          menu: { type: 'boolean' },
          menuClosed: { type: 'boolean' },
          notification: { type: 'boolean' },
          timeout: { type: 'integer', minimum: 1, maximum: 300000 },
          surface: { type: 'string' },
          label: { type: 'string' },
          accent: { type: 'string' },
          size: { type: 'number', minimum: 0.5, maximum: 4.0 },
          noRipple: { type: 'boolean' },
          noHighlight: { type: 'boolean' },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 180000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { createAutomation, exclusiveLock, fail, policyMod } = getDeps();
        const singleCmd = readJsonArg(args, 'command');
        const rawStepsArg = readJsonArg(args, 'steps');
        if (singleCmd && rawStepsArg) {
          throw fail('INVALID_ARGS', 'Pass either command or steps[], not both');
        }
        if (singleCmd === 'wake-tray') {
          const opts = buildServerOptions(baseOptions, {
            mode: 'exclusive',
            timeoutMs: readJsonArg(args, 'timeoutMs'),
          }, signal);
          enforceWriteMode(opts, 'desktop_act:wake-tray', { requireExclusive: true });
          const { appRegistry } = getDeps();
          const winHelper = require('../desktop/winHelper');
          const appName = readJsonArg(args, 'app');
          const explicitName = readJsonArg(args, 'name');
          const spec = appName ? appRegistry.resolveAppSpec(appName) : null;
          const keywords = explicitName
            ? [String(explicitName)]
            : (spec?.trayKeywords?.length ? spec.trayKeywords : (appName ? [String(appName)] : []));
          if (!keywords.length) {
            throw fail('INVALID_ARGS', 'wake-tray requires app or name');
          }
          return exclusiveLock(opts, (_assertHeld, leaseSignal) => winHelper.activateSystemTrayIcon({
            keywords,
            excludeKeywords: spec?.trayExcludeKeywords || [],
            doubleClick: Boolean(readJsonArg(args, 'doubleClick')),
            signal: leaseSignal,
            timeoutMs: opts.timeoutMs,
          }));
        }
        if (singleCmd === 'cursor-overlay') {
          const rawAction = readJsonArg(args, 'action');
          const sub = rawAction === undefined ? 'enable' : String(rawAction).trim().toLowerCase();
          const opts = buildServerOptions(baseOptions, {
            mode: baseOptions.mode || 'cooperative',
            timeoutMs: readJsonArg(args, 'timeoutMs'),
          }, signal);
          enforceWriteMode(opts, 'desktop_act:cursor-overlay', { requireExclusive: false });
          return exclusiveLock(opts, (_assertHeld, leaseSignal) => (
            createAutomation({ ...opts, signal: leaseSignal }).desktop.adCursorOverlay(sub, {
              label: readJsonArg(args, 'label'),
              accent: readJsonArg(args, 'accent'),
              size: readJsonArg(args, 'size'),
              noRipple: Boolean(readJsonArg(args, 'noRipple')),
              noHighlight: Boolean(readJsonArg(args, 'noHighlight')),
              signal: leaseSignal,
              timeoutMs: opts.timeoutMs,
            })
          ));
        }
        if (singleCmd === 'launch' || singleCmd === 'close-app') {
          const opts = buildServerOptions(baseOptions, {
            mode: 'exclusive',
            windowId: readJsonArg(args, 'windowId'),
            timeoutMs: readJsonArg(args, 'timeoutMs'),
          }, signal);
          enforceWriteMode(opts, `desktop_act:${singleCmd}`, { requireExclusive: true });
          return exclusiveLock(opts, (_assertHeld, leaseSignal) => {
            const desktop = createAutomation({ ...opts, signal: leaseSignal }).desktop;
            if (singleCmd === 'launch') {
              const target = readJsonArg(args, 'target') || readJsonArg(args, 'app');
              return desktop.adLaunch(target, {
                args: readJsonArg(args, 'launchArgs'),
                activate: Boolean(readJsonArg(args, 'activate')),
                signal: leaseSignal,
                timeoutMs: opts.timeoutMs,
              });
            }
            const targetApp = readJsonArg(args, 'app') || readJsonArg(args, 'target');
            return desktop.adCloseApp(targetApp, { signal: leaseSignal, timeoutMs: opts.timeoutMs });
          });
        }

        let steps = rawStepsArg;
        if (!steps) {
          if (!singleCmd) throw fail('INVALID_ARGS', 'desktop_act requires either command or steps[]');
          const singleStep = {};
          for (const [k, v] of Object.entries(args || {})) {
            if (v === undefined || ['steps', 'mode', 'timeoutMs', 'target', 'launchArgs', 'activate'].includes(k)) continue;
            singleStep[k] = v;
          }
          steps = [singleStep];
        }
        if (!Array.isArray(steps) || steps.length === 0) {
          throw fail('INVALID_ARGS', 'desktop_act steps must be a non-empty array');
        }
        const needsExclusive = steps.some(s => s && typeof s === 'object' && policyMod.FOREGROUND.has(s.command));
        const requestedMode = readJsonArg(args, 'mode');
        if (needsExclusive && requestedMode === 'cooperative') {
          throw fail('DESKTOP_FOREGROUND_REQUIRED', 'Foreground/input step in desktop_act requires exclusive mode');
        }
        const effectiveMode = requestedMode || (needsExclusive ? 'exclusive' : (baseOptions.mode || 'cooperative'));
        const opts = buildServerOptions(baseOptions, {
          mode: effectiveMode,
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        const anyMutating = steps.some(s => s && typeof s === 'object' && !policyMod.READS.has(s.command));
        if (anyMutating) {
          enforceWriteMode(opts, 'desktop_act', { requireExclusive: needsExclusive });
        }

        return exclusiveLock(opts, async (_assertHeld, leaseSignal) => {
          const desktop = createAutomation({ ...opts, signal: leaseSignal }).desktop;
          const batchRes = await desktop.adBatch(steps, {
            windowId: opts.windowId,
            signal: leaseSignal,
            timeoutMs: opts.timeoutMs,
          });
          const entries = Array.isArray(batchRes?.results) ? batchRes.results : [];
          const failedIdx = entries.findIndex(e => e && e.ok === false);
          if (failedIdx >= 0) {
            const failedEntry = entries[failedIdx];
            if (
              steps.length === 1
              && steps[0]?.command === 'select'
              && failedIdx === 0
              && failedEntry?.error?.code === 'ACTION_NOT_SUPPORTED'
              && failedEntry?.error?.disposition?.delivery === 'not_delivered'
            ) {
              const fb = await desktop.adSetValue(
                steps[0].ref ?? steps[0].refId,
                steps[0].value,
                { signal: leaseSignal, timeoutMs: opts.timeoutMs },
              );
              return {
                results: [{
                  index: 0,
                  command: 'select',
                  fallback: 'set-value',
                  execution: 'completed',
                  ok: true,
                  data: fb,
                }],
                total_entries: 1,
                completed_entries: 1,
                not_started_entries: 0,
                mode: effectiveMode,
                transport: 'fallback-set-value',
              };
            }
            const priorMutated = steps.slice(0, failedIdx).some(s => s && !policyMod.READS.has(s.command));
            const disposition = priorMutated
              ? { delivery: 'unknown', retry: 'unsafe' }
              : (failedEntry?.error?.disposition || { delivery: 'not_delivered', retry: 'safe' });
            const err = fail(
              failedEntry?.error?.code || 'DESKTOP_BATCH_STEP_FAILED',
              failedEntry?.error?.message || `Desktop batch stopped at step ${failedIdx} (${failedEntry?.command || 'unknown'})`,
              disposition,
            );
            err.details = {
              failedStepIndex: failedIdx,
              failedCommand: failedEntry?.command || null,
              completedEntries: batchRes.completed_entries,
              totalEntries: batchRes.total_entries,
              mode: effectiveMode,
              transport: batchRes.transport,
              results: entries,
            };
            throw err;
          }
          return {
            ...batchRes,
            mode: effectiveMode,
          };
        });
      },
    },
    {
      name: 'desktop_ocr',
      description: 'Capture a window region via PrintWindow and run Windows.Media.Ocr (zh-Hans-CN) without stealing foreground focus. Returns compact token-efficient output by default.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          region: { type: 'string', description: 'full | header | sidebar | messages | composer | x,y,w,h' },
          find: { type: 'string', description: 'Optional target text to locate.' },
          scale: { type: 'number', minimum: 1, maximum: 4 },
          lang: { type: 'string' },
          includeWords: { type: 'boolean', default: false, description: 'Include per-character bounding boxes (default false to save ~90% tokens).' },
          includeLines: { type: 'boolean', description: 'Include full lines array (defaults to false when find matches, true otherwise).' },
          maxLines: { type: 'integer', minimum: 1, maximum: 500, default: 60 },
          outputPath: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { createAutomation, exclusiveLock } = getDeps();
        const opts = buildServerOptions(baseOptions, {
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        const outArg = readJsonArg(args, 'outputPath');
        if (outArg) enforceWriteMode(opts, 'desktop_ocr');
        const findArg = readJsonArg(args, 'find');
        const explicitIncludeLines = readJsonArg(args, 'includeLines');
        return exclusiveLock(opts, async (_assertHeld, leaseSignal) => {
          const ocr = await createAutomation({ ...opts, signal: leaseSignal }).desktop.adOcrWindow(readJsonArg(args, 'app'), {
            windowId: opts.windowId,
            titleIncludes: readJsonArg(args, 'titleIncludes'),
            region: readJsonArg(args, 'region'),
            find: findArg,
            scale: readJsonArg(args, 'scale'),
            lang: readJsonArg(args, 'lang'),
            includeWords: Boolean(readJsonArg(args, 'includeWords')),
            includeLines: explicitIncludeLines !== undefined ? Boolean(explicitIncludeLines) : true,
            maxLines: readJsonArg(args, 'maxLines') ?? 60,
            compactWindow: true,
            outputPath: outArg ? path.resolve(outArg) : undefined,
            signal: leaseSignal,
            timeoutMs: opts.timeoutMs,
          });
          if (findArg && explicitIncludeLines === undefined && Array.isArray(ocr.matches) && ocr.matches.length > 0) {
            const { lines: _omittedLines, text: _omittedText, ...compactHit } = ocr;
            return compactHit;
          }
          return ocr;
        });
      },
    },
    {
      name: 'desktop_shot',
      description: 'Capture a PNG screenshot of a target desktop window or screen.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          screen: { type: 'integer', minimum: 0 },
          outPath: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { createAutomation, exclusiveLock, appRegistry, fail } = getDeps();
        const opts = buildServerOptions(baseOptions, {
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        const appArg = readJsonArg(args, 'app');
        const titleArg = readJsonArg(args, 'titleIncludes');
        const screen = readJsonArg(args, 'screen');
        if (!appArg && !opts.windowId && !titleArg && screen === undefined) {
          throw fail('INVALID_ARGS', 'desktop_shot requires app, windowId, titleIncludes, or screen');
        }
        const outArg = readJsonArg(args, 'outPath');
        if (outArg) enforceWriteMode(opts, 'desktop_shot');
        return exclusiveLock(opts, async (_assertHeld, leaseSignal) => {
          const cdp = require('../cdp');
          const desktop = createAutomation({ ...opts, signal: leaseSignal }).desktop;
          const outPath = outArg
            ? path.resolve(outArg)
            : path.join(cdp.artifactsDir(), `desktop-shot-${cdp.formatTimestamp()}.png`);
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          const saveCapture = async (shotOpts) => {
            if (outArg || !opts.readOnly) {
              await desktop.adScreenshot(undefined, outPath, shotOpts);
              return;
            }
            const raw = await desktop.adScreenshot(undefined, undefined, shotOpts);
            if (typeof raw?.data !== 'string' || raw.data.length === 0) {
              throw fail('AGENT_DESKTOP_PROTOCOL_ERROR', 'Desktop screenshot response did not return base64 image data');
            }
            fs.writeFileSync(outPath, Buffer.from(raw.data, 'base64'));
          };
          if (screen !== undefined) {
            await saveCapture({ screen: Number(screen) });
            return { screen: Number(screen), outPath };
          }
          const found = await appRegistry.findMatchingWindows(desktop, appArg, {
            windowId: opts.windowId,
            titleIncludes: titleArg,
            signal: leaseSignal,
            timeoutMs: opts.timeoutMs,
          });
          if (!found.windows.length) throw fail('WINDOW_NOT_FOUND', 'Target window for screenshot was not found');
          const targetWin = found.windows[0];
          await saveCapture({ windowId: targetWin.id });
          return { windowId: targetWin.id, title: targetWin.title, bounds: targetWin.bounds, outPath };
        });
      },
    },
    {
      name: 'desktop_open_app',
      description: 'Open or wake a tray-hidden Windows desktop application (such as wecom, wechat, qq, notepad) and bring it ready in exclusive mode.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['app'],
        properties: {
          app: { type: 'string', description: 'App alias or process name, e.g. wecom, wechat, qq, notepad.' },
          exePath: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          focus: { type: 'boolean', default: true },
          restoreIfMinimized: { type: 'boolean', default: true },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { createAutomation, exclusiveLock } = getDeps();
        const opts = buildServerOptions(baseOptions, {
          mode: 'exclusive',
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        enforceWriteMode(opts, 'desktop_open_app', { requireExclusive: true });
        return exclusiveLock(opts, (_assertHeld, leaseSignal) => {
          const automation = createAutomation({ ...opts, signal: leaseSignal });
          const focusArg = readJsonArg(args, 'focus');
          return automation.scenes.ensureWindowReady(
            automation.desktop,
            {
              app: readJsonArg(args, 'app'),
              exePath: readJsonArg(args, 'exePath'),
              windowId: opts.windowId,
              titleIncludes: readJsonArg(args, 'titleIncludes'),
              preferFocused: true,
            },
            {
              focus: focusArg === undefined ? 'auto' : Boolean(focusArg),
              restoreIfMinimized: readJsonArg(args, 'restoreIfMinimized') !== false,
              launchIfMissing: true,
              signal: leaseSignal,
              timeoutMs: opts.timeoutMs,
            },
          );
        });
      },
    },
    {
      name: 'desktop_ensure_ready',
      description: 'Restore a minimized window, check usable size, and optionally focus or launch it.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string' },
          exePath: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          focus: { type: 'boolean' },
          launchIfMissing: { type: 'boolean', default: false },
          restoreIfMinimized: { type: 'boolean', default: true },
          preferFocused: { type: 'boolean', default: false },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { createAutomation, exclusiveLock } = getDeps();
        const focusArg = readJsonArg(args, 'focus');
        const explicitRestore = readJsonArg(args, 'restoreIfMinimized');
        const launchIfMissing = Boolean(readJsonArg(args, 'launchIfMissing'));
        const explicitWrite = launchIfMissing || focusArg === true || explicitRestore === true;
        const mayMutateWhenWritable = !baseOptions.readOnly
          && (explicitWrite || explicitRestore !== false || focusArg !== false);
        const opts = buildServerOptions(baseOptions, {
          ...((explicitWrite || mayMutateWhenWritable) ? { mode: 'exclusive' } : {}),
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        if (explicitWrite) enforceWriteMode(opts, 'desktop_ensure_ready', { requireExclusive: true });
        return exclusiveLock(opts, (_assertHeld, leaseSignal) => {
          const automation = createAutomation({ ...opts, signal: leaseSignal });
          return automation.scenes.ensureWindowReady(
            automation.desktop,
            {
              app: readJsonArg(args, 'app'),
              exePath: readJsonArg(args, 'exePath'),
              windowId: opts.windowId,
              titleIncludes: readJsonArg(args, 'titleIncludes'),
              preferFocused: readJsonArg(args, 'preferFocused') ? true : undefined,
            },
            {
              focus: opts.readOnly ? false : (focusArg === undefined ? 'auto' : Boolean(focusArg)),
              restoreIfMinimized: opts.readOnly ? false : (explicitRestore !== false),
              launchIfMissing,
              signal: leaseSignal,
              timeoutMs: opts.timeoutMs,
            },
          );
        });
      },
    },
    {
      name: 'desktop_click_text',
      description: 'Locate visible label text in a window region using WinRT OCR (optionally scrolling down on miss) and click its center in exclusive mode.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          app: { type: 'string' },
          exePath: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          text: { type: 'string' },
          region: { type: 'string' },
          index: { type: 'integer', minimum: 0, default: 0 },
          button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
          doubleClick: { type: 'boolean', default: false },
          scrollRetries: { type: 'integer', minimum: 0, maximum: 10, default: 0 },
          scrollDy: { type: 'number', default: -5 },
          launchIfMissing: { type: 'boolean', default: false },
          restoreIfMinimized: { type: 'boolean', default: true },
          restoreCursor: { type: 'boolean', default: true },
          ripple: { type: 'boolean', default: true },
          clickMode: { type: 'string', enum: ['physical_restore', 'message'], default: 'physical_restore' },
          scale: { type: 'number', minimum: 1, maximum: 4, default: 2 },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { createAutomation, exclusiveLock } = getDeps();
        const opts = buildServerOptions(baseOptions, {
          mode: 'exclusive',
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        enforceWriteMode(opts, 'desktop_click_text', { requireExclusive: true });
        return exclusiveLock(opts, (_assertHeld, leaseSignal) => {
          const automation = createAutomation({ ...opts, signal: leaseSignal });
          return automation.scenes.clickTextVerified(
            automation.desktop,
            {
              app: readJsonArg(args, 'app'),
              exePath: readJsonArg(args, 'exePath'),
              windowId: opts.windowId,
              titleIncludes: readJsonArg(args, 'titleIncludes'),
              text: readJsonArg(args, 'text'),
              region: readJsonArg(args, 'region'),
              index: readJsonArg(args, 'index') ?? 0,
              button: readJsonArg(args, 'button'),
              scale: readJsonArg(args, 'scale') ?? 2,
              scrollRetries: readJsonArg(args, 'scrollRetries') ?? 0,
              scrollDy: readJsonArg(args, 'scrollDy'),
              doubleClick: Boolean(readJsonArg(args, 'doubleClick')),
              launchIfMissing: Boolean(readJsonArg(args, 'launchIfMissing')),
              restoreIfMinimized: readJsonArg(args, 'restoreIfMinimized') !== false,
              restoreCursor: readJsonArg(args, 'restoreCursor') !== false,
              ripple: readJsonArg(args, 'ripple') !== false,
              ...(readJsonArg(args, 'clickMode') ? { clickMode: readJsonArg(args, 'clickMode') } : {}),
            },
            { signal: leaseSignal, timeoutMs: opts.timeoutMs },
          );
        });
      },
    },
    {
      name: 'desktop_chat_send',
      description: 'Open/wake IM window (e.g. wecom, wechat, qq), auto-detect split-pane/drawer layout, verify exact header OCR target match (CHAT_TARGET_UNVERIFIED gate), and send text/image/sticker/file items in one verified batch.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionName'],
        properties: {
          app: { type: 'string', default: 'wecom' },
          exePath: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          sessionName: { type: 'string', description: 'Exact chat session title, e.g. 文件传输助手.' },
          launchIfMissing: { type: 'boolean', default: true },
          restoreIfMinimized: { type: 'boolean', default: true },
          navigationMode: { type: 'string', enum: ['auto', 'keyboard_first'], default: 'auto' },
          composerClick: { type: 'boolean' },
          restoreCursor: { type: 'boolean', default: true },
          ripple: { type: 'boolean', default: true },
          allowSearch: { type: 'boolean', default: true },
          searchShortcut: { type: ['string', 'boolean'], description: 'Shortcut combo like "ctrl+f", or false to disable search.' },
          sidebarScrollPages: { type: 'integer', minimum: 0, maximum: 12, default: 3 },
          submitKey: { type: 'string', description: 'Key combo to submit composer, e.g. "return" or "ctrl+return".' },
          saveAfterShot: { type: 'string', description: 'Optional PNG file path to save the verified post-delivery chat window screenshot.' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['text', 'image', 'sticker', 'file'] },
                text: { type: 'string' },
                path: { type: 'string' },
              },
            },
          },
          messages: {
            type: 'array',
            items: { type: 'string' },
          },
          timeoutMs: { type: 'integer', minimum: 2000, maximum: 180000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { createAutomation, exclusiveLock } = getDeps();
        const opts = buildServerOptions(baseOptions, {
          mode: 'exclusive',
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        enforceWriteMode(opts, 'desktop_chat_send', { requireExclusive: true });
        const rawSearchShortcut = readJsonArg(args, 'searchShortcut');
        const allowSearchArg = readJsonArg(args, 'allowSearch');
        const allowSearch = allowSearchArg !== undefined
          ? Boolean(allowSearchArg)
          : (typeof rawSearchShortcut === 'boolean' ? rawSearchShortcut : true);
        const searchShortcutStr = typeof rawSearchShortcut === 'string' && rawSearchShortcut.trim()
          ? rawSearchShortcut.trim()
          : undefined;
        return exclusiveLock(opts, (_assertHeld, leaseSignal) => {
          const automation = createAutomation({ ...opts, signal: leaseSignal });
          const composerClickArg = readJsonArg(args, 'composerClick');
          return automation.scenes.deliverChatSessionVerified(
            automation.desktop,
            {
              app: readJsonArg(args, 'app') || 'wecom',
              exePath: readJsonArg(args, 'exePath'),
              windowId: opts.windowId,
              titleIncludes: readJsonArg(args, 'titleIncludes'),
              sessionName: readJsonArg(args, 'sessionName'),
              launchIfMissing: readJsonArg(args, 'launchIfMissing') !== false,
              restoreIfMinimized: readJsonArg(args, 'restoreIfMinimized') !== false,
              ...(readJsonArg(args, 'navigationMode') ? { navigationMode: readJsonArg(args, 'navigationMode') } : {}),
              ...(composerClickArg !== undefined ? { composerClick: Boolean(composerClickArg) } : {}),
              restoreCursor: readJsonArg(args, 'restoreCursor') !== false,
              ripple: readJsonArg(args, 'ripple') !== false,
              allowSearch,
              ...(searchShortcutStr ? { searchShortcut: searchShortcutStr } : {}),
              ...(readJsonArg(args, 'sidebarScrollPages') !== undefined ? { sidebarScrollPages: readJsonArg(args, 'sidebarScrollPages') } : {}),
              ...(readJsonArg(args, 'submitKey') ? { submitKey: readJsonArg(args, 'submitKey') } : {}),
              ...(readJsonArg(args, 'saveAfterShot') ? { saveAfterShot: readJsonArg(args, 'saveAfterShot') } : {}),
              ...(readJsonArg(args, 'items') ? { items: readJsonArg(args, 'items') } : {}),
              ...(readJsonArg(args, 'messages') ? { messages: readJsonArg(args, 'messages') } : {}),
            },
            { signal: leaseSignal, timeoutMs: opts.timeoutMs },
          );
        });
      },
    },
    {
      name: 'desktop_deliver',
      description: 'Deliver multiple text messages to a standard uia_semantic desktop window using single-process batching and readback verification.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['spec', 'messages'],
        properties: {
          spec: { type: 'object' },
          messages: { type: 'array', items: { type: 'string' }, minItems: 1 },
          mode: { type: 'string', enum: ['cooperative', 'exclusive'], default: 'cooperative' },
          timeoutMs: { type: 'integer', minimum: 2000, maximum: 180000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const { createAutomation, exclusiveLock } = getDeps();
        const opts = buildServerOptions(baseOptions, {
          mode: readJsonArg(args, 'mode') || baseOptions.mode,
          windowId: readJsonArg(args, 'spec')?.windowId,
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        enforceWriteMode(opts, 'desktop_deliver', { requireExclusive: false });
        return exclusiveLock(opts, (_assertHeld, leaseSignal) => {
          const automation = createAutomation({ ...opts, signal: leaseSignal });
          return automation.scenes.deliverMessagesVerified(
            automation.desktop,
            readJsonArg(args, 'spec'),
            readJsonArg(args, 'messages'),
            { signal: leaseSignal, timeoutMs: opts.timeoutMs },
          );
        });
      },
    },
  ];
}

function jsonRpcSuccess(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function createMcpDispatcher(serverOptions = {}) {
  const tools = buildToolDefinitions();
  const toolMap = new Map(tools.map(t => [t.name, t]));
  const normalizedBase = { ...serverOptions };
  if (normalizedBase.readOnly === undefined) normalizedBase.readOnly = true;
  if (!normalizedBase.mode) normalizedBase.mode = 'cooperative';

  const listPayload = () => ({
    tools: tools.map(({ name, description, annotations, inputSchema }) => ({
      name,
      description,
      annotations,
      inputSchema,
    })),
  });

  async function handleMessage(msg, signal) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return jsonRpcError(null, -32600, 'Invalid Request: expected JSON-RPC object');
    }
    const hasId = Object.hasOwn(msg, 'id') && msg.id !== undefined && msg.id !== null;
    const method = msg.method;
    if (typeof method !== 'string') {
      return hasId ? jsonRpcError(msg.id, -32600, 'Invalid Request: missing method') : null;
    }

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null;
    }
    if (!hasId) {
      return null;
    }

    if (method === 'initialize') {
      const requested = msg.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return jsonRpcSuccess(msg.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-browser-bridge-desktop', version: pkg.version },
        instructions: [
          'Call desktop_doctor first to check isInteractiveDefaultDesktop.',
          'For WeCom/WeChat/QQ zero-UIA windows, call desktop_chat_send directly instead of probing UIA trees.',
          'Never automatically retry after delivered_unverified or CHAT_TARGET_UNVERIFIED; inspect via desktop_ocr or desktop_shot first.',
        ].join(' '),
      });
    }

    if (method === 'ping') {
      return jsonRpcSuccess(msg.id, {});
    }

    if (method === 'tools/list') {
      return jsonRpcSuccess(msg.id, listPayload());
    }

    if (method === 'tools/call') {
      const name = msg.params?.name;
      const tool = toolMap.get(name);
      if (!tool) {
        return jsonRpcError(msg.id, -32602, `Unknown MCP tool: ${String(name || '')}`);
      }
      reloadModulesIfChanged();
      activeDispatchCalls += 1;
      try {
        const data = await tool.execute(msg.params?.arguments || {}, normalizedBase, signal);
        return jsonRpcSuccess(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name, data }) }],
          structuredContent: { ok: true, tool: name, data },
          isError: false,
        });
      } catch (err) {
        const { serializeError } = getDeps();
        const serialized = {
          ...serializeError(err),
          ...(err?.details && typeof err.details === 'object' ? { details: err.details } : {}),
        };
        return jsonRpcSuccess(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, tool: name, error: serialized }) }],
          structuredContent: { ok: false, tool: name, error: serialized },
          isError: true,
        });
      } finally {
        activeDispatchCalls = Math.max(0, activeDispatchCalls - 1);
      }
    }

    return jsonRpcError(msg.id, -32601, `Method not found: ${method}`);
  }

  return { handleMessage, listPayload };
}

function defaultTokenFilePath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'AgentBrowserBridge', 'mcp-token.json');
}

function ensureHttpToken({ token, tokenFile } = {}) {
  if (token) return String(token);
  const filePath = path.resolve(tokenFile || defaultTokenFilePath());
  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (existing && typeof existing.token === 'string' && existing.token.length >= 24) {
      return existing.token;
    }
  } catch {}
  const generated = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ token: generated, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return generated;
}

function serveStdio(options = {}) {
  const dispatcher = createMcpDispatcher(options);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set();

  const writeResponse = (obj) => {
    if (!obj) return;
    process.stdout.write(JSON.stringify(obj) + '\n');
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeResponse(jsonRpcError(null, -32700, 'Parse error: invalid JSON'));
      return;
    }
    const p = (async () => {
      if (Array.isArray(parsed)) {
        const results = (await Promise.all(parsed.map(item => dispatcher.handleMessage(item)))).filter(Boolean);
        if (results.length) writeResponse(results);
        return;
      }
      const res = await dispatcher.handleMessage(parsed);
      writeResponse(res);
    })().catch((err) => {
      writeResponse(jsonRpcError(parsed?.id ?? null, -32603, err?.message || 'Internal error'));
    });
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
  });

  return new Promise((resolve) => {
    rl.on('close', async () => {
      await Promise.allSettled([...inFlight]);
      resolve();
    });
  });
}

function constantTimeTokenMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function readHttpBody(req) {
  const { fail } = getDeps();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(fail('INVALID_ARGS', 'MCP HTTP request body exceeds 2 MiB limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function startHttpServer(options = {}) {
  const { fail } = getDeps();
  const host = DEFAULT_HTTP_HOST;
  const port = options.port === undefined ? DEFAULT_HTTP_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw fail('INVALID_ARGS', 'MCP HTTP port must be an integer between 0 and 65535');
  }
  const token = ensureHttpToken({ token: options.token, tokenFile: options.tokenFile });
  const dispatcher = createMcpDispatcher(options);
  const sessionId = crypto.randomUUID();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.origin) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'FORBIDDEN_ORIGIN', message: 'Browser origins are not allowed on local MCP desktop endpoint' }));
        return;
      }

      const authHeader = String(req.headers.authorization || '');
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!constantTimeTokenMatch(bearer, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Valid Bearer token is required' }));
        return;
      }

      const reqPath = String(req.url || '').split('?')[0];
      if (reqPath !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'Use /mcp for Streamable HTTP MCP traffic' }));
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        res.writeHead(req.method === 'GET' ? 405 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: req.method === 'DELETE', message: req.method === 'GET' ? 'SSE stream not required; POST /mcp' : 'Session acknowledged' }));
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }));
        return;
      }

      const raw = await readHttpBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error: invalid JSON')));
        return;
      }

      const ac = new AbortController();
      req.once('close', () => ac.abort());

      if (Array.isArray(parsed)) {
        const replies = (await Promise.all(parsed.map(item => dispatcher.handleMessage(item, ac.signal)))).filter(Boolean);
        if (!replies.length) {
          res.writeHead(202, { 'Mcp-Session-Id': sessionId });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId });
        res.end(JSON.stringify(replies));
        return;
      }

      const reply = await dispatcher.handleMessage(parsed, ac.signal);
      if (!reply) {
        res.writeHead(202, { 'Mcp-Session-Id': sessionId });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId });
      res.end(JSON.stringify(reply));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(null, -32603, err?.message || 'Internal server error')));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  return {
    server,
    host,
    port: addr.port,
    url: `http://${host}:${addr.port}/mcp`,
    token,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

module.exports = {
  createMcpDispatcher,
  reloadModulesIfChanged,
  serveStdio,
  startHttpServer,
  ensureHttpToken,
  defaultTokenFilePath,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
};
