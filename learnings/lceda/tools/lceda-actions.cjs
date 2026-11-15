// 嘉立创EDA专业版 (pro.lceda.cn) 防休眠桥接、.eext 静默导入与 daemon 自动重连自愈动作库
// 安全红线：
//   1. 绝不杀任何 msedge.exe / chrome.exe 进程，绝不重启已在运行的 easyeda daemon；
//   2. 当已有窗口连接且持有目标工程时，ensure 100% 幂等无损返回，绝不刷新正在绘图的标签页或制造双窗口并发冲突；
//   3. 零明文口令、零系统文件弹窗（采用 DOM.setFileInputFiles 静默注入 .eext）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const cdp = require(path.resolve(__dirname, '../../../lib/cdp'));
const sceneMod = require(path.resolve(__dirname, '../../../lib/cdp/scene'));

const CONNECTOR_UUID = '4dae27407c1d43be98e8e210d45fe587';
const LCEDA_EDITOR_URL = 'https://pro.lceda.cn/editor';
const LCEDA_ORIGIN = 'https://pro.lceda.cn';
const LCEDA_GUARD = "location.hostname.toLowerCase().includes('lceda.cn') || location.hostname.toLowerCase().includes('jlc.com')";
const DAEMON_PORTS = [60832, 60833, 60834, 60835, 60836, 60837, 60838, 60839, 60840, 60841];

async function connectBrowserCompat() {
  if (typeof cdp.connectBrowser === 'function') return cdp.connectBrowser();
  const version = await cdp.getJson('/json/version');
  if (!version || !version.webSocketDebuggerUrl) throw new Error('CDP /json/version missing webSocketDebuggerUrl');
  const client = cdp.createCdp(version.webSocketDebuggerUrl);
  await client.ready;
  return client;
}

async function attachTargetCompat(browser, targetId) {
  if (typeof cdp.attachTarget === 'function') return cdp.attachTarget(browser, targetId);
  const target = cdp.requireTarget(await cdp.listTargets(), { id: targetId });
  const client = cdp.createCdp(target.webSocketDebuggerUrl);
  await client.ready;
  client.targetId = targetId;
  client.browser = browser;
  return client;
}

function resolveEasyEdaBin(customBin) {
  const candidates = [
    customBin,
    process.env.EASYEDA_BIN,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'easyeda-agent', 'bin', process.platform === 'win32' ? 'easyeda.exe' : 'easyeda') : '',
    path.join(os.homedir(), 'AppData', 'Local', 'easyeda-agent', 'bin', 'easyeda.exe'),
    path.join(os.homedir(), '.local', 'bin', 'easyeda'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return path.resolve(p);
  }
  const pathEnv = process.env.PATH || '';
  const exeName = process.platform === 'win32' ? 'easyeda.exe' : 'easyeda';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, exeName);
    if (fs.existsSync(full)) return path.resolve(full);
  }
  return null;
}

function resolveDefaultEextPath(customPath) {
  if (customPath) {
    const abs = path.resolve(customPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`Specified .eext file does not exist: ${abs}`);
    }
    return abs;
  }
  if (process.env.EASYEDA_EEXT_PATH && fs.existsSync(process.env.EASYEDA_EEXT_PATH)) {
    return path.resolve(process.env.EASYEDA_EEXT_PATH);
  }
  const searchDirs = [
    path.join(os.homedir(), 'Desktop', 'Easyeda_Agent', 'extensions'),
    path.join(os.homedir(), 'Desktop', 'Easyeda_Agent'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'easyeda-agent') : '',
  ].filter(Boolean);

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir)
      .filter((n) => /^easyeda-agent-connector.*\.eext$/i.test(n))
      .sort()
      .reverse();
    if (entries.length > 0) {
      return path.resolve(dir, entries[0]);
    }
  }
  return null;
}

