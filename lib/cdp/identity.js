const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveConfig } = require('./config');

const VERIFY_CACHE_TTL_MS = 5000;
const PERSISTED_VERIFY_CACHE_TTL_MS = 60000;
let lastVerifiedCache = null;

async function fetchLoopbackBrowserWsUrl(port) {
  const numPort = Number(port);
  if (!Number.isInteger(numPort) || numPort < 1024 || numPort > 65535) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${numPort}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const wsUrl = typeof data?.webSocketDebuggerUrl === 'string' ? data.webSocketDebuggerUrl : '';
    if (!wsUrl.startsWith(`ws://127.0.0.1:${numPort}/devtools/browser/`)) return null;
    return wsUrl;
  } catch {
    return null;
  }
}

function identityCacheFilePath(port) {
  const custom = process.env.BROWSER_BRIDGE_STATE_DIR || process.env.GCWEBAUTO_STATE_DIR;
  const baseDir = custom
    ? path.resolve(custom)
    : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.agent-browser-bridge'), 'AgentBrowserBridge', 'state');
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    return path.join(baseDir, `identity-verified-${Number(port) || 0}.json`);
  } catch {
    return null;
  }
}

function readActivePortSignature(profileDir) {
  if (!profileDir) return null;
  try {
    return fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').trim();
  } catch {
    return null;
  }
}

async function readPersistedVerified(port, cacheKey, profileDir) {
  const file = identityCacheFilePath(port);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.key !== cacheKey || !parsed.result) return null;
    if (Date.now() - Number(parsed.at || 0) >= PERSISTED_VERIFY_CACHE_TTL_MS) return null;
    const pid = Number(parsed.result.pid);
    if (!isPidAlive(pid)) return null;
    if (parsed.activePortSig && readActivePortSignature(profileDir) !== parsed.activePortSig) return null;
    if (typeof parsed.browserWsUrl === 'string' && parsed.browserWsUrl.startsWith(`ws://127.0.0.1:${Number(port)}/devtools/browser/`)) {
      const liveWsUrl = await fetchLoopbackBrowserWsUrl(port);
      if (liveWsUrl === parsed.browserWsUrl) return parsed;
      if (liveWsUrl && liveWsUrl !== parsed.browserWsUrl) return null;
    }
    const fastNet = parseListeningPortViaNetstat(port);
    if (!fastNet || !fastNet.found || !fastNet.loopback || fastNet.pids.length !== 1 || fastNet.pids[0] !== pid) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePersistedVerified(port, cacheKey, result, activePortSig, browserWsUrl) {
  const file = identityCacheFilePath(port);
  if (!file) return;
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      key: cacheKey,
      at: Date.now(),
      activePortSig: activePortSig || null,
      browserWsUrl: browserWsUrl || null,
      result,
    }), 'utf8');
    fs.renameSync(tmp, file);
  } catch {}
}

function isPidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || pid <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function flag(command, key) {
  const escaped = key.replace(/[^a-z0-9-]/gi, '\\$&');
  const matches = [...command.matchAll(new RegExp('(?:^|\\s)' + escaped + '(?:=|\\s+)(?:"([^"]*)"|([^\\s]+))', 'g'))];
  if (matches.length > 1) throw new Error('Ambiguous duplicate browser flag: ' + key);
  return matches[0] ? matches[0][1] || matches[0][2] : undefined;
}

function classifyBrowser(name) {
  const value = String(name || '').toLowerCase();
  if (value.includes('msedge')) return 'edge';
  if (value.includes('chromium')) return 'chromium';
  if (value.includes('chrome')) return 'chrome';
  return null;
}

