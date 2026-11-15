const path = require('node:path');
const { desktopError, positiveInteger, resolveBinary, execute } = require('./agentDesktopProcess');
const { validateCommand, text } = require('./agentDesktopPolicy');

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
    if (['type', 'press', 'mouse-click'].includes(parsed.command)) nativeArgs.unshift('--headed');
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

  const client = {
    adRaw: (args, call = {}) => run(args, call),
    adVersion: call => version(call),
    adStatus: call => run(['status'], call),
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
  };
  return Object.freeze(client);
}

module.exports = { createDesktopClient, ...createDesktopClient() };