async function readDaemonHealth(opts = {}) {
  const host = opts.daemonHost || '127.0.0.1';
  const ports = Array.isArray(opts.daemonPorts) && opts.daemonPorts.length ? opts.daemonPorts : DAEMON_PORTS;
  for (const port of ports) {
    try {
      const res = await fetch(`http://${host}:${port}/health`, {
        signal: AbortSignal.timeout(opts.timeoutMs || 800),
      });
      if (!res.ok) continue;
      const raw = await res.json();
      if (raw && (raw.service === 'easyeda-agent' || Array.isArray(raw.windows))) {
        const windows = Array.isArray(raw.windows) ? raw.windows : [];
        return {
          daemonOk: true,
          host,
          port: raw.port || port,
          pid: raw.pid || null,
          version: raw.version || null,
          windows,
          connectorOk: windows.length > 0,
          autosaveCount: Array.isArray(raw.autosave) ? raw.autosave.length : 0,
        };
      }
    } catch {}
  }
  return {
    daemonOk: false,
    host,
    port: null,
    pid: null,
    version: null,
    windows: [],
    connectorOk: false,
    autosaveCount: 0,
  };
}

async function ensureDaemonRunning(opts = {}) {
  const initial = await readDaemonHealth(opts);
  if (initial.daemonOk) {
    return { ...initial, startedDaemon: false };
  }
  const bin = resolveEasyEdaBin(opts.easyedaBin);
  if (!bin) {
    throw new Error('easyeda daemon is not running and easyeda CLI binary was not found');
  }
  try {
    execFileSync(bin, ['daemon', 'start'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    const child = spawn(bin, ['daemon', 'start'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const h = await readDaemonHealth(opts);
    if (h.daemonOk) return { ...h, startedDaemon: true };
    await cdp.sleep(300);
  }
  throw new Error('Started easyeda daemon, but http://127.0.0.1:60832/health did not become ready within 8s');
}

async function probeCdpPort(port, timeoutMs = 800) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.Browser ? data : null;
  } catch {
    return null;
  }
}

async function ensureDebugBrowserRunning(spec, opts = {}) {
  const existing = await probeCdpPort(spec.port);
  if (existing) {
    return { startedBrowser: false, port: spec.port, browserVersion: existing.Browser };
  }
  if (process.platform !== 'win32') {
    throw new Error(`No debug browser listening on 127.0.0.1:${spec.port}; start dedicated Edge/Chrome first`);
  }
  const startScript = path.resolve(__dirname, '../../../lib/profile/Start-DebugBrowser.ps1');
  if (!fs.existsSync(startScript)) {
    throw new Error(`Start-DebugBrowser.ps1 missing at ${startScript}`);
  }
  const browserArg = spec.browser === 'chrome' ? 'Chrome' : 'Edge';
  const sceneArg = path.basename(spec.profile).replace(/^(Edge|Chrome)-/i, '') || 'LCEDA';
  const psArgs = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', startScript,
    '-Browser', browserArg,
    '-Scene', sceneArg,
    '-Port', String(spec.port),
    '-ProfileRoot', spec.profile,
    '-Url', opts.initialUrl || LCEDA_EDITOR_URL,
  ];
  let lastErr = null;
  for (const exe of ['pwsh.exe', 'powershell.exe']) {
    try {
      execFileSync(exe, psArgs, {
        encoding: 'utf8',
        timeout: 20000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) {
    throw new Error(`Failed to start dedicated ${browserArg} on port ${spec.port}: ${lastErr.message}`);
  }
  const after = await probeCdpPort(spec.port, 2000);
  if (!after) {
    throw new Error(`Launched ${browserArg} on port ${spec.port}, but CDP endpoint did not respond`);
  }
  return { startedBrowser: true, port: spec.port, browserVersion: after.Browser };
}

async function grantAndAllowPermissions(browser, targetId, opts = {}) {
  const granted = [];
  for (const perm of ['localNetworkAccess', 'localFonts', 'notifications']) {
    try {
      await browser.send('Browser.grantPermissions', {
        origin: opts.origin || LCEDA_ORIGIN,
        permissions: [perm],
      });
      granted.push(perm);
    } catch {}
  }

  if (targetId && opts.activate !== false) {
    try {
      await browser.send('Target.activateTarget', { targetId });
      await cdp.sleep(600);
    } catch {}
  }

  const targets = await cdp.listTargets(browser);
  const permTargets = (targets || []).filter((t) => String(t.url || '').includes('permission-request-dialog'));
  const dismissed = [];
  for (const perm of permTargets) {
    let client;
    try {
      client = await attachTargetCompat(browser, perm.id);
      const box = await client.evalChecked(`(() => {
        let allowBtn = null;
        function walk(root) {
          for (const el of root.querySelectorAll('*')) {
            const txt = (el.textContent || '').trim();
            if ((el.tagName === 'FLUENT-BUTTON' || el.tagName === 'BUTTON') && (txt === '允许' || txt === 'Allow' || txt === '始终允许')) {
              allowBtn = el;
            }
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        }
        walk(document);
        const promptText = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 160);
        if (!allowBtn) return { found: false, promptText };
        const r = allowBtn.getBoundingClientRect();
        try { allowBtn.click(); } catch {}
        return {
          found: true,
          promptText,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          w: r.width,
          h: r.height,
        };
      })()`);
      if (box && box.found && box.w > 0 && box.h > 0) {
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }).catch(() => {});
        await cdp.sleep(40);
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }).catch(() => {});
        await cdp.sleep(40);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }).catch(() => {});
        await cdp.sleep(250);
      }
      dismissed.push({ targetId: perm.id, ...box });
    } catch {} finally {
      if (client) client.close();
    }
  }
  return { granted, dismissed };
}

