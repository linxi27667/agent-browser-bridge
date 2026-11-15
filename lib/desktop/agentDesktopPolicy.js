const path = require('node:path');
const { desktopError } = require('./agentDesktopProcess');

const SCHEMAS = {
  status: {}, version: {}, 'list-apps': { '--app': 'value' }, 'list-windows': { '--app': 'value' },
  snapshot: { '--app': 'value', '--window-id': 'value', '--surface': 'value', '--root': 'value', '--skeleton': 'flag', '-i': 'flag', '--compact': 'flag', '--timeout-ms': 'value' },
  find: { '--app': 'value', '--window-id': 'value', '--role': 'value', '--name': 'value', '--root': 'value', '--timeout-ms': 'value' },
  get: { '--property': 'value' }, click: { '--timeout-ms': 'value' }, 'set-value': { '--stdin': 'flag', '--timeout-ms': 'value' },
  type: { '--stdin': 'flag', '--interval-ms': 'value', '--timeout-ms': 'value' }, press: { '--app': 'value', '--window-id': 'value' },
  'focus-window': { '--app': 'value', '--window-id': 'value' }, launch: { '--arg': 'repeat' }, 'close-app': {},
  'mouse-click': { '--xy': 'value', '--button': 'value', '--count': 'value' }, 'clipboard-set': { '--stdin': 'flag' }, 'clipboard-get': {}, 'clipboard-clear': {},
  screenshot: { '--app': 'value', '--window-id': 'value', '--screen': 'value' },
  'open-system-surface': { '--surface': 'value' },
  restore: { '--app': 'value', '--window-id': 'value' },
};
const READS = new Set(['status', 'version', 'list-apps', 'list-windows', 'snapshot', 'find', 'get', 'screenshot', 'clipboard-get']);
const FOREGROUND = new Set(['type', 'press', 'focus-window', 'launch', 'close-app', 'mouse-click', 'clipboard-set', 'clipboard-clear', 'open-system-surface', 'restore']);
const HEADED_COMMANDS = new Set(['type', 'press', 'mouse-click', 'open-system-surface']);
const SHELL_SURFACES = new Set(['taskbar', 'system-tray', 'system-tray-overflow', 'start-menu', 'action-center']);
const REF = /^@[A-Za-z0-9_-]+:e[1-9]\d*$/;
function invalid(message) { throw desktopError('INVALID_ARGS', message); }
function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) invalid(`${name} must be a nonempty string without control characters`);
  return value;
}
function qualifiedRef(value) { if (!REF.test(value)) invalid('A snapshot-qualified ref is required (@snapshot:eN)'); return value; }

