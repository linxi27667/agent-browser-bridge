const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveConfig } = require('./config');

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

function inspectWindows(port) {
  const ps = "$ErrorActionPreference='Stop'; $rows=@(Get-NetTCPConnection -State Listen -LocalPort " + port + "); if(!$rows.Count){throw 'No CDP listener'}; $pids=@($rows.OwningProcess|Sort-Object -Unique); if($pids.Count -ne 1){throw 'Ambiguous CDP owners'}; $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pids[0]); [pscustomobject]@{pid=[int]$pids[0];name=$proc.Name;command=$proc.CommandLine;loopback=(@($rows|Where-Object {$_.LocalAddress -notin @('127.0.0.1','::1')}).Count -eq 0)}|ConvertTo-Json -Compress";
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function inspectLinux(port) {
  const output = execFileSync('ss', ['-H', '-ltnp', '( sport = :' + port + ' )'], { encoding: 'utf8', timeout: 5000 });
  const rows = output.trim().split('\n').filter(Boolean);
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
  const info = options.inspect
    ? await options.inspect(config.port)
    : process.platform === 'win32' ? inspectWindows(config.port)
      : process.platform === 'linux' ? inspectLinux(config.port) : null;
  if (!info) throw new Error('Browser identity verification unsupported on this platform');
  return validateProcess(info, config);
}

module.exports = { verify, validateProcess, classifyBrowser, flag };
