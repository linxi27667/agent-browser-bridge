const { fail } = require('./errors');

function createBrowser(policy, dependency) {
  const load = () => dependency || require('../cdp');

  async function configured() {
    const cdp = load();
    const config = cdp.resolveConfig();
    if (!config.strict || !config.profile || !config.browser || !config.proxy) {
      throw fail('BROWSER_NOT_CONFIGURED', 'Configure a strict dedicated browser identity before browser operations');
    }
    if (config.attachExisting) throw fail('POLICY_DENIED', 'The unified entry only supports a dedicated browser profile');
    await cdp.identity.verify();
    return { cdp, config };
  }

  function wrap(page, cdp) {
    const methods = {};
    const reads = ['snapshot', 'snapshotText', 'readUnique', 'waitForSelector'];
    // CDP keys address only the leased page; autoUiLock is disabled in cooperative mode.
    const semantic = ['fillNative', 'clickNative', 'selectOption', 'pressKey'];
    const foreground = ['clickByBox', 'dragByBox', 'capturePagePng', 'captureUniquePng'];
    for (const name of [...reads, ...semantic, ...foreground]) {
      methods[name] = async (...args) => {
        policy.signal?.throwIfAborted();
        if (semantic.includes(name) || ['clickByBox', 'dragByBox', 'pressKey'].includes(name)) {
          if (policy.readOnly) throw fail('READ_ONLY_BLOCKED', 'This browser action requires an explicitly writable task');
        }
        if (foreground.includes(name) && policy.mode !== 'exclusive') {
          throw fail('FOREGROUND_REQUIRED', 'This browser action requires exclusive mode');
        }
        const invoke = () => cdp[name](page, ...args);
        if (semantic.includes(name) && policy.mode === 'cooperative') {
          return cdp.withUiLock(invoke, { port: page.port, timeoutMs: policy.timeoutMs });
        }
        return invoke();
      };
    }
    methods.hover = async (selector, guard) => {
      if (policy.readOnly) throw fail('READ_ONLY_BLOCKED', 'Page hover requires an explicitly writable task');
      if (typeof selector !== 'string' || !selector.trim() || typeof guard !== 'string' || !guard.trim()) {
        throw fail('INVALID_ARGS', 'Page hover requires a selector and context guard');
      }
      policy.signal?.throwIfAborted();
      return cdp.withUiLock(async () => {
        const query = cdp.buildFindElementsExpression(page, selector);
        const point = await page.evalChecked('(()=>{if(!(' + guard + '))throw Error("Context guard failed before hover");const es=' + query + ';if(es.length!==1)throw Error("Hover target must be unique; matched "+es.length);const r=es[0].getBoundingClientRect();if(r.width<1||r.height<1)throw Error("Hover target unavailable");return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw fail('INVALID_TARGET', 'Page hover did not resolve a finite target point');
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
        if (!await page.evalChecked(guard)) throw fail('CONTEXT_CHANGED', 'Page context changed after hover', { delivery: 'unknown', retry: 'unsafe' });
        return { hovered: true };
      }, { port: page.port, timeoutMs: policy.timeoutMs });
    };
    return Object.freeze(methods);
  }

  async function lease(kind, criteria, callback) {
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria) || typeof callback !== 'function') {
      throw fail('INVALID_ARGS', 'Browser lease requires explicit target options and a callback');
    }
    if (kind === 'withDedicatedTab' && (typeof criteria.url !== 'string' || !criteria.url.trim())) {
      throw fail('INVALID_ARGS', 'A dedicated tab requires an explicit URL');
    }
    for (const key of ['readOnly', 'autoUiLock', 'background', 'activate', 'keepOpen', 'closeOnExit', 'forceNavigate', 'heartbeat']) {
      if (Object.hasOwn(criteria, key)) throw fail('POLICY_DENIED', `Browser lease option ${key} is controlled by the task`);
    }
    if (criteria.newTab || criteria.newWindow || criteria.reuseExisting === false || criteria.onLeased === 'newTab') {
      throw fail('POLICY_DENIED', 'The task entry preserves same-site tab reuse and serial ownership');
    }
    for (const key of ['ttlMs', 'leaseWaitMs']) {
      if (criteria[key] !== undefined && (!Number.isInteger(criteria[key]) || criteria[key] < (key === 'ttlMs' ? 1000 : 0) || criteria[key] > 300000)) {
        throw fail('INVALID_ARGS', 'Browser lease timing must be a bounded integer');
      }
    }
    policy.signal?.throwIfAborted();
    const { cdp, config } = await configured();
    if (criteria.port !== undefined && criteria.port !== config.port) throw fail('POLICY_DENIED', 'Browser lease port must match the configured identity');
    const options = {
      ...criteria,
      port: config.port,
      readOnly: policy.readOnly,
      autoUiLock: policy.mode === 'exclusive',
      background: policy.mode === 'cooperative',
      activate: policy.mode === 'exclusive',
      onForeignAttach: 'fail',
      heartbeat: true,
      leaseWaitMs: Math.min(criteria.leaseWaitMs ?? policy.timeoutMs, policy.timeoutMs),
    };
    if (/^https?:/i.test(criteria.url || criteria.exactUrl || '')) {
      options.keepOpen = true;
      options.closeOnExit = false;
    }
    const run = async page => callback(wrap(page, cdp));
    return kind === 'withLeasedTarget'
      ? cdp.withLeasedTarget(criteria, options, run)
      : cdp.withDedicatedTab(options, run);
  }

  return Object.freeze({
    withDedicatedTab: (options, callback) => lease('withDedicatedTab', options, callback),
    withLeasedTarget: (options, callback) => lease('withLeasedTarget', options, callback),
  });
}

module.exports = { createBrowser };
