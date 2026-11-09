// AgentBrowserBridge - 多任务并发与页面租约（无守护进程）
// Target Lease：同一 targetId 同时只允许一个任务绑定（带 Token 核验与自动心跳续期）
// UI Action Mutex：同一调试端口上前台点击/输入/截图自动排队
// 智能标签页生命周期保护：业务页面（http/https）默认复用已有未租用页签且绝不自动关闭，防止误关用户页面或导致浏览器退出。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { sleep, getJson, connectBrowser, attachTarget, mapTargetInfos } = require('./client');
const { resolveConfig } = require('./config');
const { requireTarget } = require('./interaction');

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

/**
 * 健壮的文件系统原子锁原语（支持防死锁自愈、Token 所有权核验、5s 初始宽限期、原子接管与心跳）
 */
function createFileLock(lockPath, options = {}) {
  const ttlMs = Math.max(50, Number(options.ttlMs) || 30000);
  const resource = options.resource || path.basename(lockPath);
  const ownerTag = options.ownerTag || '';
  const port = options.port || 9222;
  const token = crypto.randomUUID();
  const ownerFile = path.join(lockPath, 'owner.json');

  function tryCreate() {
    try {
      fs.mkdirSync(lockPath);
      const owner = {
        pid: process.pid,
        port,
        resource,
        token,
        ownerTag,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
      };
      const tmpFile = path.join(lockPath, `owner.${token}.tmp`);
      fs.writeFileSync(tmpFile, JSON.stringify(owner), 'utf8');
      fs.renameSync(tmpFile, ownerFile);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return false;
    }
  }

  function readOwnerData() {
    try {
      return JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    } catch {
      return null;
    }
  }

  function checkStale() {
    const data = readOwnerData();
    if (!data) {
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs < 5000) {
          return { stale: false, data: null };
        }
      } catch {
        return { stale: true, data: null };
      }
      return { stale: true, data: null };
    }
    if (!isProcessAlive(data.pid) || Date.now() > data.expiresAt) {
      return { stale: true, data };
    }
    return { stale: false, data };
  }

  function tryAtomicTakeover() {
    const staleRenamed = lockPath + `.stale-${Date.now()}-${crypto.randomUUID()}`;
    try {
      fs.renameSync(lockPath, staleRenamed);
    } catch {
      return false;
    }
    try {
      fs.rmSync(staleRenamed, { recursive: true, force: true });
    } catch {}
    return tryCreate();
  }

  if (!tryCreate()) {
    const { stale } = checkStale();
    if (stale) {
      if (!tryAtomicTakeover()) {
        return null;
      }
    } else {
      return null;
    }
  }

  let active = true;
  let lost = false;

  return {
    token,
    lockPath,
    get active() { return active; },
    get lost() { return lost; },
    assertHeld() {
      if (!active || lost) {
        const err = new Error(`Lock on ${resource} has been lost or expired`);
        err.code = 'CDP_LEASE_LOST';
        err.resource = resource;
        throw err;
      }
      const data = readOwnerData();
      if (!data || data.token !== token) {
        lost = true;
        active = false;
        const err = new Error(`Lock on ${resource} ownership mismatch (token lost)`);
        err.code = 'CDP_LEASE_LOST';
        err.resource = resource;
        throw err;
      }
    },
    renew(extraTtlMs = ttlMs) {
      if (!active || lost) return false;
      const data = readOwnerData();
      if (!data || data.token !== token) {
        lost = true;
        active = false;
        return false;
      }
      try {
        data.expiresAt = Date.now() + Math.max(500, extraTtlMs);
        const tmpFile = path.join(lockPath, `owner.${token}.tmp`);
        fs.writeFileSync(tmpFile, JSON.stringify(data), 'utf8');
        fs.renameSync(tmpFile, ownerFile);
        return true;
      } catch {
        lost = true;
        active = false;
        return false;
      }
    },
    release() {
      if (!active) return;
      active = false;
      const data = readOwnerData();
      if (!data || !data.token || data.token === token) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true });
        } catch {}
      }
    },
  };
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

  const handle = createFileLock(lockPath, {
    ttlMs,
    port,
    resource: 'target:' + targetId,
    ownerTag: opts.ownerTag || '',
  });

  if (!handle) {
    const error = new Error(`Target is leased by another active task: ${targetId}`);
    error.code = 'CDP_TARGET_LEASED';
    error.targetId = targetId;
    throw error;
  }

  let heartbeatTimer = null;
  if (opts.heartbeat !== false) {
    const intervalMs = Math.max(500, Math.floor(ttlMs / 3));
    heartbeatTimer = setInterval(() => {
      if (!handle.renew(ttlMs)) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }, intervalMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }

  return {
    port,
    targetId,
    token: handle.token,
    leasePath: lockPath,
    assertHeld: () => handle.assertHeld(),
    renew: (extra) => handle.renew(extra),
    release: () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      handle.release();
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
  const deadline = Date.now() + timeoutMs;

  let handle = null;
  while (!handle && Date.now() < deadline) {
    handle = createFileLock(lockPath, {
      ttlMs: leaseMs,
      port,
      resource: 'ui:' + port,
      ownerTag: options.ownerTag || 'ui-lock',
    });
    if (!handle) {
      await sleep(pollMs);
    }
  }

  if (!handle) {
    const error = new Error(`Timed out waiting for browser UI lock on port ${port}`);
    error.code = 'CDP_UI_LOCK_TIMEOUT';
    error.port = port;
    throw error;
  }

  let heartbeatTimer = null;
  const intervalMs = Math.max(100, Math.floor(leaseMs / 3));
  heartbeatTimer = setInterval(() => {
    if (!handle.renew(leaseMs)) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }, intervalMs);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  try {
    return await fn();
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    handle.release();
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

function isBusinessUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

function extractOrigin(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return '';
  }
}

async function getBrowserPageTargets(browser) {
  try {
    const res = await browser.send('Target.getTargets');
    return mapTargetInfos(res.targetInfos).filter((t) => t.type === 'page');
  } catch {
    return [];
  }
}

/**
 * 分配或复用独占租约标签页：
 * - 支持 (fn)、(options, fn) 以及 (browser, options, fn) 三种调用签名
 * - 当 url 为 http(s):// 业务网址时：
 *   1. 默认优先复用同源未上锁的已有标签页（除非设置 reuseExisting: false 或 newTab: true），避免重复开页与丢登录态
 *   2. 默认 keepOpen = true（退出或异常时绝不自动关闭业务页签，除非显式传 keepOpen: false 或 closeOnExit: true）
 * - 当 url 为 about:blank（测试/隔离沙箱）时：默认新建空白页并在退出时关闭；若关闭前它是最后一个页面，先补一个空白页防止浏览器进程退出。
 */
async function withDedicatedTab(arg1, arg2, arg3) {
  let externalBrowser = null;
  let opts = {};
  let callback = null;

  if (arg1 && typeof arg1.send === 'function' && typeof arg1.close === 'function') {
    externalBrowser = arg1;
    if (typeof arg2 === 'function') {
      callback = arg2;
    } else {
      opts = typeof arg2 === 'object' && arg2 !== null ? arg2 : {};
      callback = arg3;
    }
  } else if (typeof arg1 === 'function') {
    callback = arg1;
  } else {
    opts = typeof arg1 === 'object' && arg1 !== null ? arg1 : {};
    callback = arg2;
  }

  if (typeof callback !== 'function') {
    throw new Error('withDedicatedTab requires an execution callback function');
  }

  const url = opts.url || 'about:blank';
  const port = resolvePort(opts);
  const businessUrl = isBusinessUrl(url);
  const targetOrigin = businessUrl ? extractOrigin(url) : '';
  const allowReuse = businessUrl && opts.reuseExisting !== false && !opts.newTab && !opts.newWindow;

  const browser = externalBrowser || await connectBrowser({ quiet: true });
  let targetId = null;
  let reusedExisting = false;
  let pageCdp = null;
  let lease = null;

  try {
    if (allowReuse && targetOrigin) {
      // 同站点同账号必须串行：同源标签页都被其他任务占用时，默认等待释放，而不是另开新标签页并行操作
      const onLeased = opts.onLeased || 'wait';
      const leaseWaitMs = Number.isFinite(Number(opts.leaseWaitMs)) ? Math.max(0, Number(opts.leaseWaitMs)) : 60000;
      const leaseDeadline = Date.now() + leaseWaitMs;
      for (;;) {
        const pages = await getBrowserPageTargets(browser);
        const candidates = pages.filter((p) => extractOrigin(p.url) === targetOrigin);
        let sawLeased = false;
        for (const candidate of candidates) {
          try {
            lease = acquireTargetLease({
              port,
              targetId: candidate.id,
              ownerTag: opts.ownerTag || 'dedicated-tab',
              ttlMs: opts.ttlMs,
            });
            targetId = candidate.id;
            reusedExisting = true;
            break;
          } catch (err) {
            if (err && err.code === 'CDP_TARGET_LEASED') { sawLeased = true; continue; }
            throw err;
          }
        }
        if (targetId || !sawLeased || onLeased === 'newTab') break;
        if (onLeased === 'fail' || Date.now() >= leaseDeadline) {
          const busy = new Error(`All ${targetOrigin} tabs are leased by other tasks; same-site work must stay serial`);
          busy.code = 'CDP_TARGET_LEASED';
          busy.origin = targetOrigin;
          throw busy;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (!targetId) {
      const created = await browser.send('Target.createTarget', {
        url,
        newWindow: Boolean(opts.newWindow),
        background: businessUrl ? Boolean(opts.background) : (opts.background !== false),
      });
      targetId = created.targetId;
      lease = acquireTargetLease({
        port,
        targetId,
        ownerTag: opts.ownerTag || 'dedicated-tab',
        ttlMs: opts.ttlMs,
      });
    }

    pageCdp = await attachTarget(browser, targetId);
    pageCdp.targetId = targetId;
    pageCdp.port = port;
    pageCdp.browser = browser;
    pageCdp.ownerTag = opts.ownerTag || 'dedicated-tab';
    pageCdp.autoUiLock = opts.autoUiLock !== false;

    if (businessUrl && opts.background !== true) {
      try {
        await browser.send('Target.activateTarget', { targetId });
      } catch {}
    }

    if (reusedExisting && opts.forceNavigate) {
      await pageCdp.send('Page.navigate', { url });
    }

    return await callback(pageCdp, {
      targetId,
      reusedExisting,
      activate: () => activateTarget(targetId, { browser }),
      lease,
    });
  } finally {
    let navigatedToBusiness = false;
    if (targetId && !businessUrl && opts.keepOpen === undefined && opts.closeOnExit === undefined) {
      const currentPages = await getBrowserPageTargets(browser);
      const cur = currentPages.find((p) => p.id === targetId);
      if (cur && isBusinessUrl(cur.url)) {
        navigatedToBusiness = true;
      }
    }

    if (pageCdp) {
      try { pageCdp.close(); } catch {}
    }
    if (lease) {
      lease.release();
    }

    let shouldClose;
    if (opts.keepOpen === true || opts.closeOnExit === false) {
      shouldClose = false;
    } else if (opts.keepOpen === false || opts.closeOnExit === true) {
      shouldClose = true;
    } else {
      shouldClose = !(businessUrl || reusedExisting || navigatedToBusiness);
    }

    if (targetId && shouldClose) {
      try {
        const remainingPages = await getBrowserPageTargets(browser);
        if (remainingPages.length <= 1) {
          await browser.send('Target.createTarget', { url: 'about:blank', background: true }).catch(() => {});
        }
        await browser.send('Target.closeTarget', { targetId });
      } catch {}
    }
    if (!externalBrowser) {
      browser.close();
    }
  }
}

function selectTargetForLease(targets, criteria) {
  if (typeof criteria === 'string') {
    return requireTarget(targets, { id: criteria });
  }
  if (!criteria || typeof criteria !== 'object') {
    throw new Error('Explicit target ID, exact URL, or URL/title filter required');
  }
  if (Object.hasOwn(criteria, 'id') || Object.hasOwn(criteria, 'exactUrl')) {
    return requireTarget(targets, criteria);
  }
  const { urlIncludes, origin, titleIncludes } = criteria;
  if (!urlIncludes && !origin && !titleIncludes) {
    return requireTarget(targets, criteria);
  }
  const pages = targets.filter((t) => {
    if (t.type !== 'page') return false;
    if (urlIncludes && !String(t.url || '').includes(urlIncludes)) return false;
    if (origin && extractOrigin(t.url) !== origin) return false;
    if (titleIncludes && !String(t.title || '').includes(titleIncludes)) return false;
    return true;
  });
  if (pages.length === 0) throw new Error('Target missing or ambiguous');
  return pages;
}

/**
 * 复用已有页签的一体化租约入口（查找 Target、绑定租约、挂载 autoUiLock 与心跳，finally 中只释放租约绝不关页面）
 */
async function withLeasedTarget(arg1, arg2, arg3, arg4) {
  let externalBrowser = null;
  let rawCriteria = null;
  let opts = {};
  let callback = null;

  if (arg1 && typeof arg1.send === 'function' && typeof arg1.close === 'function') {
    externalBrowser = arg1;
    rawCriteria = arg2;
    if (typeof arg3 === 'function') {
      callback = arg3;
    } else {
      opts = arg3 || {};
      callback = arg4;
    }
  } else {
    rawCriteria = arg1;
    if (typeof arg2 === 'function') {
      callback = arg2;
    } else {
      opts = arg2 || {};
      callback = arg3;
    }
  }

  if (typeof callback !== 'function') {
    throw new Error('withLeasedTarget requires an execution callback function');
  }

  const port = resolvePort(opts);
  const browser = externalBrowser || await connectBrowser({ quiet: true });

  let lease = null;
  let pageCdp = null;
  let selectedTarget = null;

  try {
    const targets = await getBrowserPageTargets(browser);
    const matched = selectTargetForLease(targets, rawCriteria);
    const candidates = Array.isArray(matched) ? matched : [matched];

    for (const candidate of candidates) {
      try {
        lease = acquireTargetLease({
          port,
          targetId: candidate.id,
          ownerTag: opts.ownerTag || 'leased-target',
          ttlMs: opts.ttlMs,
          heartbeat: opts.heartbeat !== false,
        });
        selectedTarget = candidate;
        break;
      } catch (err) {
        if (candidates.length > 1 && err && err.code === 'CDP_TARGET_LEASED') continue;
        throw err;
      }
    }

    if (!lease || !selectedTarget) {
      const error = new Error(`Target is leased by another active task: ${candidates[0].id}`);
      error.code = 'CDP_TARGET_LEASED';
      error.targetId = candidates[0].id;
      throw error;
    }

    const targetId = selectedTarget.id;
    pageCdp = await attachTarget(browser, targetId);
    pageCdp.targetId = targetId;
    pageCdp.port = port;
    pageCdp.browser = browser;
    pageCdp.ownerTag = opts.ownerTag || 'leased-target';
    pageCdp.autoUiLock = opts.autoUiLock !== false;

    if (opts.activate !== false) {
      try {
        await browser.send('Target.activateTarget', { targetId });
      } catch {}
    }

    return await callback(pageCdp, {
      targetId,
      target: selectedTarget,
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
    if (!externalBrowser) {
      browser.close();
    }
  }
}

function assertNotLeasedByOtherProcess(targetId, options = {}) {
  if (typeof targetId !== 'string' || !targetId.trim()) return;
  const port = resolvePort(options);
  const lockDir = resolveLockDir();
  const lockPath = path.join(lockDir, `target-${port}-${sanitizeTargetId(targetId)}.lock`);
  const ownerFile = path.join(lockPath, 'owner.json');
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  } catch {
    return;
  }
  if (!data || !data.pid || data.pid === process.pid) return;
  const now = Date.now();
  const expired = Number.isFinite(data.expiresAt) && now > data.expiresAt;
  if (!expired && isProcessAlive(data.pid)) {
    const error = new Error(`Target is leased by another active process (PID ${data.pid}): ${targetId}`);
    error.code = 'CDP_TARGET_LEASED';
    error.targetId = targetId;
    throw error;
  }
}

module.exports = {
  resolveLockDir,
  isProcessAlive,
  createFileLock,
  acquireTargetLease,
  assertNotLeasedByOtherProcess,
  withUiLock,
  activateTarget,
  withDedicatedTab,
  withLeasedTarget,
};
