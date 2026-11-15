const path = require('node:path');
const { desktopError } = require('./agentDesktopProcess');

const SCHEMAS = {
  status: {}, version: {}, 'list-apps': { '--app': 'value' }, 'list-windows': { '--app': 'value' },
  snapshot: { '--app': 'value', '--window-id': 'value', '--surface': 'value', '--root': 'value', '--skeleton': 'flag', '-i': 'flag', '--compact': 'flag', '--timeout-ms': 'value' },
  find: { '--app': 'value', '--window-id': 'value', '--role': 'value', '--name': 'value', '--root': 'value', '--timeout-ms': 'value' },
  get: { '--property': 'value' }, click: { '--timeout-ms': 'value' }, 'set-value': { '--stdin': 'flag', '--timeout-ms': 'value' },
  type: { '--stdin': 'flag', '--interval-ms': 'value', '--timeout-ms': 'value' }, press: { '--app': 'value', '--window-id': 'value' },
  'focus-window': { '--app': 'value', '--window-id': 'value' }, launch: { '--arg': 'repeat' }, 'close-app': {},
  'mouse-click': { '--xy': 'value', '--button': 'value', '--count': 'value' }, 'clipboard-set': { '--stdin': 'flag' }, 'clipboard-get': {},
  screenshot: { '--app': 'value', '--window-id': 'value', '--screen': 'value' },
  'open-system-surface': { '--surface': 'value' },
  restore: { '--app': 'value', '--window-id': 'value' },
};
const READS = new Set(['status', 'version', 'list-apps', 'list-windows', 'snapshot', 'find', 'get', 'screenshot', 'clipboard-get']);
const FOREGROUND = new Set(['type', 'press', 'focus-window', 'launch', 'close-app', 'mouse-click', 'clipboard-set', 'open-system-surface', 'restore']);
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

module.exports = { validateCommand, text, qualifiedRef };
