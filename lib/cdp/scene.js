// AgentBrowserBridge / GcWebAuto - 场景预设、专用实例自动发现与跨进程 @ref 状态持久化
// 目标：消灭每次 CLI 调用手填 5 个环境变量的繁琐仪式感，并让 @e1 快照引用跨命令持久可用。
// 安全底线：仅匹配专用桥接配置目录（%LOCALAPPDATA%\AgentBrowserBridge\profiles\* 或 C:\ChromeDebugProfile*），绝不接管日常默认浏览器目录。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { RefMap, hydrateRefMap } = require('./locator');
const { flag, classifyBrowser } = require('./identity');

const K3_ANY_GUARD = "location.href.toLowerCase().includes('k3cloud') || !!document.querySelector('.kd-fullsearch-searchicon, .k-grid, #btnLogin')";
const LCEDA_ANY_GUARD = "location.hostname.toLowerCase().includes('lceda.cn') || location.hostname.toLowerCase().includes('jlc.com') || location.href === 'about:blank'";

const SCENE_PRESETS = {
  k3: {
    key: 'k3',
    aliases: ['k3', 'k3cloud', 'kingdee'],
    browser: 'edge',
    profileScene: 'K3Cloud',
    defaultPort: 9224,
    proxy: 'none',
    urlIncludes: 'k3cloud',
    defaultUrl: 'http://10.1.3.38/k3cloud',
    defaultGuard: K3_ANY_GUARD,
    description: '金蝶云星空普通业务端 (Edge-K3Cloud, 默认端口 9224)',
  },
  'k3-admin': {
    key: 'k3-admin',
    aliases: ['k3-admin', 'k3admin', 'k3_admin', 'k3cloudadmin', 'kingdee-admin'],
    browser: 'edge',
    profileScene: 'K3CloudAdmin',
    defaultPort: 9232,
    proxy: 'none',
    urlIncludes: 'k3cloud',
    defaultUrl: 'http://10.1.3.38/k3cloud',
    defaultGuard: K3_ANY_GUARD,
    description: '金蝶云星空管理中心/administrator专用端 (Edge-K3CloudAdmin, 默认端口 9232)',
  },
  etax: {
    key: 'etax',
    aliases: ['etax', 'etax-gd', 'tax'],
    browser: 'edge',
    profileScene: 'etax',
    fallbackProfileScene: 'K3Cloud',
    defaultPort: 9226,
    proxy: 'none',
    urlIncludes: 'chinatax.gov.cn',
    defaultUrl: 'https://etax.guangdong.chinatax.gov.cn',
    defaultGuard: "location.href.toLowerCase().includes('chinatax.gov.cn')",
    description: '电子税务局专用端 (Edge-etax / Edge-K3Cloud)',
  },
  lceda: {
    key: 'lceda',
    aliases: ['lceda', 'easyeda', 'jlceda', 'eda'],
    browser: 'edge',
    profileScene: 'LCEDA',
    fallbackProfileScene: 'K3Cloud',
    defaultPort: 9234,
    proxy: 'none',
    urlIncludes: 'lceda.cn',
    defaultUrl: 'https://pro.lceda.cn/editor',
    defaultGuard: LCEDA_ANY_GUARD,
    description: '嘉立创EDA专业版防休眠专用端 (Edge-LCEDA 默认端口 9234 / 自动回退复用已登录 Edge-K3Cloud 9224)',
  },
  chrome: {
    key: 'chrome',
    aliases: ['chrome', 'gcwebauto', 'chrome-debug'],
    browser: 'chrome',
    explicitProfile: process.platform === 'win32' ? 'C:\\ChromeDebugProfile' : path.join(os.homedir(), '.chrome-debug-profile'),
    defaultPort: 9222,
    proxy: 'none',
    urlIncludes: '',
    defaultUrl: 'about:blank',
    defaultGuard: "location.protocol === 'http:' || location.protocol === 'https:' || location.href === 'about:blank'",
    description: '公司共享底座 Chrome 专用调试实例 (ChromeDebugProfile, 默认端口 9222)',
  },
  smoke: {
    key: 'smoke',
    aliases: ['smoke'],
    browser: 'edge',
    profileScene: 'smoke',
    defaultPort: 9229,
    proxy: 'none',
    urlIncludes: 'about:blank',
    defaultUrl: 'about:blank',
    defaultGuard: 'true',
    description: '隔离冒烟测试专用实例 (Edge-smoke, about:blank)',
  },
};

