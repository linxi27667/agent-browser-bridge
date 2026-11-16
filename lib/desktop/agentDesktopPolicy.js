const path = require('node:path');
const { safeDesktopError } = require('./agentDesktopProcess');

const SCHEMAS = {
  status: {}, version: {}, 'list-displays': {}, 'list-apps': { '--app': 'value', '--timeout-ms': 'value' }, 'list-windows': { '--app': 'value', '--timeout-ms': 'value' },
  'list-surfaces': { '--app': 'value' },
  snapshot: { '--app': 'value', '--window-id': 'value', '--surface': 'value', '--root': 'value', '--skeleton': 'flag', '-i': 'flag', '--compact': 'flag', '--timeout-ms': 'value' },
  find: {
    '--app': 'value', '--window-id': 'value', '--role': 'value', '--name': 'value', '--value': 'value',
    '--text': 'value', '--description': 'value', '--native-id': 'value', '--exact': 'flag',
    '--surface': 'value', '--state': 'repeat', '--root': 'value', '--timeout-ms': 'value',
    '--count': 'flag', '--first': 'flag', '--last': 'flag', '--nth': 'value', '--limit': 'value',
  },
  get: { '--property': 'value' },
  is: { '--property': 'value' },
  click: { '--timeout-ms': 'value' },
  'double-click': { '--timeout-ms': 'value' },
  'right-click': { '--timeout-ms': 'value' },
  clear: { '--timeout-ms': 'value' },
  focus: { '--timeout-ms': 'value' },
  select: { '--timeout-ms': 'value' },
  toggle: { '--timeout-ms': 'value' },
  check: { '--timeout-ms': 'value' },
  uncheck: { '--timeout-ms': 'value' },
  expand: { '--timeout-ms': 'value' },
  collapse: { '--timeout-ms': 'value' },
  scroll: { '--direction': 'value', '--amount': 'value', '--timeout-ms': 'value' },
  'scroll-to': { '--timeout-ms': 'value' },
  'set-value': { '--stdin': 'flag', '--timeout-ms': 'value' },
  type: { '--stdin': 'flag', '--interval-ms': 'value', '--timeout-ms': 'value' },
  press: { '--app': 'value', '--window-id': 'value' },
  hover: { '--xy': 'value', '--timeout-ms': 'value' },
  'focus-window': { '--app': 'value', '--window-id': 'value', '--title': 'value' },
  'resize-window': { '--app': 'value', '--window-id': 'value', '--width': 'value', '--height': 'value' },
  'move-window': { '--app': 'value', '--window-id': 'value', '--x': 'value', '--y': 'value' },
  minimize: { '--app': 'value', '--window-id': 'value' },
  maximize: { '--app': 'value', '--window-id': 'value' },
  restore: { '--app': 'value', '--window-id': 'value' },
  launch: { '--arg': 'repeat', '--timeout': 'value', '--activate': 'flag' },
  'close-app': {},
  'mouse-click': { '--xy': 'value', '--button': 'value', '--count': 'value' },
  'mouse-wheel': { '--x': 'value', '--y': 'value', '--dy': 'value', '--dx': 'value' },
  'clipboard-set': { '--stdin': 'flag', '--image': 'value', '--file-url': 'repeat' },
  'clipboard-get': { '--format': 'value', '--out': 'value' },
  'clipboard-clear': {},
  screenshot: { '--app': 'value', '--window-id': 'value', '--screen': 'value' },
  'open-system-surface': { '--surface': 'value' },
  wait: {
    '--element': 'value', '--window': 'value', '--text': 'value', '--menu': 'flag', '--menu-closed': 'flag',
    '--notification': 'flag', '--event': 'value', '--window-id': 'value', '--predicate': 'value',
    '--value': 'value', '--action': 'value', '--count': 'value', '--timeout': 'value', '--app': 'value',
  },
  'cursor-overlay': {
    '--label': 'value', '--max-words': 'value', '--fill': 'value', '--rim': 'value',
    '--accent': 'value', '--size': 'value', '--no-ripple': 'flag', '--no-highlight': 'flag',
    '--image': 'value', '--pointer-image': 'value', '--travel-ms': 'value', '--dwell-ms': 'value',
  },
};
const READS = new Set([
  'status', 'version', 'list-displays', 'list-apps', 'list-windows', 'list-surfaces',
  'snapshot', 'find', 'get', 'is', 'screenshot', 'clipboard-get', 'wait',
]);
const FOREGROUND = new Set([
  'type', 'press', 'focus', 'double-click', 'right-click', 'hover',
  'focus-window', 'resize-window', 'move-window', 'minimize', 'maximize', 'restore',
  'launch', 'close-app', 'mouse-click', 'mouse-wheel',
  'clipboard-set', 'clipboard-clear', 'open-system-surface',
]);
const HEADED_COMMANDS = new Set([
  'type', 'press', 'focus', 'double-click', 'right-click', 'hover',
  'mouse-click', 'mouse-wheel', 'open-system-surface',
]);
const WINDOW_STATE_MUTATORS = new Set([
  'focus-window', 'focus', 'move-window', 'resize-window',
  'minimize', 'maximize', 'restore', 'open-system-surface', 'press',
]);
const REF_ONLY_ACTIONS = new Set([
  'get', 'is', 'click', 'double-click', 'right-click', 'clear', 'focus',
  'toggle', 'check', 'uncheck', 'expand', 'collapse', 'scroll', 'scroll-to',
  'type', 'set-value',
]);
const SCOPED_WINDOW_COMMANDS = new Set([
  'snapshot', 'find', 'focus-window', 'resize-window', 'move-window',
  'minimize', 'maximize', 'restore', 'press',
]);
const SHELL_SURFACES = new Set(['taskbar', 'system-tray', 'system-tray-overflow', 'start-menu', 'action-center']);
const REF = /^@[A-Za-z0-9_-]+:e[1-9]\d*$/;
function invalid(message) { throw safeDesktopError('INVALID_ARGS', message); }
function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) invalid(`${name} must be a nonempty string without control characters`);
  return value;
}
function qualifiedRef(value) { if (!REF.test(value)) invalid('A snapshot-qualified ref is required (@snapshot:eN)'); return value; }