function validateProcess(info, config) {
  const browser = classifyBrowser(info && info.name);
  if (!info || !Number.isInteger(Number(info.pid)) || !browser || !info.loopback) {
    throw new Error('CDP listener is not a verified local Chromium browser');
  }
  if (config.browser && config.browser !== browser && !(config.browser === 'chromium' && browser === 'chrome')) {
    throw new Error('Browser type mismatch: expected ' + config.browser + ', got ' + browser);
  }
  if (typeof info.command !== 'string' || !info.command.trim()) throw new Error('Cannot read browser process identity; run in the browser owner session');
  if (/(?:^|\s)--type=/.test(info.command)) throw new Error('CDP listener must be browser main process');
  if (config.attachExisting) {
    if (browser !== 'edge') throw new Error('Existing-profile attachment is supported only for Microsoft Edge');
    if (!info.executablePath || !/\\Microsoft\\Edge\\Application\\msedge\.exe$/i.test(info.executablePath)) throw new Error('Existing Edge executable path is not verified');
    if (info.signatureStatus !== 'Valid' || !/CN=Microsoft Corporation/i.test(info.signerSubject || '')) throw new Error('Existing Edge executable signature is not verified as Microsoft-signed');
    if (!info.activePort || Number(info.activePort.port) !== config.port || !/^\/devtools\/browser\/[0-9a-f-]+$/i.test(info.activePort.browserPath || '')) {
      throw new Error('Existing Edge DevToolsActivePort does not match the selected local endpoint');
    }
    const commandPort = flag(info.command, '--remote-debugging-port');
    if (commandPort && Number(commandPort) !== 0 && Number(commandPort) !== config.port) throw new Error('Existing Edge command-line port conflicts with DevToolsActivePort');
    const actualDir = flag(info.command, '--user-data-dir');
    const normalizeExisting = value => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
    if (actualDir && normalizeExisting(actualDir) !== normalizeExisting(config.profile)) throw new Error('Existing Edge profile does not match the default user data directory');
    const actualProxy = flag(info.command, '--proxy-server');
    if (config.proxy === 'none' && (flag(info.command, '--proxy-pac-url') || /(?:^|\s)--proxy-auto-detect(?:\s|$)/.test(info.command))) {
      throw new Error('Unexpected browser proxy auto-configuration');
    }
    if (config.proxy === 'none' ? Boolean(actualProxy) : actualProxy !== config.proxy) throw new Error('Browser proxy mismatch');
    return { ok: true, pid: Number(info.pid), browser, profile: config.profile, port: config.port, proxy: actualProxy || 'none', loopback: true, attachExisting: true };
  }
  if (Number(flag(info.command, '--remote-debugging-port')) !== config.port) throw new Error('Browser port mismatch');
  const actual = flag(info.command, '--user-data-dir');
  const normalize = value => {
    const v = path.resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? v.toLowerCase() : v;
  };
  if (!actual || normalize(actual) !== normalize(config.profile)) throw new Error('Browser profile mismatch');
  const actualProxy = flag(info.command, '--proxy-server');
  if (config.proxy === 'none' && (flag(info.command, '--proxy-pac-url') || /(?:^|\s)--proxy-auto-detect(?:\s|$)/.test(info.command))) {
    throw new Error('Unexpected browser proxy auto-configuration');
  }
  if (config.proxy === 'none' ? Boolean(actualProxy) : actualProxy !== config.proxy) throw new Error('Browser proxy mismatch');
  return { ok: true, pid: Number(info.pid), browser, profile: actual, port: config.port, proxy: actualProxy || 'none', loopback: true };
}

