function fail(code, message, disposition = { delivery: 'not_delivered', retry: 'safe' }) {
  const error = new Error(message);
  error.code = code;
  error.disposition = disposition;
  error.safeMessage = message;
  return error;
}

function normalizeOptions(options = {}) {
  const mode = options.mode ?? 'cooperative';
  const readOnly = options.readOnly ?? true;
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!['cooperative', 'exclusive'].includes(mode)) throw fail('INVALID_ARGS', 'Mode must be cooperative or exclusive');
  if (typeof readOnly !== 'boolean') throw fail('INVALID_ARGS', 'readOnly must be boolean');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw fail('INVALID_ARGS', 'timeoutMs must be an integer from 1 to 300000');
  return { ...options, mode, readOnly, timeoutMs };
}

function serializeError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'AUTOMATION_FAILED';
  return {
    code,
    message: error?.safeMessage || `Operation failed (${code}); no automatic retry was performed`,
    disposition: error?.disposition || { delivery: 'unknown', retry: 'unsafe' },
  };
}

module.exports = { fail, normalizeOptions, serializeError };