function validateCommand(args, input, config) {
  if (!Array.isArray(args) || args.length === 0 || args.some(a => typeof a !== 'string' || a.includes('\0'))) invalid('Command arguments must be an array of strings');
  const command = args[0], schema = Object.hasOwn(SCHEMAS, command) ? SCHEMAS[command] : null;
  if (!schema) throw safeDesktopError('DESKTOP_COMMAND_BLOCKED', 'Desktop command is not in the guarded command allowlist');
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
  const fileWriteRead = (command === 'screenshot' && positional.length > 0)
    || (command === 'clipboard-get' && flags['--out'] !== undefined);
  const mutating = command === 'cursor-overlay'
    ? true
    : (!READS.has(command) || fileWriteRead);
  if (mutating && config.readOnly) throw safeDesktopError('READ_ONLY_BLOCKED', 'Desktop mutations require readOnly:false');
  if (FOREGROUND.has(command) && config.mode !== 'exclusive') throw safeDesktopError('DESKTOP_FOREGROUND_REQUIRED', 'This desktop action requires exclusive mode');
  const unscopedSurface = (command === 'snapshot' || command === 'find')
    && (SHELL_SURFACES.has(flags['--surface']) || flags['--surface'] === 'focused');
  if (command === 'open-system-surface' && !SHELL_SURFACES.has(flags['--surface'])) invalid('An explicit supported shell surface is required');
  if (SCOPED_WINDOW_COMMANDS.has(command)) {
    const hasTitle = command === 'focus-window' && Boolean(flags['--title']);
    if (!flags['--app'] && !flags['--window-id'] && !flags['--root'] && !unscopedSurface && !hasTitle) {
      invalid('An explicit app, window ID, root ref, or supported shell surface is required');
    }
  }
  if (flags['--window-id'] && !/^w-[A-Za-z0-9_-]+$/.test(flags['--window-id'])) invalid('Window ID must come from list-windows');
  if (flags['--root']) qualifiedRef(flags['--root']);
  if (flags['--element']) qualifiedRef(flags['--element']);
  if (flags['--timeout-ms'] && (!/^\d+$/.test(flags['--timeout-ms']) || Number(flags['--timeout-ms']) > 300000)) invalid('Invalid native timeout');
  if (flags['--timeout'] && (!/^\d+$/.test(flags['--timeout']) || Number(flags['--timeout']) > 300000)) invalid('Invalid wait/launch timeout');
  if (flags['--interval-ms'] && (!/^\d+$/.test(flags['--interval-ms']) || Number(flags['--interval-ms']) < 1 || Number(flags['--interval-ms']) > 2000)) invalid('intervalMs must be 1-2000');
  if (flags['--nth'] !== undefined && !/^\d+$/.test(flags['--nth'])) invalid('find --nth must be a nonnegative integer');
  if (flags['--limit'] !== undefined && (!/^\d+$/.test(flags['--limit']) || Number(flags['--limit']) < 1)) invalid('find --limit must be a positive integer');
  if (command === 'wait' && flags['--count'] !== undefined && (!/^\d+$/.test(flags['--count']) || Number(flags['--count']) < 1)) {
    invalid('wait --count must be a positive integer');
  }
  if (REF_ONLY_ACTIONS.has(command)) {
    if (positional.length !== 1) invalid('This action requires exactly one qualified ref');
    qualifiedRef(positional[0]);
  } else if (command === 'select') {
    if (positional.length !== 2) invalid('select requires a qualified ref and an option value');
    qualifiedRef(positional[0]);
    text(positional[1], 'Option value');
  } else if (command === 'hover') {
    const hasXy = flags['--xy'] !== undefined;
    if ((positional.length === 1) === hasXy || positional.length > 1) {
      invalid('hover requires either one qualified ref or --xy=x,y');
    }
    if (positional.length === 1) qualifiedRef(positional[0]);
    if (hasXy && !/^-?\d+,-?\d+$/.test(flags['--xy'])) invalid('Hover coordinates must be finite integers');
  } else if (command === 'wait') {
    if (positional.length > 1) invalid('wait accepts at most one millisecond argument');
    if (positional.length === 1 && (!/^\d+$/.test(positional[0]) || Number(positional[0]) < 1 || Number(positional[0]) > 30000)) {
      invalid('wait milliseconds must be an integer between 1 and 30000');
    }
    const hasWaitTarget = positional.length === 1
      || Boolean(flags['--element'] || flags['--window'] || flags['--text'] || flags['--event'] || flags['--menu'] || flags['--menu-closed'] || flags['--notification']);
    if (!hasWaitTarget) invalid('wait requires milliseconds or --element/--window/--text/--event/--menu');
  } else if (['press', 'launch', 'close-app'].includes(command)) {
    if (positional.length !== 1) invalid('This action requires exactly one target');
    text(positional[0], 'Target');
  } else if (command === 'cursor-overlay') {
    if (positional.length !== 1 || !['enable', 'disable'].includes(positional[0])) {
      invalid('cursor-overlay requires enable or disable');
    }
    if (flags['--image'] && !path.isAbsolute(flags['--image'])) invalid('cursor-overlay --image must be an absolute path');
    if (flags['--pointer-image'] && !path.isAbsolute(flags['--pointer-image'])) invalid('cursor-overlay --pointer-image must be an absolute path');
    if (flags['--max-words'] !== undefined && (!/^\d+$/.test(flags['--max-words']) || Number(flags['--max-words']) < 1 || Number(flags['--max-words']) > 20)) {
      invalid('cursor-overlay --max-words must be 1-20');
    }
    for (const msFlag of ['--travel-ms', '--dwell-ms']) {
      if (flags[msFlag] !== undefined && (!/^\d+$/.test(flags[msFlag]) || Number(flags[msFlag]) < 0 || Number(flags[msFlag]) > 10000)) {
        invalid(`cursor-overlay ${msFlag} must be 0-10000`);
      }
    }
    if (flags['--size'] !== undefined) {
      const sz = Number(flags['--size']);
      if (!Number.isFinite(sz) || sz < 0.25 || sz > 8) invalid('cursor-overlay --size must be between 0.25 and 8');
    }
    for (const colFlag of ['--fill', '--rim', '--accent']) {
      if (flags[colFlag] !== undefined && !/^#?[0-9a-fA-F]{6,8}$/.test(flags[colFlag])) {
        invalid(`cursor-overlay ${colFlag} must be a 6 or 8 digit hex color`);
      }
    }
  } else if (command === 'screenshot') {
    if (!flags['--app'] && !flags['--window-id'] && flags['--screen'] === undefined) invalid('Screenshot requires an explicit app, window ID, or screen');
    if (flags['--screen'] !== undefined && !/^\d+$/.test(flags['--screen'])) invalid('Screen index must be a nonnegative integer');
    if (positional.length > 1 || (positional.length && !path.isAbsolute(positional[0]))) invalid('Screenshot output must be an absolute path');
  } else if (positional.length) invalid('Unexpected positional desktop arguments');
  if (command === 'scroll') {
    if (flags['--direction'] && !['up', 'down', 'left', 'right'].includes(flags['--direction'])) invalid('scroll direction must be up, down, left, or right');
    if (flags['--amount'] && (!/^\d+$/.test(flags['--amount']) || Number(flags['--amount']) < 1 || Number(flags['--amount']) > 100)) invalid('scroll amount must be 1-100');
  }
  if (command === 'is' && flags['--property'] && !['visible', 'enabled', 'checked', 'focused', 'expanded', 'selected'].includes(flags['--property'])) {
    invalid('is --property must be visible, enabled, checked, focused, expanded, or selected');
  }
  if (command === 'clipboard-get' && flags['--out'] && !path.isAbsolute(flags['--out'])) {
    invalid('clipboard-get --out must be an absolute path');
  }
  if (command === 'resize-window') {
    const w = Number(flags['--width']), h = Number(flags['--height']);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 40 || h < 40 || w > 16384 || h > 16384) {
      invalid('resize-window requires --width and --height between 40 and 16384');
    }
  }
  if (command === 'move-window') {
    const x = Number(flags['--x']), y = Number(flags['--y']);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 32768 || Math.abs(y) > 32768) {
      invalid('move-window requires finite --x and --y coordinates');
    }
  }
  if (command === 'mouse-wheel') {
    if (!/^-?\d+$/.test(flags['--x'] || '') || !/^-?\d+$/.test(flags['--y'] || '')) {
      invalid('mouse-wheel requires finite integer --x and --y coordinates');
    }
    if (flags['--dy'] !== undefined && !/^-?\d+(?:\.\d+)?$/.test(flags['--dy'])) invalid('mouse-wheel --dy must be a finite number');
    if (flags['--dx'] !== undefined && !/^-?\d+(?:\.\d+)?$/.test(flags['--dx'])) invalid('mouse-wheel --dx must be a finite number');
  }
  if (['type', 'set-value'].includes(command)) {
    if (!flags['--stdin'] || typeof input !== 'string' || input.includes('\0')) invalid('Text must be supplied through stdin');
    if (Buffer.byteLength(input, 'utf8') > (command === 'type' ? 10000 : 128 * 1024)) invalid('Text exceeds the native stdin limit');
  } else if (command === 'clipboard-set') {
    const hasStdin = Boolean(flags['--stdin']);
    const hasImage = flags['--image'] !== undefined;
    const hasFileUrl = Array.isArray(flags['--file-url']) && flags['--file-url'].length > 0;
    if (Number(hasStdin) + Number(hasImage) + Number(hasFileUrl) !== 1) {
      invalid('clipboard-set requires exactly one of --stdin, --image, or --file-url');
    }
    if (hasStdin) {
      if (typeof input !== 'string' || input.includes('\0')) invalid('Text must be supplied through stdin');
      if (Buffer.byteLength(input, 'utf8') > 128 * 1024) invalid('Text exceeds the native stdin limit');
    } else {
      if (input !== undefined) invalid('clipboard-set with --image or --file-url does not accept stdin');
      if (hasImage && !path.isAbsolute(flags['--image'])) invalid('Clipboard image must be an absolute path');
      if (hasFileUrl && (flags['--file-url'].length > 32 || flags['--file-url'].some(p => !path.isAbsolute(p)))) {
        invalid('Clipboard file URLs must be 1 to 32 absolute paths');
      }
    }
  } else if (input !== undefined) invalid('This desktop command does not accept stdin');
  if (command === 'launch' && !path.isAbsolute(positional[0])) invalid('Launch requires an absolute executable path');
  if (command === 'press') {
    const normCombo = positional[0]
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/\b(?:meta|cmd|command|super)\b/g, 'win')
      .replace(/\boption\b/g, 'alt');
    if (/(?:^|\+)(?:alt\+f4|win\+l|ctrl\+alt\+(?:delete|del))(?:\+|$)/.test(normCombo)) {
      invalid('Dangerous shortcuts are not permitted');
    }
  }
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
  'list-displays': ['command'],
  'list-apps': ['command', 'app', 'timeoutMs'],
  'list-windows': ['command', 'app', 'timeoutMs'],
  'list-surfaces': ['command', 'app'],
  snapshot: ['command', 'app', 'windowId', 'surface', 'root', 'skeleton', 'interactiveOnly', 'compact', 'timeoutMs'],
  find: [
    'command', 'app', 'windowId', 'role', 'name', 'value', 'text', 'description', 'nativeId',
    'exact', 'surface', 'states', 'root', 'timeoutMs', 'count', 'first', 'last', 'nth', 'limit',
  ],
  get: ['command', 'ref', 'refId', 'property'],
  is: ['command', 'ref', 'refId', 'property'],
  click: ['command', 'ref', 'refId', 'timeoutMs'],
  'double-click': ['command', 'ref', 'refId', 'timeoutMs'],
  'right-click': ['command', 'ref', 'refId', 'timeoutMs'],
  clear: ['command', 'ref', 'refId', 'timeoutMs'],
  focus: ['command', 'ref', 'refId', 'timeoutMs'],
  select: ['command', 'ref', 'refId', 'value', 'timeoutMs'],
  toggle: ['command', 'ref', 'refId', 'timeoutMs'],
  check: ['command', 'ref', 'refId', 'timeoutMs'],
  uncheck: ['command', 'ref', 'refId', 'timeoutMs'],
  expand: ['command', 'ref', 'refId', 'timeoutMs'],
  collapse: ['command', 'ref', 'refId', 'timeoutMs'],
  scroll: ['command', 'ref', 'refId', 'direction', 'amount', 'timeoutMs'],
  'scroll-to': ['command', 'ref', 'refId', 'timeoutMs'],
  'set-value': ['command', 'ref', 'refId', 'value', 'timeoutMs'],
  type: ['command', 'ref', 'refId', 'text', 'value', 'intervalMs', 'timeoutMs'],
  press: ['command', 'combo', 'key', 'app', 'windowId'],
  hover: ['command', 'ref', 'refId', 'x', 'y', 'xy', 'windowId', 'timeoutMs'],
  'focus-window': ['command', 'app', 'windowId', 'title'],
  'resize-window': ['command', 'app', 'windowId', 'width', 'height'],
  'move-window': ['command', 'app', 'windowId', 'x', 'y'],
  minimize: ['command', 'app', 'windowId'],
  maximize: ['command', 'app', 'windowId'],
  restore: ['command', 'app', 'windowId'],
  'mouse-click': ['command', 'x', 'y', 'xy', 'button', 'count', 'windowId'],
  'mouse-wheel': ['command', 'x', 'y', 'dy', 'dx', 'windowId'],
  'clipboard-set': ['command', 'text', 'value', 'image', 'fileUrl', 'fileUrls', 'file_url'],
  'clipboard-get': ['command', 'format', 'out'],
  'clipboard-clear': ['command'],
  screenshot: ['command', 'app', 'windowId', 'screen', 'outputPath', 'path'],
  'open-system-surface': ['command', 'surface'],
  wait: ['command', 'ms', 'element', 'window', 'text', 'predicate', 'value', 'action', 'count', 'event', 'windowId', 'app', 'timeout', 'menu', 'menuClosed', 'notification'],
};