function validateCommand(args, input, config) {
  if (!Array.isArray(args) || args.length === 0 || args.some(a => typeof a !== 'string' || a.includes('\0'))) invalid('Command arguments must be an array of strings');
  const command = args[0], schema = Object.hasOwn(SCHEMAS, command) ? SCHEMAS[command] : null;
  if (!schema) throw desktopError('DESKTOP_COMMAND_BLOCKED', 'Desktop command is not in the guarded command allowlist');
  const flags = {}, positional = [];
  for (let i = 1; i < args.length; i++) {
    const argument = args[i];
    if (!argument.startsWith('-')) { positional.push(argument); continue; }
    const equal = argument.indexOf('='), name = equal < 0 ? argument : argument.slice(0, equal), kind = schema[name];
    if (!kind || (flags[name] !== undefined && kind !== 'repeat')) invalid('Unsupported or repeated desktop option');
    if (kind === 'flag') {
      if (equal >= 0) invalid('Boolean desktop options do not take values');
      flags[name] = true;
    } else {
      const value = equal < 0 ? args[++i] : argument.slice(equal + 1);
      if (value === undefined || (equal < 0 && value.startsWith('-'))) invalid('Desktop option requires an explicit value');
      text(value, 'Desktop option');
      if (kind === 'repeat') (flags[name] ||= []).push(value); else flags[name] = value;
    }
  }
  const mutating = !READS.has(command);
  if (mutating && config.readOnly) throw desktopError('READ_ONLY_BLOCKED', 'Desktop mutations require readOnly:false');
  if (FOREGROUND.has(command) && config.mode !== 'exclusive') throw desktopError('DESKTOP_FOREGROUND_REQUIRED', 'This desktop action requires exclusive mode');
  const shellSnapshot = command === 'snapshot' && SHELL_SURFACES.has(flags['--surface']);
  if (command === 'open-system-surface' && !SHELL_SURFACES.has(flags['--surface'])) invalid('An explicit supported shell surface is required');
  if (['snapshot', 'find', 'focus-window', 'press', 'restore'].includes(command) && !flags['--app'] && !flags['--window-id'] && !flags['--root'] && !shellSnapshot) invalid('An explicit app, window ID, root ref, or supported shell surface is required');
  if (flags['--window-id'] && !/^w-[A-Za-z0-9_-]+$/.test(flags['--window-id'])) invalid('Window ID must come from list-windows');
  if (flags['--root']) qualifiedRef(flags['--root']);
  if (flags['--timeout-ms'] && (!/^\d+$/.test(flags['--timeout-ms']) || Number(flags['--timeout-ms']) > 300000)) invalid('Invalid native timeout');
  if (flags['--interval-ms'] && (!/^\d+$/.test(flags['--interval-ms']) || Number(flags['--interval-ms']) < 1 || Number(flags['--interval-ms']) > 2000)) invalid('intervalMs must be 1-2000');
  if (['get', 'click', 'type', 'set-value'].includes(command)) {
    if (positional.length !== 1) invalid('This action requires exactly one qualified ref');
    qualifiedRef(positional[0]);
  } else if (['press', 'launch', 'close-app'].includes(command)) {
    if (positional.length !== 1) invalid('This action requires exactly one target');
    text(positional[0], 'Target');
  } else if (command === 'screenshot') {
    if (!flags['--app'] && !flags['--window-id'] && flags['--screen'] === undefined) invalid('Screenshot requires an explicit app, window ID, or screen');
    if (flags['--screen'] !== undefined && !/^\d+$/.test(flags['--screen'])) invalid('Screen index must be a nonnegative integer');
    if (positional.length > 1 || (positional.length && !path.isAbsolute(positional[0]))) invalid('Screenshot output must be an absolute path');
  } else if (positional.length) invalid('Unexpected positional desktop arguments');
  if (['type', 'set-value', 'clipboard-set'].includes(command)) {
    if (!flags['--stdin'] || typeof input !== 'string' || input.includes('\0')) invalid('Text must be supplied through stdin');
    if (Buffer.byteLength(input, 'utf8') > (command === 'type' ? 10000 : 128 * 1024)) invalid('Text exceeds the native stdin limit');
  } else if (input !== undefined) invalid('This desktop command does not accept stdin');
  if (command === 'launch' && !path.isAbsolute(positional[0])) invalid('Launch requires an absolute executable path');
  if (command === 'press' && /(?:alt\+f4|win\+l|ctrl\+alt\+(?:delete|del))/i.test(positional[0])) invalid('Dangerous shortcuts are not permitted');
  if (command === 'mouse-click') {
    if (!/^-?\d+,-?\d+$/.test(flags['--xy'] || '')) invalid('Mouse coordinates must be finite integers');
    if (flags['--button'] && !['left', 'right', 'middle'].includes(flags['--button'])) invalid('Unsupported mouse button');
    if (flags['--count'] && !['1', '2', '3'].includes(flags['--count'])) invalid('Click count must be 1-3');
  }
  return { command, mutating, foreground: FOREGROUND.has(command), flags };
}

