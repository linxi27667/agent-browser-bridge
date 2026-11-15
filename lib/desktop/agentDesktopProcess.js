const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function desktopError(code, message, mutating = false) {
  const error = new Error(message);
  error.code = code;
  error.disposition = mutating ? { delivery: 'unknown', retry: 'unsafe' } : { delivery: 'not_delivered', retry: 'safe' };
  return error;
}

function positiveInteger(value, name, maximum = 300000) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw desktopError('INVALID_ARGS', `${name} must be an integer from 1 to ${maximum}`);
  return value;
}

async function resolveBinary(options) {
  const override = options.binaryPath || process.env.AGENT_DESKTOP_BIN;
  if (override) {
    if (!path.isAbsolute(override) || /\.(cmd|bat)$/i.test(override)) throw desktopError('INVALID_ARGS', 'Desktop binary must be an absolute executable path, not a shell script');
    try { if ((await fs.promises.stat(override)).isFile()) return override; } catch {}
    throw desktopError('AGENT_DESKTOP_NOT_FOUND', 'Configured agent-desktop executable does not exist');
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const native = process.platform === 'win32' ? `agent-desktop-win32-${arch}.exe` : `agent-desktop-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${arch}`;
  const directories = [...new Set([
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean), path.dirname(process.execPath),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), process.env.npm_config_prefix, process.env.NPM_CONFIG_PREFIX,
  ].filter(Boolean))];
  for (const directory of directories) {
    for (const candidate of [path.join(directory, process.platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop'), path.join(directory, native),
      path.join(directory, 'node_modules', 'agent-desktop', 'bin', native), path.join(directory, '..', 'lib', 'node_modules', 'agent-desktop', 'bin', native)]) {
      try { if ((await fs.promises.stat(candidate)).isFile() && !/\.(cmd|bat)$/i.test(candidate)) return path.resolve(candidate); } catch {}
    }
  }
  throw desktopError('AGENT_DESKTOP_NOT_FOUND', 'agent-desktop was not found; configure AGENT_DESKTOP_BIN or binaryPath');
}

function safeRecovery(recovery) {
  if (!recovery || typeof recovery !== 'object') return undefined;
  const result = {};
  if (['inspect_state_then_retry_original', 'refresh_snapshot_then_retry_original', 'request_explicit_policy_then_retry_original', 'observe_only'].includes(recovery.strategy)) result.strategy = recovery.strategy;
  for (const key of ['retryable', 'requires_fresh_snapshot']) if (typeof recovery[key] === 'boolean') result[key] = recovery[key];
  if (Number.isSafeInteger(recovery.retry_after_ms) && recovery.retry_after_ms >= 0) result.retry_after_ms = recovery.retry_after_ms;
  return Object.keys(result).length ? result : undefined;
}

function parseEnvelope(stdout, stderr, code, input, mutating) {
  let envelope;
  try { envelope = JSON.parse(stdout.trim() || stderr.trim()); } catch {}
  if (!envelope || typeof envelope.ok !== 'boolean') throw desktopError('AGENT_DESKTOP_PROTOCOL_ERROR', 'agent-desktop did not return a JSON envelope', mutating);
  if (!envelope.ok || code !== 0) {
    const original = envelope.error;
    const error = desktopError(original?.code || 'AGENT_DESKTOP_ERROR', input
      ? 'agent-desktop command failed while processing stdin text'
      : (original?.message || 'agent-desktop command failed'), mutating);
    if (original?.disposition) error.disposition = original.disposition;
    if (original?.recovery) error.recovery = input ? safeRecovery(original.recovery) : original.recovery;
    if (input) {
      error.raw = { ok: false, error: { code: error.code, message: error.message, disposition: error.disposition, recovery: error.recovery } };
    } else {
      for (const field of ['suggestion', 'details', 'platform_detail']) if (original?.[field] !== undefined) error[field] = original[field];
      error.raw = envelope;
    }
    throw error;
  }
  if (!Object.hasOwn(envelope, 'data')) throw desktopError('AGENT_DESKTOP_PROTOCOL_ERROR', 'agent-desktop response is missing data', mutating);
  return envelope.data;
}

async function execute(binary, prefix, args, options, mutating) {
  const timeoutMs = positiveInteger(options.timeoutMs, 'timeoutMs');
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, 'maxOutputBytes', 64 * 1024 * 1024);
  const signal = options.signal;
  if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw desktopError('INVALID_ARGS', 'signal must be an AbortSignal');
  if (signal?.aborted) throw desktopError('DESKTOP_ABORTED', 'Desktop command was cancelled before delivery');
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(binary, [...prefix, ...args], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.desktopHome ? { env: { ...process.env, AGENT_DESKTOP_HOME: options.desktopHome } } : {}),
    }); }
    catch { reject(desktopError('AGENT_DESKTOP_NOT_FOUND', 'Unable to start agent-desktop')); return; }
    const stdout = [], stderr = [];
    let bytes = 0, stopped = null, forceTimer = null;
    const stop = code => {
      if (stopped) return;
      stopped = desktopError(code, {
        DESKTOP_TIMEOUT: 'Desktop command timed out; inspect current state before retrying',
        DESKTOP_ABORTED: 'Desktop command was cancelled; inspect current state before retrying',
        DESKTOP_OUTPUT_LIMIT: 'Desktop command exceeded its output limit',
      }[code], mutating);
      child.kill();
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      forceTimer.unref();
    };
    const timer = setTimeout(() => stop('DESKTOP_TIMEOUT'), timeoutMs);
    const abort = () => stop('DESKTOP_ABORTED');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const collect = destination => chunk => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop('DESKTOP_OUTPUT_LIMIT');
      if (!stopped) destination.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', () => {});
    child.on('error', () => { stopped ||= desktopError('AGENT_DESKTOP_NOT_FOUND', 'Unable to start agent-desktop'); });
    child.on('close', code => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      if (stopped) { reject(stopped); return; }
      try { resolve(parseEnvelope(Buffer.concat(stdout).toString('utf8'), Buffer.concat(stderr).toString('utf8'), code, options.input, mutating)); }
      catch (error) { reject(error); }
    });
    child.stdin.end(options.input || '');
  });
}

module.exports = { desktopError, positiveInteger, resolveBinary, execute };
