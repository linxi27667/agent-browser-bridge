// AgentBrowserBridge - 多任务并发与页面租约（无守护进程）
// Target Lease：同一 targetId 同时只允许一个任务绑定
// UI Action Mutex：同一调试端口上前台点击/输入/截图自动排队
// 设计参照 GcWebAuto 0.5.0，锁目录与环境变量使用本仓前缀。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sleep, getJson, connectBrowser, attachTarget } = require('./client');
const { resolveConfig } = require('./config');

function resolveLockDir() {
  if (process.env.BROWSER_BRIDGE_LOCK_DIR) {
    const custom = path.resolve(process.env.BROWSER_BRIDGE_LOCK_DIR);
    fs.mkdirSync(custom, { recursive: true });
    return custom;
  }
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.agent-browser-bridge');
  const lockDir = path.join(base, 'AgentBrowserBridge', 'locks');
  try {
    fs.mkdirSync(lockDir, { recursive: true });
    return lockDir;
  } catch {
    const fallback = path.join(os.tmpdir(), 'agent-browser-bridge-locks');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程存在但无信号权限，仍视为存活
    return err.code === 'EPERM';
  }
}

function sanitizeTargetId(targetId) {
  return String(targetId || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function resolvePort(options = {}) {
  if (options.port) return Number(options.port);
  try {
    return resolveConfig().port;
  } catch {
    return 9222;
  }
}

function acquireTargetLease(options = {}) {
  const opts = typeof options === 'string' ? { targetId: options } : options;
  const targetId = opts.targetId;
  if (typeof targetId !== 'string' || !targetId.trim()) {
    throw new Error('Target lease requires explicit targetId');
  }
  const port = resolvePort(opts);
  const ttlMs = Math.max(1000, Number(opts.ttlMs) || 300000);
  const lockDir = resolveLockDir();
  const lockPath = path.join(lockDir, `target-${port}-${sanitizeTargetId(targetId)}.lock`);
  const ownerFile = path.join(lockPath, 'owner.json');

  function tryCreate() {
    try {
      fs.mkdirSync(lockPath);
      const owner = {
        pid: process.pid,
        port,
        resource: 'target:' + targetId,
        ownerTag: opts.ownerTag || '',
        acquiredAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
      };
      fs.writeFileSync(ownerFile, JSON.stringify(owner), 'utf8');
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return false;
    }
  }

  if (!tryCreate()) {
    let stale = false;
    try {
      const data = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      if (!isProcessAlive(data.pid) || Date.now() > data.expiresAt) {
        stale = true;
      }
    } catch {
      stale = true;
    }

    if (stale) {
      try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
      if (!tryCreate()) {
        const error = new Error(`Target is leased by another active task: ${targetId}`);
        error.code = 'CDP_TARGET_LEASED';
        error.targetId = targetId;
        throw error;
      }
    } else {
      const error = new Error(`Target is leased by another active task: ${targetId}`);
      error.code = 'CDP_TARGET_LEASED';
      error.targetId = targetId;
      throw error;
    }
  }

  let active = true;
  return {
    port,
    targetId,
    leasePath: lockPath,
    renew(extraTtlMs = ttlMs) {
      if (!active) return false;
      try {
        const data = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
        data.expiresAt = Date.now() + Math.max(1000, extraTtlMs);
        fs.writeFileSync(ownerFile, JSON.stringify(data), 'utf8');
        return true;
      } catch {
        return false;
      }
    },
    release() {
      if (!active) return;
      active = false;
      try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
    },
  };
}

async function withUiLock(fn, options = {}) {
  const port = resolvePort(options);
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 15000);
  const leaseMs = Math.max(500, Number(options.leaseMs) || 30000);
  const pollMs = Math.max(20, Math.min(500, Number(options.pollMs) || 50));
  const lockDir = resolveLockDir();
  const lockPath = path.join(lockDir, `ui-${port}.lock`);
  const ownerFile = path.join(lockPath, 'owner.json');
  const deadline = Date.now() + timeoutMs;

  let acquired = false;
  while (!acquired && Date.now() < deadline) {
    try {
      fs.mkdirSync(lockPath);
      const owner = {
        pid: process.pid,
        port,
        resource: 'ui:' + port,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + leaseMs,
      };
      fs.writeFileSync(ownerFile, JSON.stringify(owner), 'utf8');
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const data = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
        if (!isProcessAlive(data.pid) || Date.now() > data.expiresAt) {
          stale = true;
        }
      } catch {
        stale = true;
      }
      if (stale) {
        try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
      } else {
        await sleep(pollMs);
      }
    }
  }

  if (!acquired) {
    const error = new Error(`Timed out waiting for browser UI lock on port ${port}`);
    error.code = 'CDP_UI_LOCK_TIMEOUT';
    error.port = port;
    throw error;
  }

  try {
    return await fn();
  } finally {
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
  }
}

async function activateTarget(targetId, options = {}) {
  if (typeof targetId !== 'string' || !targetId.trim()) {
    throw new Error('activateTarget requires explicit targetId');
  }
  if (options.browser) {
    await options.browser.send('Target.activateTarget', { targetId });
    return { activated: true, targetId, via: 'cdp' };
  }
  const config = resolveConfig();
  if (config.attachExisting) {
    const browser = await connectBrowser({ quiet: true });
    try {
      await browser.send('Target.activateTarget', { targetId });
      return { activated: true, targetId, via: 'cdp' };
    } finally {
      browser.close();
    }
  }
  const response = await getJson('/json/activate/' + encodeURIComponent(targetId), options);
  return { activated: true, targetId, response, via: 'http' };
}

async function withDedicatedTab(options, fn) {
  const callback = typeof options === 'function' ? options : fn;
  const opts = typeof options === 'object' && options !== null ? options : {};
  if (typeof callback !== 'function') {
    throw new Error('withDedicatedTab requires an execution callback function');
  }
  const url = opts.url || 'about:blank';
  const port = resolvePort(opts);

  const browser = await connectBrowser({ quiet: true });
  let target, pageCdp, lease;
  try {
    target = await browser.send('Target.createTarget', {
      url,
      newWindow: Boolean(opts.newWindow),
      background: opts.background !== false,
    });
    const targetId = target.targetId;
    lease = acquireTargetLease({ port, targetId, ownerTag: opts.ownerTag || 'dedicated-tab' });
    pageCdp = await attachTarget(browser, targetId);
    pageCdp.targetId = targetId;
    pageCdp.port = port;
    pageCdp.browser = browser;
    pageCdp.ownerTag = opts.ownerTag || 'dedicated-tab';
    pageCdp.autoUiLock = opts.autoUiLock !== false;

    return await callback(pageCdp, {
      targetId,
      activate: () => activateTarget(targetId, { browser }),
      lease,
    });
  } finally {
    if (pageCdp) {
      try { pageCdp.close(); } catch {}
    }
    if (lease) {
      lease.release();
    }
    if (target && !opts.keepOpen) {
      try { await browser.send('Target.closeTarget', { targetId: target.targetId }); } catch {}
    }
    browser.close();
  }
}

module.exports = {
  resolveLockDir,
  isProcessAlive,
  acquireTargetLease,
  withUiLock,
  activateTarget,
  withDedicatedTab,
};