function profilesRootDir(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), '.agent-browser-bridge');
  return path.join(base, 'AgentBrowserBridge', 'profiles');
}

function isDailyUserProfile(profilePath, env = process.env) {
  if (!profilePath) return false;
  const resolved = path.resolve(profilePath);
  const norm = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const localApp = env.LOCALAPPDATA || '';
  if (!localApp) return false;
  const dailyDirs = [
    path.resolve(localApp, 'Microsoft', 'Edge', 'User Data'),
    path.resolve(localApp, 'Google', 'Chrome', 'User Data'),
  ];
  for (const d of dailyDirs) {
    const dn = process.platform === 'win32' ? d.toLowerCase() : d;
    if (norm === dn || norm.startsWith(dn + path.sep)) return true;
  }
  return false;
}

function readDevToolsActivePortSafe(profileDir) {
  try {
    const file = path.join(profileDir, 'DevToolsActivePort');
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const port = Number(lines[0]);
    const browserPath = String(lines[1] || '').trim();
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
    return { port, browserPath };
  } catch {
    return null;
  }
}

async function probeCdpEndpoint(port, timeoutMs = 600) {
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

let cachedProcScan = { at: 0, list: [] };
function scanLiveDebugMainProcesses(env = process.env) {
  if (Date.now() - cachedProcScan.at < 3000) return cachedProcScan.list;
  const out = [];
  if (process.platform === 'win32') {
    const ps = "$ErrorActionPreference='SilentlyContinue'; @(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | Where-Object { $_.CommandLine -and ($_.CommandLine -notmatch '(?:^|\\s)--type=') -and ($_.CommandLine -match '--remote-debugging-port=') } | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; name=$_.Name; command=$_.CommandLine } }) | ConvertTo-Json -Compress";
    for (const exe of ['pwsh.exe', 'powershell.exe']) {
      try {
        const raw = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', ps], {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (!raw) break;
        const parsed = JSON.parse(raw);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        for (const r of rows) {
          if (!r || !r.command) continue;
          let port = 0;
          let userDataDir = '';
          try {
            port = Number(flag(r.command, '--remote-debugging-port') || 0);
            userDataDir = String(flag(r.command, '--user-data-dir') || '');
          } catch {
            continue;
          }
          if (!port || !userDataDir || isDailyUserProfile(userDataDir, env)) continue;
          const browser = classifyBrowser(r.name) || 'edge';
          const baseName = path.basename(path.resolve(userDataDir));
          const m = /^(Edge|Chrome)-(.+)$/i.exec(baseName);
          out.push({
            pid: Number(r.pid),
            browser,
            port,
            profile: path.resolve(userDataDir),
            name: baseName,
            sceneName: m ? m[2] : (baseName.toLowerCase().includes('chromedebugprofile') ? 'chrome' : baseName),
          });
        }
        break;
      } catch {}
    }
  }
  cachedProcScan = { at: Date.now(), list: out };
  return out;
}

function listKnownProfileCandidates(env = process.env) {
  const liveProcs = scanLiveDebugMainProcesses(env);
  const portByNormProfile = new Map();
  for (const p of liveProcs) {
    const k = process.platform === 'win32' ? p.profile.toLowerCase() : p.profile;
    portByNormProfile.set(k, p.port);
  }
  const candidates = [];
  const root = profilesRootDir(env);
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.resolve(root, entry.name);
      if (isDailyUserProfile(fullPath, env)) continue;
      const m = /^(Edge|Chrome)-(.+)$/i.exec(entry.name);
      const browser = m ? m[1].toLowerCase() : 'edge';
      const sceneName = m ? m[2] : entry.name;
      const active = readDevToolsActivePortSafe(fullPath);
      const normP = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
      candidates.push({
        name: entry.name,
        sceneName,
        browser,
        profile: fullPath,
        activePort: portByNormProfile.get(normP) || (active ? active.port : null),
      });
    }
  }
  if (process.platform === 'win32' && fs.existsSync('C:\\ChromeDebugProfile')) {
    const fullPath = path.resolve('C:\\ChromeDebugProfile');
    const active = readDevToolsActivePortSafe(fullPath);
    const normP = fullPath.toLowerCase();
    candidates.push({
      name: 'ChromeDebugProfile',
      sceneName: 'chrome',
      browser: 'chrome',
      profile: fullPath,
      activePort: portByNormProfile.get(normP) || (active ? active.port : null),
    });
  }
  return candidates;
}

