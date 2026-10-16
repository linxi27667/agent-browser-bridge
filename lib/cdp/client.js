const { resolveConfig, resolveCdpHttp } = require('./config');
const CDP_HTTP = resolveCdpHttp();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const strictInstance = () => process.env.BROWSER_BRIDGE_REQUIRE_INSTANCE || '';
class CdpDeadError extends Error { constructor(reason) { super('CDP disconnected; result may be unknown: ' + reason); this.code='CDP_DEAD'; } }
function createCdp(wsUrl, options = {}) {
  const WebSocket = require('ws');
  const url = new URL(wsUrl);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('Only local CDP WebSockets are supported');
  const config = resolveConfig();
  if (config.strict && Number(url.port || 80) !== config.port) throw new Error('CDP WebSocket port does not match verified endpoint');
  const ws = new WebSocket(wsUrl);
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
    if (msg.method) for (const handler of listeners.get(msg.method) || []) { try { handler(msg.params); } catch { fail(new Error('CDP event handler failed')); } }
  });
  return {
    ready,
    isDead() { return failed ? failed.message : null; },
    on(method, fn) { if (!listeners.has(method)) listeners.set(method, new Set()); listeners.get(method).add(fn); return () => listeners.get(method).delete(fn); },
    async send(method, params = {}) {
      await ready; if (failed) throw failed;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP command timed out; result unknown: ' + method)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }), error => { if (error && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(error); } });
      });
    },
    eval(expression) { return this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); },
    async evalChecked(expression) { const result = await this.eval(expression); if (result.exceptionDetails) throw new Error('Page evaluation failed; do not count action as successful'); return result.result && result.result.value; },
    close() { fail(new Error('CDP client closed')); ws.close(); }
  };
}
async function getJson(urlPath, options = {}) {
  if (!/^\/json(?:\/|$)/.test(urlPath) || urlPath.includes('..')) throw new Error('Only CDP JSON endpoints supported');
  const config = resolveConfig();
  if (config.strict) await require('./identity').verify({ config });
  const response = await fetch(config.endpoint + urlPath, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 10000) });
  if (!response.ok) throw new Error('CDP HTTP response: ' + response.status);
  return response.json();
}
module.exports = { CDP_HTTP, sleep, createCdp, getJson, resolveCdpHttp, strictInstance, CdpDeadError };
