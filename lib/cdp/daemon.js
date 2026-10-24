const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket, WebSocketServer } = require('ws');

const DEFAULT_PORT = 19322;

function daemonDir() {
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AgentBrowserBridge');
}

function daemonRecordPath() {
  return path.join(daemonDir(), 'daemon.json');
}

function isLoopbackAddress(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function acquireStartLock() {
  const lockPath = path.join(daemonDir(), 'starting.lock');
  fs.mkdirSync(daemonDir(), { recursive: true });
  try {
    const old = Number(fs.readFileSync(lockPath, 'utf8'));
    if (!isPidAlive(old)) fs.unlinkSync(lockPath);
  } catch { }
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return lockPath;
  } catch {
    return null;
  }
}

function readDaemonRecord() {
  try {
    const raw = fs.readFileSync(daemonRecordPath(), 'utf8');
    const record = JSON.parse(raw);
    if (!record || typeof record.http !== 'string' || typeof record.ws !== 'string') return null;
    return record;
  } catch {
    return null;
  }
}

function writeDaemonRecord(record) {
  fs.mkdirSync(daemonDir(), { recursive: true });
  fs.writeFileSync(daemonRecordPath(), JSON.stringify(record, null, 2));
}

function clearDaemonRecord() {
  try { fs.unlinkSync(daemonRecordPath()); } catch { }
}

async function recycleStaleDaemon() {
  try {
    const response = await fetch('http://127.0.0.1:' + DEFAULT_PORT + '/health', { signal: AbortSignal.timeout(800) });
    const body = await response.json();
    if (body && body.ok) return false;
    if (body && Number.isInteger(body.pid) && body.pid > 0 && body.pid !== process.pid) {
      try { process.kill(body.pid); } catch { }
    }
  } catch { }
  clearDaemonRecord();
  return true;
}

async function ensureDaemon(config) {
  const existing = await getLiveDaemon(config);
  if (existing) return existing;
  await recycleStaleDaemon();
  const lockPath = acquireStartLock();
  if (lockPath) {
    const { spawn } = require('node:child_process');
    const serve = path.join(__dirname, '..', '..', 'cli', 'serve.cjs');
    const child = spawn(process.execPath, [serve], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, BROWSER_BRIDGE_DAEMON_OWNER: '1' }
    });
    child.unref();
  }
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const record = await getLiveDaemon(config);
    if (record) {
      if (lockPath) try { fs.unlinkSync(lockPath); } catch { }
      return record;
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  if (lockPath) try { fs.unlinkSync(lockPath); } catch { }
  throw new Error('本地调试代理未能在 45 秒内就绪。若 Edge 弹出“是否允许远程调试？”，请点击“允许”。');
}

async function getLiveDaemon(config) {
  const record = readDaemonRecord();
  if (!record || Number(record.edgePort) !== Number(config.port) || !isPidAlive(record.pid)) return null;
  try {
    const response = await fetch(record.http + '/health', { signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    const body = await response.json();
    return body && body.ok ? record : null;
  } catch {
    return null;
  }
}

function connectUpstream(edgeWsUrl) {
  const url = new URL(edgeWsUrl);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Daemon upstream must be a local Edge WebSocket');
  }
  return new WebSocket(edgeWsUrl, { perMessageDeflate: false });
}

function startDaemon(options) {
  const edgeWsUrl = options.edgeWsUrl;
  const edgePort = options.edgePort;
  const listenPort = options.listenPort ?? DEFAULT_PORT;
  const persist = options.persist !== false;
  if (!edgeWsUrl || !Number.isInteger(Number(edgePort))) throw new Error('Daemon requires Edge WebSocket and port');

  const upstream = connectUpstream(edgeWsUrl);
  const pending = new Map();
  const clients = new Set();
  let nextId = 1;
  let version = { Browser: '', 'Protocol-Version': '1.3' };
  let failed;

  const fail = error => {
    if (failed) return;
    failed = error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    for (const client of clients) {
      try { client.close(); } catch { }
    }
    clients.clear();
    try { upstream.terminate(); } catch { }
    if (persist) clearDaemonRecord();
  };

  function sendUpstream(method, params = {}, sessionId) {
    if (failed) return Promise.reject(failed);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Daemon upstream timed out: ' + method));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
      upstream.send(JSON.stringify(payload), error => {
        if (error && pending.has(id)) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    });
  }

  upstream.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { fail(new Error('Malformed upstream CDP')); return; }
    if (msg.id && pending.has(msg.id)) {
      const item = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(item.timer);
      if (item.resolve) {
        msg.error ? item.reject(new Error('CDP protocol error: ' + (msg.error.message || 'failed'))) : item.resolve(msg.result);
      }
      if (item.socket && item.socket.readyState === WebSocket.OPEN) {
        item.socket.send(JSON.stringify({ ...msg, id: item.clientId }));
      }
      return;
    }
    if (msg.method) {
      for (const socket of clients) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
      }
    }
  });
  upstream.on('error', error => fail(error));
  upstream.on('close', () => fail(new Error('Edge debugger disconnected')));

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Edge debugger connection timed out')), options.timeoutMs || 45000);
    upstream.once('open', () => { clearTimeout(timer); resolve(); });
    upstream.once('error', error => { clearTimeout(timer); reject(error); });
  });

  const server = http.createServer((req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = body => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/health') {
      json({ ok: !failed, pid: process.pid, edgePort, browser: version.Browser });
      return;
    }
    if (url.pathname === '/json/version' || url.pathname === '/json/version/') {
      json({
        Browser: version.Browser,
        'Protocol-Version': version['Protocol-Version'] || '1.3',
        webSocketDebuggerUrl: 'ws://127.0.0.1:' + server.address().port + '/devtools/browser'
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      clients.add(ws);
      ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg || !msg.id || !msg.method) return;
        const id = nextId++;
        pending.set(id, { clientId: msg.id, socket: ws, timer: setTimeout(() => pending.delete(id), 15000) });
        const payload = msg.sessionId
          ? { id, method: msg.method, params: msg.params || {}, sessionId: msg.sessionId }
          : { id, method: msg.method, params: msg.params || {} };
        if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(payload));
      });
      ws.on('close', () => clients.delete(ws));
    });
  });

  return ready.then(() => sendUpstream('Browser.getVersion')).then(result => {
    const body = result || {};
    version = { Browser: body.product || '', 'Protocol-Version': body.protocolVersion || '1.3', userAgent: body.userAgent || '' };
    return new Promise((resolve, reject) => {
      server.listen(listenPort, '127.0.0.1', () => {
        const port = server.address().port;
        const record = {
          pid: process.pid,
          http: 'http://127.0.0.1:' + port,
          ws: 'ws://127.0.0.1:' + port + '/devtools/browser',
          edgePort: Number(edgePort),
          startedAt: new Date().toISOString()
        };
        if (persist) writeDaemonRecord(record);
        resolve({
          ...record,
          close() {
            fail(new Error('Daemon closed'));
            server.close();
          }
        });
      });
      server.on('error', reject);
    });
  });
}

module.exports = {
  DEFAULT_PORT,
  daemonRecordPath,
  getLiveDaemon,
  ensureDaemon,
  readDaemonRecord,
  startDaemon,
  clearDaemonRecord
};