async function discoverLiveDedicatedInstances(env = process.env) {
  const candidates = listKnownProfileCandidates(env);
  const live = [];
  const checkedPorts = new Set();
  for (const c of candidates) {
    if (!c.activePort || checkedPorts.has(c.activePort)) continue;
    checkedPorts.add(c.activePort);
    const ver = await probeCdpEndpoint(c.activePort, 500);
    if (!ver) continue;
    const actualBrowser = /Edg\//i.test(ver.Browser) ? 'edge' : /Chrome\//i.test(ver.Browser) ? 'chrome' : c.browser;
    if (actualBrowser !== c.browser) continue;
    live.push({
      scene: c.sceneName,
      name: c.name,
      port: c.activePort,
      browser: actualBrowser,
      browserVersion: ver.Browser,
      profile: c.profile,
      endpoint: `http://127.0.0.1:${c.activePort}`,
    });
  }
  return live.sort((a, b) => a.port - b.port);
}

function findPreset(sceneInput) {
  if (!sceneInput) return null;
  const norm = String(sceneInput).trim().toLowerCase();
  for (const preset of Object.values(SCENE_PRESETS)) {
    if (preset.aliases.includes(norm) || preset.profileScene?.toLowerCase() === norm) {
      return preset;
    }
  }
  return null;
}

