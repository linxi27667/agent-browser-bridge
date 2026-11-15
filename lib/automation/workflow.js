const path = require('node:path');
const { fail, normalizeOptions, serializeError } = require('./errors');

async function exclusiveLock(options, callback) {
  options.signal?.throwIfAborted();
  if (options.mode !== 'exclusive') return callback(() => {}, options.signal);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const locks = require('../cdp/concurrency');
  const root = options.lockDir || locks.resolveLockDir();
  require('node:fs').mkdirSync(root, { recursive: true });
  const handle = locks.createFileLock(path.join(root, 'automation-exclusive.lock'), {
    ttlMs: 30000, resource: 'automation-exclusive', ownerTag: 'workflow',
  });
  if (!handle) {
    options.signal?.removeEventListener('abort', forwardAbort);
    throw fail('AUTOMATION_BUSY', 'Another exclusive automation task is running');
  }
  const heartbeat = setInterval(() => {
    if (!handle.renew(30000)) controller.abort(fail('AUTOMATION_LEASE_LOST', 'Exclusive task ownership was lost', { delivery: 'unknown', retry: 'unsafe' }));
  }, 5000);
  heartbeat.unref();
  try {
    return await callback(() => { controller.signal.throwIfAborted(); handle.assertHeld(); }, controller.signal);
  } finally {
    clearInterval(heartbeat);
    options.signal?.removeEventListener('abort', forwardAbort);
    handle.release();
  }
}

async function runWorkflow(workflow, options = {}, dependencies = {}) {
  if (typeof workflow !== 'function') throw fail('INVALID_ARGS', 'Workflow must export a trusted JavaScript function');
  const policy = normalizeOptions(options);
  const started = Date.now();
  const report = { ok: true, status: 'unverified', steps: [], durationMs: 0 };
  let running = false;
  const pending = new Set();
  let stepFailure;
  try {
    return await exclusiveLock(policy, async (assertHeld, signal) => {
      const automation = require('./index').createAutomation({ ...policy, signal }, dependencies);
      const executeStep = async (name, action, verify) => {
        if (stepFailure) throw fail('WORKFLOW_STOPPED', 'A previous step failed; inspect the result before starting another step', { delivery: 'unknown', retry: 'unsafe' });
        if (running) throw fail('WORKFLOW_CONCURRENCY', 'Workflow steps must be awaited and run serially');
        if (typeof name !== 'string' || !name.trim() || name.length > 120 || typeof action !== 'function' || (verify !== undefined && typeof verify !== 'function')) {
          throw fail('INVALID_ARGS', 'A step needs a short name, an action, and an optional verifier');
        }
        signal?.throwIfAborted();
        assertHeld();
        if (verify === undefined) {
          const unverifiedEntry = { name, status: 'unverified', durationMs: 0 };
          report.steps.push(unverifiedEntry);
          const unverifiedError = fail('STEP_UNVERIFIED', 'The step has no verifier; pass a verify function before executing', { delivery: 'not_delivered', retry: 'safe' });
          unverifiedEntry.error = serializeError(unverifiedError);
          stepFailure = unverifiedError;
          throw unverifiedError;
        }
        running = true;
        const entry = { name, status: 'running', durationMs: 0 };
        const stepStarted = Date.now();
        report.steps.push(entry);
        try {
          const value = await action();
          if (value?.disposition?.delivery) entry.delivery = value.disposition.delivery;
          signal?.throwIfAborted();
          assertHeld();
          if (await verify(value) === true) {
            entry.status = 'verified';
          } else {
            throw fail('VERIFICATION_FAILED', 'The step postcondition was not verified', value?.disposition || { delivery: 'unknown', retry: 'unsafe' });
          }
          return value;
        } catch (error) {
          if (entry.status !== 'unverified') entry.status = 'failed';
          entry.error = serializeError(error);
          stepFailure = error;
          throw error;
        } finally {
          running = false;
          entry.durationMs = Date.now() - stepStarted;
        }
      };
      const step = (...args) => {
        const task = executeStep(...args).catch(error => { stepFailure ||= error; throw error; });
        pending.add(task);
        task.finally(() => pending.delete(task)).catch(() => {});
        return task;
      };
      try {
        signal?.throwIfAborted();
        await workflow(Object.freeze({ ...automation, step, signal }));
        if (pending.size) {
          await Promise.allSettled([...pending]);
          throw fail('WORKFLOW_CONCURRENCY', 'A workflow returned before its step finished', { delivery: 'unknown', retry: 'unsafe' });
        }
        if (stepFailure) throw stepFailure;
      } finally {
        await Promise.allSettled([...pending]);
      }
      assertHeld();
      signal?.throwIfAborted();
      report.status = report.steps.length && report.steps.every(s => s.status === 'verified') ? 'verified' : 'unverified';
      report.durationMs = Date.now() - started;
      return report;
    });
  } catch (error) {
    report.ok = false;
    report.status = error?.code === 'STEP_UNVERIFIED' ? 'unverified' : 'failed';
    report.durationMs = Date.now() - started;
    const failure = error instanceof Error ? error : fail('AUTOMATION_FAILED', 'Workflow execution failed', { delivery: 'unknown', retry: 'unsafe' });
    failure.report = report;
    throw failure;
  }
}

module.exports = { runWorkflow, exclusiveLock };