function assertStepKeys(step, allowed) {
  for (const key of Object.keys(step)) {
    if (!allowed.includes(key)) invalid(`Unsupported batch step field "${key}" for "${step.command}"`);
  }
}

const SIMPLE_REF_BATCH_COMMANDS = new Set([
  'click', 'double-click', 'right-click', 'clear', 'focus',
  'toggle', 'check', 'uncheck', 'expand', 'collapse', 'scroll-to',
]);

function normalizeBatchSteps(steps, config, defaultWindowId) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 64) {
    invalid('Desktop batch requires an array of 1 to 64 steps');
  }
  const items = [];
  const coordinateChecks = [];
  let anyMutating = false;
  let anyHeaded = false;
  let hasText = false;
  let priorWindowMutated = false;
  const assertCoordSafeAfterMutations = () => {
    if (priorWindowMutated) {
      throw safeDesktopError(
        'DESKTOP_TARGET_UNVERIFIED',
        'Coordinate input cannot follow a window focus, geometry, or shortcut mutation in the same batch; split into a second verified call',
      );
    }
  };

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step || typeof step !== 'object' || Array.isArray(step) || typeof step.command !== 'string') {
      invalid(`Batch step ${index} must be an object with a string command`);
    }
    const command = step.command;
    const allowedKeys = Object.hasOwn(ALLOWED_STEP_KEYS, command) ? ALLOWED_STEP_KEYS[command] : null;
    if (!allowedKeys) throw safeDesktopError('DESKTOP_COMMAND_BLOCKED', `Batch command "${command}" is not in the guarded command allowlist`);
    assertStepKeys(step, allowedKeys);

    if (command === 'wait' && step.ms !== undefined && Object.keys(step).length === 2) {
      if (!Number.isInteger(step.ms) || step.ms < 1 || step.ms > 30000) {
        invalid('Batch wait requires an integer ms from 1 to 30000');
      }
      items.push({
        command: 'wait',
        cliArgs: ['wait', String(step.ms)],
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
      if (step.timeoutMs !== undefined) { cliArgs.push(`--timeout-ms=${String(step.timeoutMs)}`); batchArgs.timeout_ms = Number(step.timeoutMs); }
    } else if (command === 'list-surfaces') {
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
      for (const [jsKey, cliFlag, serdeKey] of [
        ['role', '--role', 'role'],
        ['name', '--name', 'name'],
        ['value', '--value', 'value'],
        ['text', '--text', 'text'],
        ['description', '--description', 'description'],
        ['nativeId', '--native-id', 'native_id'],
        ['surface', '--surface', 'surface'],
        ['root', '--root', 'root'],
      ]) {
        if (step[jsKey] !== undefined) {
          cliArgs.push(`${cliFlag}=${String(step[jsKey])}`);
          batchArgs[serdeKey] = String(step[jsKey]);
        }
      }
      if (Array.isArray(step.states) && step.states.length) {
        for (const st of step.states) cliArgs.push(`--state=${String(st)}`);
        batchArgs.states = step.states.map(String);
      }
      if (step.exact) { cliArgs.push('--exact'); batchArgs.exact = true; }
      if (step.count) { cliArgs.push('--count'); batchArgs.count = true; }
      if (step.first) { cliArgs.push('--first'); batchArgs.first = true; }
      if (step.last) { cliArgs.push('--last'); batchArgs.last = true; }
      if (step.nth !== undefined) { cliArgs.push(`--nth=${String(step.nth)}`); batchArgs.nth = Number(step.nth); }
      if (step.limit !== undefined) { cliArgs.push(`--limit=${String(step.limit)}`); batchArgs.limit = Number(step.limit); }
      if (step.timeoutMs !== undefined) { cliArgs.push(`--timeout-ms=${String(step.timeoutMs)}`); batchArgs.timeout_ms = Number(step.timeoutMs); }
    } else if (command === 'get' || command === 'is') {
      const prop = step.property ?? (command === 'is' ? 'visible' : 'text');
      cliArgs.push(String(refVal ?? ''), `--property=${String(prop)}`);
      batchArgs.ref_id = String(refVal ?? '');
      batchArgs.property = String(prop);
    } else if (SIMPLE_REF_BATCH_COMMANDS.has(command)) {
      cliArgs.push(String(refVal ?? ''));
      batchArgs.ref_id = String(refVal ?? '');
      if (step.timeoutMs !== undefined) { cliArgs.push(`--timeout-ms=${String(step.timeoutMs)}`); batchArgs.timeout_ms = Number(step.timeoutMs); }
    } else if (command === 'select') {
      cliArgs.push(String(refVal ?? ''), String(step.value ?? ''));
      batchArgs.ref_id = String(refVal ?? '');
      batchArgs.value = String(step.value ?? '');
      if (step.timeoutMs !== undefined) { cliArgs.push(`--timeout-ms=${String(step.timeoutMs)}`); batchArgs.timeout_ms = Number(step.timeoutMs); }
    } else if (command === 'scroll') {
      cliArgs.push(String(refVal ?? ''));
      batchArgs.ref_id = String(refVal ?? '');
      if (step.direction !== undefined) { cliArgs.push(`--direction=${String(step.direction)}`); batchArgs.direction = String(step.direction); }
      if (step.amount !== undefined) { cliArgs.push(`--amount=${String(step.amount)}`); batchArgs.amount = Number(step.amount); }
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
    } else if (command === 'hover') {
      if (refVal !== undefined) {
        cliArgs.push(String(refVal));
        batchArgs.ref_id = String(refVal);
      } else {
        assertCoordSafeAfterMutations();
        const xyStr = step.xy !== undefined
          ? String(step.xy)
          : ([step.x, step.y].every(Number.isFinite) ? `${Math.round(step.x)},${Math.round(step.y)}` : '');
        cliArgs.push(`--xy=${xyStr}`);
        batchArgs.xy = xyStr;
        coordinateChecks.push({ xy: xyStr, windowId: step.windowId ?? defaultWindowId });
      }
      if (step.timeoutMs !== undefined) { cliArgs.push(`--timeout-ms=${String(step.timeoutMs)}`); batchArgs.timeout_ms = Number(step.timeoutMs); }
    } else if (command === 'focus-window') {
      addScope();
      if (step.title !== undefined) { cliArgs.push(`--title=${String(step.title)}`); batchArgs.title = String(step.title); }
    } else if (command === 'minimize' || command === 'maximize' || command === 'restore') {
      addScope();
    } else if (command === 'resize-window') {
      addScope();
      if (step.width !== undefined) { cliArgs.push(`--width=${String(step.width)}`); batchArgs.width = Number(step.width); }
      if (step.height !== undefined) { cliArgs.push(`--height=${String(step.height)}`); batchArgs.height = Number(step.height); }
    } else if (command === 'move-window') {
      addScope();
      if (step.x !== undefined) { cliArgs.push(`--x=${String(step.x)}`); batchArgs.x = Number(step.x); }
      if (step.y !== undefined) { cliArgs.push(`--y=${String(step.y)}`); batchArgs.y = Number(step.y); }
    } else if (command === 'mouse-click') {
      assertCoordSafeAfterMutations();
      const xyStr = step.xy !== undefined
        ? String(step.xy)
        : ([step.x, step.y].every(Number.isFinite) ? `${Math.round(step.x)},${Math.round(step.y)}` : '');
      cliArgs.push(`--xy=${xyStr}`);
      batchArgs.xy = xyStr;
      if (step.button !== undefined) { cliArgs.push(`--button=${String(step.button)}`); batchArgs.button = String(step.button); }
      if (step.count !== undefined) { cliArgs.push(`--count=${String(step.count)}`); batchArgs.count = Number(step.count); }
      coordinateChecks.push({ xy: xyStr, windowId: step.windowId ?? defaultWindowId });
    } else if (command === 'mouse-wheel') {
      assertCoordSafeAfterMutations();
      const rx = Number.isFinite(step.x) ? Math.round(step.x) : NaN;
      const ry = Number.isFinite(step.y) ? Math.round(step.y) : NaN;
      cliArgs.push(`--x=${String(rx)}`, `--y=${String(ry)}`);
      batchArgs.x = rx;
      batchArgs.y = ry;
      if (step.dy !== undefined) { cliArgs.push(`--dy=${String(step.dy)}`); batchArgs.dy = Number(step.dy); }
      if (step.dx !== undefined) { cliArgs.push(`--dx=${String(step.dx)}`); batchArgs.dx = Number(step.dx); }
      coordinateChecks.push({ xy: `${rx},${ry}`, windowId: step.windowId ?? defaultWindowId });
    } else if (command === 'clipboard-get') {
      if (step.format !== undefined) { cliArgs.push(`--format=${String(step.format)}`); batchArgs.format = String(step.format); }
      if (step.out !== undefined) { cliArgs.push(`--out=${String(step.out)}`); batchArgs.out = String(step.out); }
    } else if (command === 'clipboard-set') {
      const hasImage = step.image !== undefined;
      const rawFiles = step.fileUrls ?? step.fileUrl ?? step.file_url;
      const hasFiles = rawFiles !== undefined;
      const hasTextVal = step.text !== undefined || step.value !== undefined;
      if (Number(hasImage) + Number(hasFiles) + Number(hasTextVal) !== 1) {
        invalid('Batch clipboard-set requires exactly one of text/value, image, or fileUrls');
      }
      if (hasImage) {
        const imgPath = String(step.image);
        cliArgs.push(`--image=${imgPath}`);
        batchArgs.image = imgPath;
        stepHasText = true;
      } else if (hasFiles) {
        const urls = Array.isArray(rawFiles) ? rawFiles : [rawFiles];
        if (!urls.length) invalid('Batch clipboard-set fileUrls must not be empty');
        for (const u of urls) cliArgs.push(`--file-url=${String(u)}`);
        batchArgs.file_url = urls.map(String);
        stepHasText = true;
      } else {
        const val = step.text !== undefined ? step.text : step.value;
        cliArgs.push('--stdin');
        cliInput = val;
        stepHasText = true;
        batchArgs.text = val;
      }
    } else if (command === 'screenshot') {
      addScope();
      if (step.screen !== undefined) { cliArgs.push(`--screen=${String(step.screen)}`); batchArgs.screen = Number(step.screen); }
      const outPath = step.outputPath ?? step.path;
      if (outPath !== undefined) { cliArgs.push(String(outPath)); batchArgs.output_path = String(outPath); }
    } else if (command === 'open-system-surface') {
      if (step.surface !== undefined) { cliArgs.push(`--surface=${String(step.surface)}`); batchArgs.surface = String(step.surface); }
    } else if (command === 'wait') {
      if (step.ms !== undefined) { cliArgs.push(String(step.ms)); batchArgs.ms = Number(step.ms); }
      for (const [jsKey, cliFlag, serdeKey] of [
        ['element', '--element', 'element'],
        ['window', '--window', 'window'],
        ['text', '--text', 'text'],
        ['predicate', '--predicate', 'predicate'],
        ['value', '--value', 'value'],
        ['action', '--action', 'action'],
        ['event', '--event', 'event'],
        ['windowId', '--window-id', 'window_id'],
        ['app', '--app', 'app'],
      ]) {
        if (step[jsKey] !== undefined) { cliArgs.push(`${cliFlag}=${String(step[jsKey])}`); batchArgs[serdeKey] = String(step[jsKey]); }
      }
      if (step.count !== undefined) { cliArgs.push(`--count=${String(step.count)}`); batchArgs.count = Number(step.count); }
      if (step.timeout !== undefined) { cliArgs.push(`--timeout=${String(step.timeout)}`); batchArgs.timeout = Number(step.timeout); }
      if (step.menu) { cliArgs.push('--menu'); batchArgs.menu = true; }
      if (step.menuClosed) { cliArgs.push('--menu-closed'); batchArgs.menu_closed = true; }
      if (step.notification) { cliArgs.push('--notification'); batchArgs.notification = true; }
    }

    const validated = validateCommand(cliArgs, cliInput, config);
    const headed = HEADED_COMMANDS.has(command);
    if (validated.mutating) anyMutating = true;
    if (headed) anyHeaded = true;
    if (stepHasText) hasText = true;
    if (WINDOW_STATE_MUTATORS.has(command)) priorWindowMutated = true;
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

module.exports = {
  validateCommand,
  normalizeBatchSteps,
  text,
  qualifiedRef,
  READS,
  FOREGROUND,
  HEADED_COMMANDS,
};