const ALLOWED_STEP_KEYS = {
  status: ['command'],
  version: ['command'],
  'list-apps': ['command', 'app'],
  'list-windows': ['command', 'app'],
  snapshot: ['command', 'app', 'windowId', 'surface', 'root', 'skeleton', 'interactiveOnly', 'compact', 'timeoutMs'],
  find: ['command', 'app', 'windowId', 'role', 'name', 'root', 'timeoutMs'],
  get: ['command', 'ref', 'refId', 'property'],
  click: ['command', 'ref', 'refId', 'timeoutMs'],
  'set-value': ['command', 'ref', 'refId', 'value', 'timeoutMs'],
  type: ['command', 'ref', 'refId', 'text', 'value', 'intervalMs', 'timeoutMs'],
  press: ['command', 'combo', 'key', 'app', 'windowId'],
  'focus-window': ['command', 'app', 'windowId'],
  restore: ['command', 'app', 'windowId'],
  'mouse-click': ['command', 'x', 'y', 'xy', 'button', 'count', 'windowId'],
  'clipboard-set': ['command', 'text', 'value'],
  'clipboard-get': ['command'],
  'clipboard-clear': ['command'],
  screenshot: ['command', 'app', 'windowId', 'screen', 'outputPath', 'path'],
  'open-system-surface': ['command', 'surface'],
  wait: ['command', 'ms'],
};

function assertStepKeys(step, allowed) {
  for (const key of Object.keys(step)) {
    if (!allowed.includes(key)) invalid(`Unsupported batch step field "${key}" for "${step.command}"`);
  }
}