function resolveScene(options = {}, env = process.env) {
  const sceneRaw = options.scene || env.ABB_SCENE || '';
  const portOverride = options.port ? Number(options.port) : undefined;
  const root = profilesRootDir(env);
  const preset = findPreset(sceneRaw);

  if (preset) {
    let profile = preset.explicitProfile || path.join(root, `${preset.browser === 'chrome' ? 'Chrome' : 'Edge'}-${preset.profileScene}`);
    if (!fs.existsSync(profile) && preset.fallbackProfileScene) {
      const fallback = path.join(root, `${preset.browser === 'chrome' ? 'Chrome' : 'Edge'}-${preset.fallbackProfileScene}`);
      if (fs.existsSync(fallback)) profile = fallback;
    }
    if (isDailyUserProfile(profile, env)) {
      throw new Error(`Refusing daily browser profile: ${profile}`);
    }
    const resolvedProfile = path.resolve(profile);
    const normProfile = process.platform === 'win32' ? resolvedProfile.toLowerCase() : resolvedProfile;
    const liveHit = !portOverride && fs.existsSync(resolvedProfile)
      ? scanLiveDebugMainProcesses(env).find((p) => (process.platform === 'win32' ? p.profile.toLowerCase() : p.profile) === normProfile)
      : null;
    const active = readDevToolsActivePortSafe(resolvedProfile);
    const port = portOverride || (liveHit ? liveHit.port : (active ? active.port : preset.defaultPort));
    return {
      scene: preset.key,
      browser: preset.browser,
      port,
      profile: resolvedProfile,
      proxy: options.proxy || preset.proxy || 'none',
      urlIncludes: options.urlIncludes ?? preset.urlIncludes ?? '',
      defaultUrl: preset.defaultUrl || 'about:blank',
      defaultGuard: options.guard || preset.defaultGuard || 'true',
    };
  }

  if (sceneRaw) {
    const cleaned = String(sceneRaw).trim().replace(/^(Edge|Chrome)-/i, '');
    const browserHint = /^chrome-/i.test(sceneRaw) ? 'chrome' : (options.browser || 'edge').toLowerCase();
    const prefix = browserHint === 'chrome' ? 'Chrome' : 'Edge';
    const profile = path.resolve(root, `${prefix}-${cleaned}`);
    if (isDailyUserProfile(profile, env)) {
      throw new Error(`Refusing daily browser profile: ${profile}`);
    }
    const normProfile = process.platform === 'win32' ? profile.toLowerCase() : profile;
    const liveHit = !portOverride && fs.existsSync(profile)
      ? scanLiveDebugMainProcesses(env).find((p) => (process.platform === 'win32' ? p.profile.toLowerCase() : p.profile) === normProfile)
      : null;
    const active = readDevToolsActivePortSafe(profile);
    const port = portOverride || (liveHit ? liveHit.port : (active ? active.port : 9222));
    return {
      scene: cleaned,
      browser: browserHint,
      port,
      profile,
      proxy: options.proxy || 'none',
      urlIncludes: options.urlIncludes || '',
      defaultUrl: 'about:blank',
      defaultGuard: options.guard || "location.protocol === 'http:' || location.protocol === 'https:' || location.href === 'about:blank'",
    };
  }

  if (portOverride) {
    const candidates = listKnownProfileCandidates(env);
    const hit = candidates.find((c) => c.activePort === portOverride);
    if (hit) {
      const explicitNonK3Url = options.urlIncludes && !String(options.urlIncludes).toLowerCase().includes('k3cloud');
      return {
        scene: hit.sceneName,
        browser: hit.browser,
        port: portOverride,
        profile: path.resolve(hit.profile),
        proxy: options.proxy || 'none',
        urlIncludes: options.urlIncludes || (portOverride === 9224 || portOverride === 9232 ? 'k3cloud' : ''),
        defaultUrl: 'about:blank',
        defaultGuard: options.guard || ((!explicitNonK3Url && (portOverride === 9224 || portOverride === 9232)) ? K3_ANY_GUARD : "location.protocol === 'http:' || location.protocol === 'https:' || location.href === 'about:blank'"),
      };
    }
    if (portOverride === 9224) return resolveScene({ ...options, scene: 'k3' }, env);
    if (portOverride === 9232) return resolveScene({ ...options, scene: 'k3-admin' }, env);
    if (portOverride === 9222 && process.platform === 'win32' && fs.existsSync('C:\\ChromeDebugProfile')) {
      return resolveScene({ ...options, scene: 'chrome' }, env);
    }
    throw new Error(`Cannot match port ${portOverride} to a known dedicated profile under ${root}; pass --scene <SceneName> explicitly`);
  }

  // 若调用方已手工设置 BROWSER_BRIDGE_EXPECT_PROFILE / GCWEBAUTO_EXPECT_PROFILE，直接沿用
  const existingProfile = env.BROWSER_BRIDGE_EXPECT_PROFILE || env.GCWEBAUTO_EXPECT_PROFILE;
  const existingPort = Number(env.BROWSER_BRIDGE_EXPECT_PORT || env.GCWEBAUTO_EXPECT_PORT || (env.CDP_HTTP ? new URL(env.CDP_HTTP).port : 0));
  if (existingProfile && existingPort) {
    return {
      scene: 'env',
      browser: (env.BROWSER_BRIDGE_EXPECT_BROWSER || env.GCWEBAUTO_EXPECT_BROWSER || 'edge').toLowerCase(),
      port: existingPort,
      profile: path.resolve(existingProfile),
      proxy: env.BROWSER_BRIDGE_EXPECT_PROXY || env.GCWEBAUTO_EXPECT_PROXY || 'none',
      urlIncludes: options.urlIncludes || '',
      defaultUrl: 'about:blank',
      defaultGuard: options.guard || "location.protocol === 'http:' || location.protocol === 'https:' || location.href === 'about:blank'",
    };
  }

  // 若本地 automation.json 配置了专用浏览器实例（非日常用户配置目录），优先采用该本机默认实例
  const localAutomationPath = env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, 'AgentBrowserBridge', 'automation.json')
    : path.join(os.homedir(), '.config', 'agent-browser-bridge', 'automation.json');
  try {
    if (fs.existsSync(localAutomationPath)) {
      const parsedCfg = JSON.parse(fs.readFileSync(localAutomationPath, 'utf8').replace(/^\uFEFF/, ''));
      const bCfg = parsedCfg && typeof parsedCfg === 'object' ? parsedCfg.browser : null;
      if (bCfg && typeof bCfg.endpoint === 'string' && typeof bCfg.profile === 'string' && !isDailyUserProfile(bCfg.profile, env)) {
        const cfgPort = Number(new URL(bCfg.endpoint).port);
        if (Number.isInteger(cfgPort) && cfgPort >= 1024 && cfgPort <= 65535) {
          return {
            scene: 'config',
            browser: String(bCfg.browser || 'edge').toLowerCase(),
            port: cfgPort,
            profile: path.resolve(bCfg.profile),
            proxy: options.proxy || bCfg.proxy || 'none',
            urlIncludes: options.urlIncludes || '',
            defaultUrl: 'about:blank',
            defaultGuard: options.guard || "location.protocol === 'http:' || location.protocol === 'https:' || location.href === 'about:blank'",
          };
        }
      }
    }
  } catch {}

  // 默认回退到 k3 (9224)
  return resolveScene({ ...options, scene: 'k3' }, env);
}

