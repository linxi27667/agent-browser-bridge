const fs = require('node:fs');
const path = require('node:path');
const { resolveConfig, resolveCdpHttp } = require('./config');
const CDP_HTTP = resolveCdpHttp();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const strictInstance = () => process.env.BROWSER_BRIDGE_REQUIRE_INSTANCE || '';
class CdpDeadError extends Error { constructor(reason) { super('CDP disconnected; result may be unknown: ' + reason); this.code='CDP_DEAD'; } }

function websocketOptions(options, config) {
  const opts = { perMessageDeflate: false };
  if (!(options.omitOrigin || (config && config.attachExisting))) {
    opts.origin = options.origin || 'http://agent-browser-bridge.invalid';
  }
  return opts;
}

function readActivePort(profileDir) {
  const lines = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
  const port = Number(lines[0]);
  const browserPath = lines[1] || '';
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^\/devtools\/browser\/[0-9a-f-]+$/i.test(browserPath)) {
    throw new Error('DevToolsActivePort is missing or invalid');
  }
  return { port, browserPath };
}

function resolveBrowserWsUrl(config = resolveConfig()) {
  if (!config.profile) throw new Error('Browser WebSocket discovery requires expected profile');
  const active = readActivePort(config.profile);
  if (active.port !== config.port) throw new Error('DevToolsActivePort does not match selected local endpoint');
  return 'ws://127.0.0.1:' + active.port + active.browserPath;
}

async function connectBrowser(options = {}) {
  const config = resolveConfig();
  const timeoutMs = Number(options.timeoutMs || process.env.BROWSER_BRIDGE_WS_TIMEOUT_MS) || (config.attachExisting ? 45000 : 15000);
  if (config.attachExisting && process.env.BROWSER_BRIDGE_DAEMON_OWNER !== '1') {
    const daemon = require('./daemon');
    let record = await daemon.getLiveDaemon(config);
    if (!record) record = await daemon.ensureDaemon(config);
    if (record) {
      return createCdp(record.ws, {
        ...options,
        viaDaemon: true,
        timeoutMs: Math.min(timeoutMs, 15000),
        omitOrigin: true
      });
    }
  }
  if (config.attachExisting) {
    if (options.quiet !== true) {
      process.stderr.write('正在等待 Edge 远程调试授权，请在弹出窗口中点击“允许”。\n');
    }
    return createCdp(resolveBrowserWsUrl(config), {
      ...options,
      timeoutMs,
      omitOrigin: true
    });
  }
  const response = await fetch(config.endpoint + '/json/version', { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('CDP HTTP response: ' + response.status);
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) throw new Error('dedicated CDP /json/version missing webSocketDebuggerUrl');
  return createCdp(version.webSocketDebuggerUrl, { ...options, timeoutMs });
}

function createSession(browser, sessionId) {
  if (!sessionId) throw new Error('CDP sessionId required');
  return {
    ready: browser.ready,
    isDead() { return browser.isDead(); },
    on(method, fn) { return browser.on(method, fn, sessionId); },
    send(method, params = {}) { return browser.send(method, params, sessionId); },
    eval(expression) { return this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); },
    async evalChecked(expression) {
      const result = await this.eval(expression);
      if (result.exceptionDetails) throw new Error('Page evaluation failed; do not count action as successful');
      return result.result && result.result.value;
    },
    close() { browser.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  };
}

async function attachTarget(browser, targetId) {
  const result = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  if (!result || !result.sessionId) throw new Error('Target.attachToTarget did not return sessionId');
  return createSession(browser, result.sessionId);
}

function createCdp(wsUrl, options = {}) {
  const WebSocket = require('ws');
  const url = new URL(wsUrl);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('Only local CDP WebSockets are supported');
  const config = resolveConfig();
  if (config.strict && !options.viaDaemon && Number(url.port || 80) !== config.port) throw new Error('CDP WebSocket port does not match verified endpoint');
  const ws = new WebSocket(wsUrl, websocketOptions(options, config));
  let nextId = 1, failed;
  const pending = new Map(), listeners = new Map();
  const timeoutMs = options.timeoutMs || 15000;
  const fail = error => { if(failed)return; failed = error; if(options.onDead){try{options.onDead(error.message)}catch{}} for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { const error = new Error('CDP connection timed out'); reject(error); fail(error); ws.terminate(); }, timeoutMs);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', error => { clearTimeout(timer); reject(error); });
    ws.once('close', () => { clearTimeout(timer); reject(new Error('CDP closed before connection')); });
  });
  ready.catch(() => {});
  ws.on('error', error => fail(error));
  ws.on('close', () => fail(new CdpDeadError('read back before retry')));
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { fail(new Error('Malformed CDP response')); return; }
    if (msg.id && pending.has(msg.id)) {
      const item = pending.get(msg.id); pending.delete(msg.id); clearTimeout(item.timer);
      msg.error ? item.reject(new Error('CDP protocol error: ' + msg.error.message)) : item.resolve(msg.result);
    }
    if (msg.method === 'Inspector.detached') fail(new CdpDeadError('Inspector.detached'));
    if (msg.method) for (const handler of listeners.get(msg.method) || []) { try { handler(msg.params, msg); } catch { fail(new Error('CDP event handler failed')); } }
  });
  return {
    ready,
    isDead() { return failed ? failed.message : null; },
    on(method, fn, sessionId) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      const handler = (params, msg) => {
        if (sessionId && (!msg || msg.sessionId !== sessionId)) return;
        fn(params);
      };
      listeners.get(method).add(handler);
      return () => listeners.get(method).delete(handler);
    },
    async send(method, params = {}, sessionId) {
      await ready; if (failed) throw failed;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP command timed out; result unknown: ' + method)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
        ws.send(JSON.stringify(payload), error => { if (error && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(error); } });
      });
    },
    eval(expression) { return this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); },
    async evalChecked(expression) { const result = await this.eval(expression); if (result.exceptionDetails) throw new Error('Page evaluation failed; do not count action as successful'); return result.result && result.result.value; },
    close() { fail(new Error('CDP client closed')); ws.close(); }
  };
}

