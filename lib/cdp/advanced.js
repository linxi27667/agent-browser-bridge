// AgentBrowserBridge - Ego-Lite 独有高级能力集 (lib/cdp/advanced.js)
// 融合 citrolabs/ego-lite 的四大高阶引擎：
// 1. 原生 JS 弹窗防卡死拦截器 (enableDialogGuard / getDialogs) —— 防止 alert/confirm/beforeunload 锁死 CDP 渲染线程
// 2. 全链路环形缓冲可观测引擎 (enableObserve / readDiagnostics) —— 自动采集 Console 报错、未捕获异常、HTTP >=400 失败请求
// 3. 智能 DOM 静止与网络空闲等待 (waitForDomSettled / waitForNetworkIdle) —— 动态表格/SPA 异步刷新精准同步
// 4. 受控文件下载闭环追踪器 (waitForDownload) —— 基于 CDP Browser.setDownloadBehavior 精确捕获下载完成事件与文件路径

const fs = require('node:fs');
const path = require('node:path');
const { sleep } = require('./client');
const { emitHudNonBlocking } = require('./hud');

function sanitizeUrlForDiagnostics(rawUrl, redactQuery = true) {
  const s = String(rawUrl || '');
  if (!redactQuery) return s;
  try {
    const u = new URL(s);
    return u.origin + u.pathname + (u.search ? '?[redacted]' : '');
  } catch {
    const qIdx = s.indexOf('?');
    return qIdx !== -1 ? s.slice(0, qIdx) + '?[redacted]' : s;
  }
}

function pushBounded(arr, item, max = 100) {
  arr.push(item);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
}

/**
 * 1. 原生 JS 弹窗防卡死门禁 (Native JavaScript Dialog Guard)
 * 监听 Page.javascriptDialogOpening，自动记录弹窗并按策略响应，防止 alert/confirm/beforeunload 永久阻塞后续 evalChecked。
 */
async function enableDialogGuard(cdp, options = {}) {
  if (!cdp || typeof cdp.on !== 'function' || typeof cdp.send !== 'function') {
    throw new Error('enableDialogGuard requires a valid CDP session');
  }
  if (!Array.isArray(cdp._dialogs)) {
    cdp._dialogs = [];
  }
  if (cdp._dialogGuardUnsub) {
    cdp._dialogGuardUnsub();
  }

  try {
    await cdp.send('Page.enable');
  } catch {}

  const maxDialogs = Math.max(10, Number(options.maxEntries) || 50);
  const unsub = cdp.on('Page.javascriptDialogOpening', async (params = {}) => {
    const type = String(params.type || 'alert');
    const message = String(params.message || '');
    const defaultPrompt = params.defaultPrompt !== undefined ? String(params.defaultPrompt) : undefined;
    let accept = type === 'alert' || type === 'beforeunload';
    let promptText = undefined;

    if (typeof options.onDialog === 'function') {
      try {
        const decision = await options.onDialog({ type, message, defaultPrompt, url: params.url });
        if (typeof decision === 'boolean') {
          accept = decision;
        } else if (decision && typeof decision === 'object') {
          if (typeof decision.accept === 'boolean') accept = decision.accept;
          if (typeof decision.promptText === 'string') promptText = decision.promptText;
        }
      } catch {}
    } else if (type === 'confirm') {
      accept = Boolean(options.acceptConfirm);
    } else if (type === 'prompt') {
      accept = Boolean(options.acceptPrompt);
      if (typeof options.promptText === 'string') promptText = options.promptText;
    }

    const record = {
      type,
      message,
      defaultPrompt,
      url: sanitizeUrlForDiagnostics(params.url, options.redactQuery !== false),
      accept,
      promptText,
      timestamp: Date.now(),
    };
    pushBounded(cdp._dialogs, record, maxDialogs);

    emitHudNonBlocking(cdp, {
      badge: '弹窗拦截',
      tone: 'warn',
      text: `已自动处理 ${type}: ${message.slice(0, 60)}`,
      durationMs: 3200,
    });

    try {
      const payload = { accept };
      if (promptText !== undefined) payload.promptText = promptText;
      await cdp.send('Page.handleJavaScriptDialog', payload);
    } catch {}
  });

  cdp._dialogGuardUnsub = unsub;
  return {
    enabled: true,
    dialogs: cdp._dialogs,
    disable() {
      unsub();
      cdp._dialogGuardUnsub = null;
    },
  };
}