async function ensureEditorTabTarget(browser, opts = {}) {
  const targets = await cdp.listTargets(browser);
  const pages = (targets || []).filter((t) => t.type === 'page');
  if (opts.targetId) {
    const exact = pages.find((p) => p.id === opts.targetId);
    if (!exact) throw new Error(`Target tab ${opts.targetId} not found`);
    return { targetId: exact.id, createdTab: false, url: exact.url };
  }
  const editorPage = pages.find((p) => String(p.url || '').includes('pro.lceda.cn/editor'))
    || pages.find((p) => String(p.url || '').includes('lceda.cn'));
  if (editorPage) {
    return { targetId: editorPage.id, createdTab: false, url: editorPage.url };
  }
  const created = await browser.send('Target.createTarget', { url: opts.editorUrl || LCEDA_EDITOR_URL });
  if (!created || !created.targetId) {
    throw new Error('Failed to open https://pro.lceda.cn/editor tab via Target.createTarget');
  }
  await cdp.sleep(1500);
  return { targetId: created.targetId, createdTab: true, url: opts.editorUrl || LCEDA_EDITOR_URL };
}

async function waitForEditorDomReady(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await page.evalChecked(`(() => {
        if (!location.hostname.toLowerCase().includes('lceda.cn')) return false;
        if (document.readyState !== 'complete') return false;
        const hasHeader = [...document.querySelectorAll('span,div,button,p')].some((e) => {
          const t = (e.innerText || '').trim();
          return t === '文件' || t === '高级' || t === 'Advanced';
        });
        return hasHeader;
      })()`);
      if (ready) return true;
    } catch {}
    await cdp.sleep(400);
  }
  return false;
}