function mapTargetInfos(targetInfos) {
  return (targetInfos || []).map(info => ({
    id: info.targetId,
    type: info.type,
    title: info.title,
    url: info.url
  }));
}

async function getJsonViaBrowser(urlPath, config) {
  const browser = await connectBrowser({ quiet: true });
  try {
    if (urlPath === '/json/version' || urlPath === '/json/version/') {
      const version = await browser.send('Browser.getVersion');
      const product = version.product || '';
      if (config.attachExisting && !/Edg\//i.test(product)) throw new Error('Existing Edge browser identity was not confirmed');
      return {
        Browser: product,
        'Protocol-Version': version.protocolVersion || '1.3',
        'User-Agent': version.userAgent || '',
        webSocketDebuggerUrl: resolveBrowserWsUrl(config)
      };
    }
    if (urlPath === '/json/list' || urlPath === '/json/list/' || urlPath === '/json' || urlPath === '/json/') {
      const result = await browser.send('Target.getTargets');
      return mapTargetInfos(result.targetInfos);
    }
    throw new Error('Only CDP JSON endpoints supported');
  } finally {
    browser.close();
  }
}

async function getJson(urlPath, options = {}) {
  if (!/^\/json(?:\/|$)/.test(urlPath) || urlPath.includes('..')) throw new Error('Only CDP JSON endpoints supported');
  const config = resolveConfig();
  if (config.strict) await require('./identity').verify({ config });
  if (config.attachExisting) return getJsonViaBrowser(urlPath, config);
  const response = await fetch(config.endpoint + urlPath, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 10000) });
  if (!response.ok) throw new Error('CDP HTTP response: ' + response.status);
  return response.json();
}

module.exports = {
  CDP_HTTP, sleep, createCdp, getJson, resolveCdpHttp, strictInstance, CdpDeadError,
  readActivePort, resolveBrowserWsUrl, connectBrowser, attachTarget, createSession, mapTargetInfos
};