function getDialogs(cdp, { clear = false } = {}) {
  if (!cdp || !Array.isArray(cdp._dialogs)) return [];
  const copy = [...cdp._dialogs];
  if (clear) cdp._dialogs.length = 0;
  return copy;
}

/**
 * 2. 页面全链路可观测环形缓冲 (Observe Ring Buffer: Console / Exceptions / Failed HTTP / In-Flight Requests)
 */
async function enableObserve(cdp, options = {}) {
  if (!cdp || typeof cdp.on !== 'function' || typeof cdp.send !== 'function') {
    throw new Error('enableObserve requires a valid CDP session');
  }
  if (cdp._observe && cdp._observe.enabled) {
    return cdp._observe;
  }

  const maxEntries = Math.max(10, Number(options.maxEntries) || 100);
  const redactQuery = options.redactQuery !== false;
  const state = {
    enabled: true,
    console: [],
    exceptions: [],
    networkFailures: [],
    inFlightRequests: new Map(),
    lastNetworkActivityAt: Date.now(),
    unsubscribers: [],
  };

  try { await cdp.send('Runtime.enable'); } catch {}
  try { await cdp.send('Network.enable'); } catch {}

  state.unsubscribers.push(
    cdp.on('Runtime.consoleAPICalled', (params = {}) => {
      const type = String(params.type || 'log');
      if (options.errorsOnly && type !== 'error' && type !== 'warning') return;
      const text = (params.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type || ''))
        .join(' ')
        .slice(0, 500);
      pushBounded(state.console, { type, text, timestamp: Date.now() }, maxEntries);
    })
  );

  state.unsubscribers.push(
    cdp.on('Runtime.exceptionThrown', (params = {}) => {
      const details = params.exceptionDetails || {};
      const text = String(details.exception?.description || details.text || 'Uncaught exception').slice(0, 500);
      pushBounded(
        state.exceptions,
        {
          text,
          url: sanitizeUrlForDiagnostics(details.url, redactQuery),
          lineNumber: details.lineNumber,
          columnNumber: details.columnNumber,
          timestamp: Date.now(),
        },
        maxEntries
      );
    })
  );

  state.unsubscribers.push(
    cdp.on('Network.requestWillBeSent', (params = {}) => {
      if (!params.requestId) return;
      state.lastNetworkActivityAt = Date.now();
      state.inFlightRequests.set(params.requestId, {
        url: sanitizeUrlForDiagnostics(params.request?.url, redactQuery),
        method: params.request?.method || 'GET',
        type: params.type || 'Other',
        startedAt: Date.now(),
      });
    })
  );

  state.unsubscribers.push(
    cdp.on('Network.responseReceived', (params = {}) => {
      state.lastNetworkActivityAt = Date.now();
      const status = Number(params.response?.status || 0);
      if (status >= 400) {
        const req = state.inFlightRequests.get(params.requestId);
        pushBounded(
          state.networkFailures,
          {
            kind: 'http-error',
            status,
            statusText: params.response?.statusText || '',
            method: req?.method || 'GET',
            url: sanitizeUrlForDiagnostics(params.response?.url || req?.url, redactQuery),
            type: params.type || req?.type || 'Other',
            timestamp: Date.now(),
          },
          maxEntries
        );
      }
    })
  );

  state.unsubscribers.push(
    cdp.on('Network.loadingFinished', (params = {}) => {
      state.lastNetworkActivityAt = Date.now();
      if (params.requestId) state.inFlightRequests.delete(params.requestId);
    })
  );

  state.unsubscribers.push(
    cdp.on('Network.loadingFailed', (params = {}) => {
      state.lastNetworkActivityAt = Date.now();
      const req = params.requestId ? state.inFlightRequests.get(params.requestId) : null;
      if (params.requestId) state.inFlightRequests.delete(params.requestId);
      if (params.canceled) return;
      pushBounded(
        state.networkFailures,
        {
          kind: 'network-failed',
          errorText: params.errorText || 'Failed',
          method: req?.method || 'GET',
          url: req?.url || '(unknown)',
          type: params.type || req?.type || 'Other',
          timestamp: Date.now(),
        },
        maxEntries
      );
    })
  );

  cdp._observe = state;
  return state;
}