function runWindowsPowerShell(ps) {
  const attempts = [
    ['pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]],
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Import-Module Microsoft.PowerShell.Security; " + ps]]
  ];
  let lastError;
  for (const [file, args] of attempts) {
    try {
      return execFileSync(file, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function parseListeningPortViaNetstat(port) {
  try {
    const out = execFileSync('netstat.exe', ['-ano'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = new Set();
    let allLoopback = true;
    let found = 0;
    for (const rawLine of out.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith('TCP')) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 5) continue;
      const localAddr = parts[1];
      const state = parts[3];
      const pid = Number(parts[4]);
      if (state !== 'LISTENING') continue;
      const lastColon = localAddr.lastIndexOf(':');
      if (lastColon === -1) continue;
      const listenPort = Number(localAddr.slice(lastColon + 1));
      if (listenPort !== Number(port)) continue;
      const host = localAddr.slice(0, lastColon);
      found += 1;
      if (host !== '127.0.0.1' && host !== '[::1]') {
        allLoopback = false;
      }
      if (Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
    if (found === 0) return { found: false };
    return {
      found: true,
      pids: [...pids],
      loopback: allLoopback,
    };
  } catch {
    return null;
  }
}

function inspectWindows(port, includeSignature = false) {
  const sig = includeSignature ? "Import-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue; $s=Get-AuthenticodeSignature -FilePath $proc.ExecutablePath; $status=[string]$s.Status; $subject=$s.SignerCertificate.Subject; " : "$status=''; $subject=''; ";
  const fastNet = parseListeningPortViaNetstat(port);
  if (fastNet) {
    if (!fastNet.found) throw new Error('No CDP listener');
    if (fastNet.pids.length !== 1) throw new Error('Ambiguous CDP owners');
    const pid = fastNet.pids[0];
    const loopbackLit = fastNet.loopback ? '$true' : '$false';
    const psFast = "$ErrorActionPreference='Stop'; $proc=Get-CimInstance Win32_Process -Filter ('ProcessId=" + pid + "'); " + sig + "[pscustomobject]@{pid=" + pid + ";name=$proc.Name;command=$proc.CommandLine;executablePath=$proc.ExecutablePath;signatureStatus=$status;signerSubject=$subject;loopback=" + loopbackLit + "}|ConvertTo-Json -Compress";
    return JSON.parse(runWindowsPowerShell(psFast));
  }
  const ps = "$ErrorActionPreference='Stop'; $rows=@(Get-NetTCPConnection -State Listen -LocalPort " + port + "); if(!$rows.Count){throw 'No CDP listener'}; $pids=@($rows.OwningProcess|Sort-Object -Unique); if($pids.Count -ne 1){throw 'Ambiguous CDP owners'}; $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pids[0]); " + sig + "[pscustomobject]@{pid=[int]$pids[0];name=$proc.Name;command=$proc.CommandLine;executablePath=$proc.ExecutablePath;signatureStatus=$status;signerSubject=$subject;loopback=(@($rows|Where-Object {$_.LocalAddress -notin @('127.0.0.1','::1')}).Count -eq 0)}|ConvertTo-Json -Compress";
  return JSON.parse(runWindowsPowerShell(ps));
}

function inspectLinux(port) {
  const output = execFileSync('ss', ['-H', '-ltnp', '( sport = :' + port + ' )'], { encoding: 'utf8', timeout: 5000 });
  const rows = output.trim().split(/\n/).filter(Boolean);
  const ids = [...new Set([...output.matchAll(/pid=(\d+)/g)].map(m => Number(m[1])))];
  if (!rows.length || ids.length !== 1) throw new Error('Cannot verify unique CDP owner');
  const pid = ids[0];
  const args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean);
  const command = args.map(x => /\s/.test(x) ? '"' + x + '"' : x).join(' ');
  return { pid, name: path.basename(args[0]), command, loopback: rows.every(row => /(?:127\.0\.0\.1|\[?::1\]?):/.test(row.split(/\s+/)[3] || '')) };
}

async function verify(options = {}) {
  if (options.cdpHttp) return require('./identity-legacy').verify(options);
  const config = options.config || resolveConfig();
  if (!config.profile || !config.proxy) throw new Error('Identity verification requires expected profile and proxy');
  if (process.platform === 'linux' && !options.inspect) {
    const result = await require('./identity-legacy').verify({ cdpHttp: config.endpoint, profile: config.profile, proxy: config.proxy, browser: config.browser });
    if (!result.ok) throw new Error('Linux identity failed: ' + result.failures.join('; '));
    return result;
  }

  const cacheKey = !options.inspect
    ? `${config.port}|${config.browser || ''}|${config.profile}|${config.proxy}|${Boolean(config.attachExisting)}`
    : '';
  if (
    cacheKey &&
    !options.force &&
    lastVerifiedCache &&
    lastVerifiedCache.key === cacheKey &&
    Date.now() - lastVerifiedCache.at < VERIFY_CACHE_TTL_MS &&
    isPidAlive(lastVerifiedCache.result.pid) &&
    (!lastVerifiedCache.activePortSig || readActivePortSignature(config.profile) === lastVerifiedCache.activePortSig)
  ) {
    return lastVerifiedCache.result;
  }
  if (cacheKey && !options.force && !config.attachExisting && process.platform === 'win32') {
    const persisted = await readPersistedVerified(config.port, cacheKey, config.profile);
    if (persisted) {
      lastVerifiedCache = { key: cacheKey, at: persisted.at, activePortSig: persisted.activePortSig || null, result: persisted.result };
      return persisted.result;
    }
  }

  const info = options.inspect
    ? await options.inspect(config.port)
    : process.platform === 'win32' ? inspectWindows(config.port, config.attachExisting)
      : process.platform === 'linux' ? inspectLinux(config.port) : null;
  if (!info) throw new Error('Browser identity verification unsupported on this platform');
  if (config.attachExisting) {
    const lines = fs.readFileSync(path.join(config.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    info.activePort = { port: Number(lines[0]), browserPath: lines[1] || '' };
  }
  const verified = validateProcess(info, config);
  if (cacheKey) {
    const activePortSig = readActivePortSignature(config.profile);
    lastVerifiedCache = { key: cacheKey, at: Date.now(), activePortSig, result: verified };
    if (!config.attachExisting && process.platform === 'win32') {
      const browserWsUrl = await fetchLoopbackBrowserWsUrl(config.port);
      writePersistedVerified(config.port, cacheKey, verified, activePortSig, browserWsUrl);
    }
  }
  return verified;
}

module.exports = { verify, validateProcess, classifyBrowser, flag };