function applySceneToEnv(optionsOrResolved = {}, env = process.env) {
  const spec = optionsOrResolved && optionsOrResolved.profile && optionsOrResolved.port
    ? optionsOrResolved
    : resolveScene(optionsOrResolved, env);
  env.CDP_HTTP = `http://127.0.0.1:${spec.port}`;
  env.BROWSER_BRIDGE_REQUIRE_INSTANCE = '1';
  env.BROWSER_BRIDGE_EXPECT_PORT = String(spec.port);
  env.BROWSER_BRIDGE_EXPECT_PROFILE = spec.profile;
  env.BROWSER_BRIDGE_EXPECT_BROWSER = spec.browser;
  env.BROWSER_BRIDGE_EXPECT_PROXY = spec.proxy || 'none';

  env.GCWEBAUTO_REQUIRE_INSTANCE = '1';
  env.GCWEBAUTO_EXPECT_PORT = String(spec.port);
  env.GCWEBAUTO_EXPECT_PROFILE = spec.profile;
  env.GCWEBAUTO_EXPECT_BROWSER = spec.browser;
  env.GCWEBAUTO_EXPECT_PROXY = spec.proxy || 'none';
  return spec;
}

function resolveStateDir(env = process.env) {
  const custom = env.BROWSER_BRIDGE_STATE_DIR || env.GCWEBAUTO_STATE_DIR;
  if (custom) {
    const dir = path.resolve(custom);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const base = env.LOCALAPPDATA || path.join(os.homedir(), '.agent-browser-bridge');
  const dir = path.join(base, 'AgentBrowserBridge', 'state');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    const fallback = path.join(os.tmpdir(), 'agent-browser-bridge-state');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function sanitizeId(id) {
  return String(id || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function refStateFilePath(port, targetId, env = process.env) {
  return path.join(resolveStateDir(env), `refs-${Number(port) || 0}-${sanitizeId(targetId)}.json`);
}

function saveRefState(port, targetId, snapshotResult, refMap, env = process.env) {
  const file = refStateFilePath(port, targetId, env);
  const serializedMap = refMap instanceof RefMap
    ? refMap.toJSON()
    : (refMap && typeof refMap.toJSON === 'function' ? refMap.toJSON() : { entries: [] });
  const payload = {
    savedAt: Date.now(),
    port: Number(port),
    targetId: String(targetId || ''),
    url: String(snapshotResult?.url || ''),
    title: String(snapshotResult?.title || ''),
    snapshotText: String(snapshotResult?.text || ''),
    refMap: serializedMap,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function loadRefState(port, targetId, options = {}, env = process.env) {
  const maxAgeMs = Number(options.maxAgeMs) || 30 * 60 * 1000;
  const file = refStateFilePath(port, targetId, env);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    if (raw.savedAt && Date.now() - raw.savedAt > maxAgeMs) return null;
    return {
      ...raw,
      hydrate(cdpClient) {
        return hydrateRefMap(cdpClient, raw.refMap);
      },
    };
  } catch {
    return null;
  }
}

function listScenes() {
  return Object.values(SCENE_PRESETS).map((p) => ({
    scene: p.key,
    aliases: p.aliases,
    browser: p.browser,
    defaultPort: p.defaultPort,
    urlIncludes: p.urlIncludes,
    description: p.description,
  }));
}

module.exports = {
  K3_ANY_GUARD,
  LCEDA_ANY_GUARD,
  SCENE_PRESETS,
  listScenes,
  resolveScene,
  applySceneToEnv,
  discoverLiveDedicatedInstances,
  resolveStateDir,
  saveRefState,
  loadRefState,
  isDailyUserProfile,
};