function readDiagnostics(cdp, { clear = false } = {}) {
  const obs = cdp && cdp._observe;
  const dialogs = getDialogs(cdp, { clear });
  if (!obs) {
    return {
      observeEnabled: false,
      console: [],
      exceptions: [],
      networkFailures: [],
      inFlightCount: 0,
      dialogs,
    };
  }
  const out = {
    observeEnabled: true,
    console: [...obs.console],
    exceptions: [...obs.exceptions],
    networkFailures: [...obs.networkFailures],
    inFlightCount: obs.inFlightRequests.size,
    dialogs,
  };
  if (clear) {
    obs.console.length = 0;
    obs.exceptions.length = 0;
    obs.networkFailures.length = 0;
  }
  return out;
}

/**
 * 3. 智能等待 DOM 变更静止 (waitForDomSettled)
 * 在页面内利用 MutationObserver 等待 DOM 在 quietMs 毫秒内无新增变更，非常适合金蝶页签渲染和税局表格刷新。
 */
async function waitForDomSettled(cdp, guardExpression, options = {}) {
  if (typeof guardExpression !== 'string' || !guardExpression.trim()) {
    throw new Error('waitForDomSettled requires context guard');
  }
  const quietMs = Math.max(50, Math.min(5000, Number(options.quietMs) || 250));
  const timeoutMs = Math.max(quietMs + 50, Math.min(30000, Number(options.timeoutMs) || 5000));

  const settled = await cdp.evalChecked(`(() => new Promise((resolve, reject) => {
    if (!(${guardExpression})) {
      reject(new Error("Context guard failed before waitForDomSettled"));
      return;
    }
    const quietMs = ${quietMs};
    const timeoutMs = ${timeoutMs};
    let quietTimer = null;
    let maxTimer = null;
    let observer = null;
    const finish = (reason) => {
      if (quietTimer) clearTimeout(quietTimer);
      if (maxTimer) clearTimeout(maxTimer);
      if (observer) observer.disconnect();
      resolve({ settled: true, reason });
    };
    const resetQuiet = (mutations) => {
      if (mutations) {
        const onlyHud = mutations.every(m => {
          const t = m.target;
          return t && (t.id === '__abb_hud_host' || (t.closest && t.closest('#__abb_hud_host, [data-abb-ignore]')));
        });
        if (onlyHud) return;
      }
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish('quiet'), quietMs);
    };
    observer = new MutationObserver(resetQuiet);
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    resetQuiet();
    maxTimer = setTimeout(() => finish('timeout-cap'), timeoutMs);
  }))()`);

  if (!await cdp.evalChecked(guardExpression)) {
    throw new Error('Context guard changed during waitForDomSettled');
  }
  return settled;
}

/**
 * 等待网络空闲 (waitForNetworkIdle)
 */
async function waitForNetworkIdle(cdp, guardExpression, options = {}) {
  if (typeof guardExpression !== 'string' || !guardExpression.trim()) {
    throw new Error('waitForNetworkIdle requires context guard');
  }
  const obs = await enableObserve(cdp, options);
  const idleMs = Math.max(100, Math.min(5000, Number(options.idleMs) || 400));
  const timeoutMs = Math.max(idleMs + 100, Math.min(60000, Number(options.timeoutMs) || 10000));
  const deadline = Date.now() + timeoutMs;

  if (!await cdp.evalChecked(guardExpression)) {
    throw new Error('Context guard failed before waitForNetworkIdle');
  }

  let idleSince = obs.inFlightRequests.size === 0 ? Date.now() : 0;
  while (Date.now() < deadline) {
    if (obs.inFlightRequests.size === 0) {
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince >= idleMs) {
        if (!await cdp.evalChecked(guardExpression)) {
          throw new Error('Context guard changed during waitForNetworkIdle');
        }
        return { idle: true, inFlightCount: 0 };
      }
    } else {
      idleSince = 0;
    }
    await sleep(50);
  }
  throw new Error(`waitForNetworkIdle timed out with ${obs.inFlightRequests.size} request(s) still in flight`);
}