async function readEditorExtensionStatus(page) {
  return page.evalChecked(`(async () => {
    const vis = (e) => {
      if (!e || !e.isConnected) return false;
      const r = e.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    };
    const loginBtn = document.getElementById('login-btn');
    const loginBtnVisible = Boolean(loginBtn && vis(loginBtn) && /登录|Login/i.test(loginBtn.innerText || ''));
    const hasEdaAgentMenu = [...document.querySelectorAll('header *, [class*="header"] *, [class*="menu"] *')]
      .some((e) => e.children.length === 0 && vis(e) && (e.innerText || '').trim() === 'EDA Agent');

    let userDbName = null;
    let extensions = [];
    if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases();
      const userDbs = dbs.filter((d) => d && d.name && /^User_.*_v6$/.test(d.name));
      if (userDbs.length > 0) {
        userDbName = userDbs[0].name;
        extensions = await new Promise((resolve) => {
          const req = indexedDB.open(userDbName);
          req.onsuccess = () => {
            const db = req.result;
            const storeName = db.objectStoreNames.contains('extensionsIndex')
              ? 'extensionsIndex'
              : (db.objectStoreNames.contains('extensions') ? 'extensions' : null);
            if (!storeName) {
              db.close();
              resolve([]);
              return;
            }
            const tx = db.transaction([storeName], 'readonly');
            const getReq = tx.objectStore(storeName).getAll();
            getReq.onsuccess = () => {
              const rows = Array.isArray(getReq.result) ? getReq.result : [];
              resolve(rows.map((r) => {
                const pkg = r.packageInfo || r.manifest || {};
                return {
                  uuid: r.uuid,
                  name: pkg.displayName || pkg.name || r.uuid,
                  version: r.version || pkg.version || '',
                  isEnable: Boolean(r.isEnable),
                  isAllowExternalInteractions: Boolean(r.isAllowExternalInteractions),
                  isShowAtHeaderMenu: Boolean(r.isShowAtHeaderMenu),
                };
              }));
            };
            tx.oncomplete = () => db.close();
            tx.onerror = () => { db.close(); resolve([]); };
          };
          req.onerror = () => resolve([]);
        });
      }
    }
    const connector = extensions.find((x) => x.uuid === '${CONNECTOR_UUID}' || /EDA Agent Connector|easyeda-agent-connector/i.test(String(x.name || ''))) || null;
    return {
      url: location.href,
      title: document.title,
      visibilityState: document.visibilityState,
      loggedIn: !loginBtnVisible && Boolean(userDbName || !loginBtn),
      loginBtnVisible,
      userDbName,
      hasEdaAgentMenu,
      connector,
      extensions,
    };
  })()`);
}

async function attemptSsoLoginIfNeeded(page, browser, targetId) {
  await grantAndAllowPermissions(browser, targetId, { activate: true });
  const before = await readEditorExtensionStatus(page);
  if (!before.loginBtnVisible) {
    return { loggedIn: true, ssoTriggered: false, status: before };
  }
  await cdp.clickByBox(page, '#login-btn', LCEDA_GUARD);
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await cdp.sleep(600);
    await grantAndAllowPermissions(browser, targetId, { activate: false });
    const cur = await readEditorExtensionStatus(page);
    if (!cur.loginBtnVisible) {
      await cdp.sleep(1000);
      return { loggedIn: true, ssoTriggered: true, status: await readEditorExtensionStatus(page) };
    }
  }
  return {
    loggedIn: false,
    ssoTriggered: true,
    manualLoginRequired: true,
    reason: 'JLC SSO session is not active in this browser profile; complete login once in the dedicated browser window and re-run',
  };
}

async function closeExtensionManagerIfOpen(page) {
  await page.evalChecked(`(() => {
    const closeBtn = document.querySelector('button[data-test="Close"]');
    if (closeBtn) closeBtn.click();
    return Boolean(closeBtn);
  })()`).catch(() => {});
}