function normalizeBatchSteps(steps, config, defaultWindowId) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 64) {
    invalid('Desktop batch requires an array of 1 to 64 steps');
  }
  const items = [];
  const coordinateChecks = [];
  let anyMutating = false;
  let anyHeaded = false;
  let hasText = false;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step || typeof step !== 'object' || Array.isArray(step) || typeof step.command !== 'string') {
      invalid(`Batch step ${index} must be an object with a string command`);
    }
    const command = step.command;
    const allowedKeys = Object.hasOwn(ALLOWED_STEP_KEYS, command) ? ALLOWED_STEP_KEYS[command] : null;
    if (!allowedKeys) throw desktopError('DESKTOP_COMMAND_BLOCKED', `Batch command "${command}" is not in the guarded command allowlist`);
    assertStepKeys(step, allowedKeys);

    if (command === 'wait') {
      if (!Number.isInteger(step.ms) || step.ms < 1 || step.ms > 30000) {
        invalid('Batch wait requires an integer ms from 1 to 30000');
      }
      items.push({
        command: 'wait',
        cliArgs: null,
        cliInput: undefined,
        batchArgs: { ms: step.ms },
        mutating: false,
        headed: false,
        hasText: false,
      });
      continue;
    }

    const cliArgs = [command];
    const batchArgs = {};
    let cliInput;
    let stepHasText = false;
    const refVal = step.ref ?? step.refId;

    const addScope = () => {
      if (step.app !== undefined) { cliArgs.push(`--app=${String(step.app)}`); batchArgs.app = String(step.app); }
      if (step.windowId !== undefined) { cliArgs.push(`--window-id=${String(step.windowId)}`); batchArgs.window_id = String(step.windowId); }
    };

    if (command === 'list-apps' || command === 'list-windows') {
      if (step.app !== undefined) { cliArgs.push(`--app=${String(step.app)}`); batchArgs.app = String(step.app); }
    } else if (command === 'snapshot') {
      addScope();
      if (step.surface !== undefined) { cliArgs.push(`--surface=${String(step.surface)}`); batchArgs.surface = String(step.surface); }
      if (step.root !== undefined) { cliArgs.push(`--root=${String(step.root)}`); batchArgs.root = String(step.root); }
      if (step.skeleton) { cliArgs.push('--skeleton'); batchArgs.skeleton = true; }
      if (step.interactiveOnly !== false) { cliArgs.push('-i'); batchArgs.interactive_only = true; }
      if (step.compact !== false) { cliArgs.push('--compact'); batchArgs.compact = true; }
      if (step.timeoutMs !== undefined) { cliArgs.push(`--timeout-ms=${String(step.timeoutMs)}`); batchArgs.timeout_ms = Number(step.timeoutMs); }
    } else if (command === 'find') {
      addScope();
      for (const k of ['role', 'name', 'root']) {
        if (step[k] !== undefined) { cliArgs.push(`--${k}=${String(step[k])}`); batchArgs[k] = String(step[k]); }
      }
      if (step.timeoutMs !== undefined) { cliArgs.push(`--timeout-ms=${String(step.timeoutMs)}`); batchArgs.timeout_ms = Number(step.timeoutMs); }
    } else if (command === 'get') {
      const prop = step.property ?? 'text';
      cliArgs.push(String(refVal ?? ''), `--property=${String(prop)}`);
      batchArgs.ref_id = String(refVal ?? '');
      batchArgs.property = String(prop);
    } else if (command === 'click') {
      cliArgs.push(String(refVal ?? ''));
      batchArgs.ref_id = String(refVal ?? '');
      if (step.timeoutMs !== undefined) { cliArgs.push(`--timeout-ms=${String(step.timeoutMs)}`); batchArgs.timeout_ms = Number(step.timeoutMs); }
    } else if (command === 'set-value') {
      const val = step.value;
      cliArgs.push(String(refVal ?? ''), '--stdin');
      if (step.timeoutMs !== undefined) { cliArgs.push(`--timeout-ms=${String(step.timeoutMs)}`); batchArgs.timeout_ms = Number(step.timeoutMs); }
      cliInput = val;
      stepHasText = true;
      batchArgs.ref_id = String(refVal ?? '');
      batchArgs.value = val;
    } else if (command === 'type') {
      const val = step.text !== undefined ? step.text : step.value;
      cliArgs.push(String(refVal ?? ''), '--stdin');
      if (step.intervalMs !== undefined) { cliArgs.push(`--interval-ms=${String(step.intervalMs)}`); batchArgs.interval_ms = Number(step.intervalMs); }
      if (step.timeoutMs !== undefined) { cliArgs.push(`--timeout-ms=${String(step.timeoutMs)}`); batchArgs.timeout_ms = Number(step.timeoutMs); }
      cliInput = val;
      stepHasText = true;
      batchArgs.ref_id = String(refVal ?? '');
      batchArgs.text = val;
    } else if (command === 'press') {
      const combo = step.combo ?? step.key;
      cliArgs.push(String(combo ?? ''));
      batchArgs.combo = String(combo ?? '');
      addScope();
    } else if (command === 'focus-window' || command === 'restore') {
      addScope();
    } else if (command === 'mouse-click') {
      const xyStr = step.xy !== undefined
        ? String(step.xy)
        : ([step.x, step.y].every(Number.isFinite) ? `${Math.round(step.x)},${Math.round(step.y)}` : '');
      cliArgs.push(`--xy=${xyStr}`);
      batchArgs.xy = xyStr;
      if (step.button !== undefined) { cliArgs.push(`--button=${String(step.button)}`); batchArgs.button = String(step.button); }
      if (step.count !== undefined) { cliArgs.push(`--count=${String(step.count)}`); batchArgs.count = Number(step.count); }
      coordinateChecks.push({ xy: xyStr, windowId: step.windowId ?? defaultWindowId });
    } else if (command === 'clipboard-set') {
      const val = step.text !== undefined ? step.text : step.value;
      cliArgs.push('--stdin');
      cliInput = val;
      stepHasText = true;
      batchArgs.text = val;
    } else if (command === 'screenshot') {
      addScope();
      if (step.screen !== undefined) { cliArgs.push(`--screen=${String(step.screen)}`); batchArgs.screen = Number(step.screen); }
      const outPath = step.outputPath ?? step.path;
      if (outPath !== undefined) { cliArgs.push(String(outPath)); batchArgs.output_path = String(outPath); }
    } else if (command === 'open-system-surface') {
      if (step.surface !== undefined) { cliArgs.push(`--surface=${String(step.surface)}`); batchArgs.surface = String(step.surface); }
    }

    const validated = validateCommand(cliArgs, cliInput, config);
    const headed = HEADED_COMMANDS.has(command);
    if (validated.mutating) anyMutating = true;
    if (headed) anyHeaded = true;
    if (stepHasText) hasText = true;
    items.push({
      command,
      cliArgs,
      cliInput,
      batchArgs,
      mutating: validated.mutating,
      headed,
      hasText: stepHasText,
    });
  }

  return { items, coordinateChecks, anyMutating, anyHeaded, hasText };
}

module.exports = { validateCommand, normalizeBatchSteps, text, qualifiedRef };