/**
 * 4. 受控文件下载闭环追踪器 (waitForDownload)
 * 复刻 ego-lite downloads.ts：通过 Browser.setDownloadBehavior 开启下载事件，捕获文件名与完成状态。
 */
async function waitForDownload(cdp, triggerFn, options = {}) {
  if (typeof triggerFn !== 'function') {
    throw new Error('waitForDownload requires a triggerFn callback');
  }
  const guardExpression = options.guardExpression || options.guard;
  if (typeof guardExpression !== 'string' || !guardExpression.trim()) {
    throw new Error('waitForDownload requires options.guardExpression');
  }
  if (!await cdp.evalChecked(guardExpression)) {
    throw new Error('Context guard failed before download trigger');
  }

  const downloadDir = path.resolve(options.downloadDir || path.join(process.cwd(), 'downloads'));
  fs.mkdirSync(downloadDir, { recursive: true });
  const timeoutMs = Math.max(1000, Math.min(300000, Number(options.timeoutMs) || 30000));
  const browserChannel = cdp.browser && typeof cdp.browser.send === 'function' ? cdp.browser : cdp;

  await browserChannel.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  });

  emitHudNonBlocking(cdp, {
    badge: '下载追踪',
    tone: 'info',
    text: `正在等待文件下载至: ${path.basename(downloadDir)}`,
    durationMs: 4000,
  });

  return new Promise((resolve, reject) => {
    const downloads = new Map();
    const unsubs = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('waitForDownload timed out'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      for (const fn of unsubs) {
        try { fn(); } catch {}
      }
    }

    const onBegin = (params = {}) => {
      if (!params.guid) return;
      downloads.set(params.guid, {
        guid: params.guid,
        url: params.url || '',
        suggestedFilename: params.suggestedFilename || 'download.bin',
        state: 'inProgress',
      });
    };

    const onProgress = (params = {}) => {
      if (!params.guid) return;
      const item = downloads.get(params.guid) || {
        guid: params.guid,
        url: '',
        suggestedFilename: 'download.bin',
      };
      item.totalBytes = params.totalBytes ?? item.totalBytes ?? 0;
      item.receivedBytes = params.receivedBytes ?? item.receivedBytes ?? 0;
      item.state = params.state || item.state;
      if (params.filePath) item.filePath = params.filePath;
      downloads.set(params.guid, item);

      if (params.state === 'completed') {
        cleanup();
        const finalPath = item.filePath || path.join(downloadDir, item.suggestedFilename);
        emitHudNonBlocking(cdp, {
          badge: '下载完成',
          tone: 'ok',
          text: `已下载: ${item.suggestedFilename}`,
          durationMs: 3000,
        });
        resolve({
          completed: true,
          guid: item.guid,
          url: sanitizeUrlForDiagnostics(item.url, true),
          suggestedFilename: item.suggestedFilename,
          filePath: finalPath,
          totalBytes: item.totalBytes || 0,
        });
      } else if (params.state === 'canceled') {
        cleanup();
        reject(new Error(`Browser download canceled: ${item.suggestedFilename}`));
      }
    };

    if (typeof browserChannel.on === 'function') {
      unsubs.push(browserChannel.on('Browser.downloadWillBegin', onBegin));
      unsubs.push(browserChannel.on('Browser.downloadProgress', onProgress));
    }
    if (browserChannel !== cdp && typeof cdp.on === 'function') {
      unsubs.push(cdp.on('Browser.downloadWillBegin', onBegin));
      unsubs.push(cdp.on('Browser.downloadProgress', onProgress));
    }

    Promise.resolve()
      .then(() => triggerFn())
      .catch((err) => {
        cleanup();
        reject(err);
      });
  });
}

module.exports = {
  enableDialogGuard,
  getDialogs,
  enableObserve,
  readDiagnostics,
  waitForDomSettled,
  waitForNetworkIdle,
  waitForDownload,
};