async function importAndEnableExtension(page, browser, opts = {}) {
  const statusBefore = await readEditorExtensionStatus(page);
  const targetUuid = opts.extensionUuid || CONNECTOR_UUID;
  const targetName = opts.extensionName || 'EDA Agent Connector';
  const existing = (statusBefore.extensions || []).find((x) => (
    x.uuid === targetUuid || String(x.name || '').toLowerCase().includes(targetName.toLowerCase())
  ));

  if (!opts.force && existing && existing.isEnable && existing.isAllowExternalInteractions) {
    return {
      ok: true,
      imported: false,
      reloaded: false,
      alreadyReady: true,
      extension: existing,
    };
  }

  const needFileUpload = Boolean(opts.force || !existing);
  const eextPath = needFileUpload ? resolveDefaultEextPath(opts.eextPath) : null;
  if (needFileUpload && !eextPath) {
    throw new Error('Connector extension is not installed in EasyEDA Pro and no local .eext package was found; pass --eext <path>');
  }

  await grantAndAllowPermissions(browser, page.targetId, { activate: true });

  // 1. 打开 顶部栏「高级」->「扩展管理器(E)...」
  const modalAlreadyOpen = await page.evalChecked(`Boolean(document.querySelector('button[data-test="Import"]'))`);
  if (!modalAlreadyOpen) {
    await cdp.clickByBox(page, 'text="高级"', LCEDA_GUARD, { keepHover: true, parkPointer: false });
    await cdp.sleep(350);
    const clickedExtMgr = await page.evalChecked(`(() => {
      const item = [...document.querySelectorAll('div,span,li,p')].find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 10 && r.height > 10 && e.children.length === 0 && /扩展管理器|Extension Manager/i.test((e.innerText || '').trim());
      });
      if (!item) return false;
      item.click();
      return true;
    })()`);
    if (!clickedExtMgr) {
      throw new Error('Could not find "扩展管理器(E)..." menu item under "高级"');
    }
    await cdp.waitFor(page, `Boolean(document.querySelector('button[data-test="Import"]'))`, { timeoutMs: 8000 });
  }

  // 2. 如尚未安装或显式强制覆盖，则通过 DOM.setFileInputFiles 静默注入 .eext
  if (needFileUpload && eextPath) {
    await page.send('DOM.enable');
    const doc = await page.send('DOM.getDocument', { depth: -1 });
    const q = await page.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'button[data-test="Import"] input[type="file"]',
    });
    if (!q || !q.nodeId) {
      throw new Error('Extension Manager file input (button[data-test="Import"] input[type="file"]) not found');
    }
    await page.send('DOM.setFileInputFiles', {
      nodeId: q.nodeId,
      files: [eextPath],
    });
    await page.evalChecked(`(() => {
      const inp = document.querySelector('button[data-test="Import"] input[type="file"]');
      if (inp) inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

    // 等待并确认「安全提示」弹窗
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const confirmed = await page.evalChecked(`(() => {
        const btns = [...document.querySelectorAll('button')].filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 10 && r.height > 10 && /^(确认|确定|Confirm|OK)$/i.test((b.innerText || '').trim());
        });
        if (btns.length > 0) {
          btns[btns.length - 1].click();
          return true;
        }
        return false;
      })()`);
      if (confirmed) break;
      await cdp.sleep(250);
    }
    await cdp.sleep(900);
  }

  // 3. 切到「已安装」页签 -> 选中目标扩展 -> 启用 -> 打开「配置」勾选「允许外部交互」与「显示在顶部菜单」
  await page.evalChecked(`(() => {
    const tab = [...document.querySelectorAll('span,p,div')].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 10 && r.height > 10 && e.children.length === 0 && /^(已安装|Installed)$/i.test((e.innerText || '').trim());
    });
    if (tab) tab.click();
    return Boolean(tab);
  })()`);
  await cdp.sleep(450);

  const selected = await page.evalChecked(`((nameHint) => {
    const rows = [...document.querySelectorAll('[class*="list-wrap"], [class*="item"]')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 80 && r.height > 20 && r.height < 120 && (e.innerText || '').toLowerCase().includes(nameHint.toLowerCase());
    });
    if (!rows.length) return false;
    rows[0].click();
    return true;
  })(${JSON.stringify(targetName)})`);
  if (!selected) {
    throw new Error(`Extension "${targetName}" not found under "已安装" tab after import`);
  }
  await cdp.sleep(400);

  // 若当前为禁用状态，点击「启用」
  await page.evalChecked(`(() => {
    const enableBtn = [...document.querySelectorAll('div,button,span')].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 10 && r.height > 10 && e.children.length === 0 && /^(启用|Enable)$/i.test((e.innerText || '').trim());
    });
    if (enableBtn) { enableBtn.click(); return true; }
    return false;
  })()`);
  await cdp.sleep(350);

  // 切到「配置」页签
  await page.evalChecked(`(() => {
    const cfgTab = [...document.querySelectorAll('p,span,div')].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 10 && r.height > 10 && e.children.length === 0 && /^(配置|Config|Settings)$/i.test((e.innerText || '').trim());
    });
    if (cfgTab) { cfgTab.click(); return true; }
    return false;
  })()`);
  await cdp.sleep(350);

  // 勾选「允许外部交互」与「显示在顶部菜单」
  const toggled = await page.evalChecked(`(() => {
    const changes = {};
    for (const key of ['Allow interactive with external', 'Show at header menu']) {
      const inp = document.querySelector('input[data-test="' + key + '"]');
      if (inp && !inp.checked) {
        const lbl = inp.closest('label') || inp.parentElement || inp;
        lbl.click();
        changes[key] = true;
      } else if (inp) {
        changes[key] = false;
      }
    }
    return changes;
  })()`);
  await cdp.sleep(400);
  await closeExtensionManagerIfOpen(page);
  await cdp.sleep(350);

  // 4. 首次导入或新开启外部交互权限后，安全重载一次页面（仅在无未保存画布或显式导入场景）以挂载 eda.sys_WebSocket
  let reloaded = false;
  if (opts.reloadAfterImport !== false && (needFileUpload || toggled['Allow interactive with external'])) {
    await grantAndAllowPermissions(browser, page.targetId, { activate: true });
    await page.send('Page.reload', { ignoreCache: false });
    reloaded = true;
    await cdp.sleep(2000);
    await waitForEditorDomReady(page, 20000);
    await grantAndAllowPermissions(browser, page.targetId, { activate: true });
  }

  const statusAfter = await readEditorExtensionStatus(page);
  const extAfter = (statusAfter.extensions || []).find((x) => (
    x.uuid === targetUuid || String(x.name || '').toLowerCase().includes(targetName.toLowerCase())
  )) || statusAfter.connector;

  return {
    ok: Boolean(extAfter && extAfter.isEnable && extAfter.isAllowExternalInteractions),
    imported: needFileUpload,
    eextPath: eextPath || undefined,
    toggled,
    reloaded,
    extension: extAfter,
  };
}

async function softReconnect(page, browser, opts = {}) {
  await grantAndAllowPermissions(browser, page.targetId, { activate: true });
  await page.send('Page.bringToFront').catch(() => {});

  // 唤醒页面可见性与焦点事件，并通过可信鼠标点击顶部栏「EDA Agent -> Reconnect」
  await page.evalChecked(`(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    return true;
  })()`).catch(() => {});

  let menuFound = false;
  let reconnectClicked = false;
  try {
    await cdp.clickByBox(page, 'text="EDA Agent"', LCEDA_GUARD, { keepHover: true, parkPointer: false });
    menuFound = true;
    await cdp.sleep(320);
    reconnectClicked = await page.evalChecked(`(() => {
      const reconn = [...document.querySelectorAll('div,span,li,p')]
        .find((e) => e.children.length === 0 && e.getBoundingClientRect().width > 8 && /^(Reconnect|重新连接)$/i.test((e.innerText || '').trim()));
      if (reconn) {
        (reconn.closest('li, [role="menuitem"], div') || reconn).click();
        return true;
      }
      document.body.click();
      return false;
    })()`);
  } catch {}
  const clickedMenu = { menuFound, reconnectClicked };

  await cdp.sleep(500);
  await grantAndAllowPermissions(browser, page.targetId, { activate: false });

  const timeoutMs = Number(opts.timeoutMs) || 8000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await readDaemonHealth(opts);
    if (h.connectorOk) {
      return { ok: true, ...clickedMenu, health: h };
    }
    await cdp.sleep(400);
  }
  const finalHealth = await readDaemonHealth(opts);
  return { ok: finalHealth.connectorOk, ...clickedMenu, health: finalHealth };
}

async function getFullLcedaStatus(spec, opts = {}) {
  const daemon = await readDaemonHealth(opts);
  const cdpAlive = await probeCdpPort(spec.port);
  if (!cdpAlive) {
    return {
      ok: daemon.daemonOk && daemon.connectorOk,
      scene: spec.scene,
      browserPort: spec.port,
      browserAlive: false,
      daemon,
      editor: null,
    };
  }
  sceneMod.applySceneToEnv(spec);
  const browser = await connectBrowserCompat();
  try {
    const targets = await cdp.listTargets(browser);
    const editorTarget = (targets || []).find((t) => t.type === 'page' && String(t.url || '').includes('lceda.cn'));
    if (!editorTarget) {
      return {
        ok: daemon.daemonOk && daemon.connectorOk,
        scene: spec.scene,
        browserPort: spec.port,
        browserAlive: true,
        daemon,
        editor: null,
      };
    }
    let editor = null;
    await cdp.withLeasedTarget({ id: editorTarget.id }, {
      port: spec.port,
      readOnly: true,
      ownerTag: 'abb:lceda-status',
    }, async (page) => {
      editor = await readEditorExtensionStatus(page);
    });
    return {
      ok: Boolean(daemon.daemonOk && daemon.connectorOk && editor && editor.loggedIn),
      scene: spec.scene,
      browserPort: spec.port,
      browserAlive: true,
      targetId: editorTarget.id,
      daemon,
      editor,
    };
  } finally {
    browser.close();
  }
}

async function ensureEasyEdaReady(spec, opts = {}) {
  // 1. 确保 easyeda daemon 在线（若已在跑绝不重启）
  const daemonInit = await ensureDaemonRunning(opts);

  // 2. 快速幂等短路：若已有健康连接窗口（且满足指定 projectUuid），直接零打扰返回！
  const matchWindow = (windows) => {
    if (!Array.isArray(windows) || windows.length === 0) return null;
    if (opts.projectUuid) {
      return windows.find((w) => w.context && w.context.projectUuid === opts.projectUuid) || null;
    }
    return windows[0];
  };

  const alreadyMatched = !opts.forceReconnect && !opts.forceImport ? matchWindow(daemonInit.windows) : null;
  if (alreadyMatched) {
    return {
      ok: true,
      mode: 'already-connected',
      scene: spec.scene,
      browserPort: spec.port,
      daemonPort: daemonInit.port,
      startedDaemon: daemonInit.startedDaemon,
      startedBrowser: false,
      windowId: alreadyMatched.windowId,
      projectUuid: alreadyMatched.context?.projectUuid || null,
      projectName: alreadyMatched.context?.projectName || null,
      pageVisibility: alreadyMatched.context?.pageVisibility || null,
      connectedWindows: daemonInit.windows.length,
    };
  }

  // 3. 确保防休眠专用调试浏览器在线
  const browserBoot = await ensureDebugBrowserRunning(spec, opts);
  sceneMod.applySceneToEnv(spec);

  const browser = await connectBrowserCompat();
  let tabInfo;
  try {
    tabInfo = await ensureEditorTabTarget(browser, { targetId: opts.targetId });
    await grantAndAllowPermissions(browser, tabInfo.targetId, { activate: true });
  } finally {
    browser.close();
  }

  // 4. 在目标编辑器标签页租约内执行：登录检查 -> 扩展幂等导入与外部交互开启 -> 软重连唤醒
  let stepResult = null;
  await cdp.withLeasedTarget({ id: tabInfo.targetId }, {
    port: spec.port,
    ownerTag: 'abb:lceda-ensure',
  }, async (page) => {
    const innerBrowser = await connectBrowserCompat();
    try {
      await waitForEditorDomReady(page, 20000);
      const loginRes = await attemptSsoLoginIfNeeded(page, innerBrowser, tabInfo.targetId);
      if (!loginRes.loggedIn) {
        stepResult = {
          ok: false,
          mode: 'login-required',
          ...loginRes,
        };
        return;
      }

      const extRes = await importAndEnableExtension(page, innerBrowser, {
        eextPath: opts.eextPath,
        force: Boolean(opts.forceImport),
      });

      let healthNow = await readDaemonHealth(opts);
      let reconnectRes = null;
      if (!healthNow.connectorOk || opts.forceReconnect) {
        reconnectRes = await softReconnect(page, innerBrowser, { timeoutMs: opts.timeoutMs || 8000 });
        healthNow = reconnectRes.health;
      }

      // 兜底：若该标签页停在首页（无打开工程）且软重连仍未连上，安全刷新一次挂载连接器
      if (!healthNow.connectorOk) {
        await grantAndAllowPermissions(innerBrowser, tabInfo.targetId, { activate: true });
        await page.send('Page.reload', { ignoreCache: false });
        await cdp.sleep(2200);
        await waitForEditorDomReady(page, 20000);
        await grantAndAllowPermissions(innerBrowser, tabInfo.targetId, { activate: true });
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          healthNow = await readDaemonHealth(opts);
          if (healthNow.connectorOk) break;
          await cdp.sleep(400);
        }
        if (!healthNow.connectorOk) {
          reconnectRes = await softReconnect(page, innerBrowser, { timeoutMs: opts.timeoutMs || 10000 });
          healthNow = reconnectRes.health;
        }
      }

      // 5. 如指定了 --project-uuid 且当前没有任何已连接窗口持有该工程，则在空闲窗口中打开目标工程
      let openedProject = false;
      if (healthNow.connectorOk && opts.projectUuid) {
        const holder = matchWindow(healthNow.windows);
        if (!holder) {
          const idleWin = healthNow.windows.find((w) => !w.context || !w.context.projectUuid);
          const bin = resolveEasyEdaBin(opts.easyedaBin);
          if (idleWin && bin) {
            execFileSync(bin, [
              'project', 'open',
              '--window', idleWin.windowId,
              '--project-uuid', opts.projectUuid,
              '--allow-discard-unsaved',
            ], {
              encoding: 'utf8',
              timeout: 20000,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            openedProject = true;
            await cdp.sleep(1000);
            healthNow = await readDaemonHealth(opts);
          }
        }
      }

      const chosen = matchWindow(healthNow.windows) || healthNow.windows[0] || null;
      stepResult = {
        ok: Boolean(healthNow.daemonOk && healthNow.connectorOk && (!opts.projectUuid || (chosen && chosen.context?.projectUuid === opts.projectUuid))),
        mode: extRes.imported ? 'imported-and-connected' : 'healed-and-connected',
        scene: spec.scene,
        browserPort: spec.port,
        targetId: tabInfo.targetId,
        createdTab: tabInfo.createdTab,
        startedDaemon: daemonInit.startedDaemon,
        startedBrowser: browserBoot.startedBrowser,
        importedExtension: extRes.imported,
        reloaded: extRes.reloaded,
        openedProject,
        daemonPort: healthNow.port,
        windowId: chosen ? chosen.windowId : null,
        projectUuid: chosen?.context?.projectUuid || null,
        projectName: chosen?.context?.projectName || null,
        pageVisibility: chosen?.context?.pageVisibility || null,
        connectedWindows: healthNow.windows.length,
        extension: extRes.extension || null,
      };
    } finally {
      innerBrowser.close();
    }
  });

  return stepResult;
}

module.exports = {
  CONNECTOR_UUID,
  LCEDA_EDITOR_URL,
  LCEDA_ORIGIN,
  LCEDA_GUARD,
  resolveEasyEdaBin,
  resolveDefaultEextPath,
  readDaemonHealth,
  ensureDaemonRunning,
  ensureDebugBrowserRunning,
  grantAndAllowPermissions,
  ensureEditorTabTarget,
  readEditorExtensionStatus,
  attemptSsoLoginIfNeeded,
  importAndEnableExtension,
  softReconnect,
  getFullLcedaStatus,
  ensureEasyEdaReady,
};
