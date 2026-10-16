// AgentBrowserBridge - CDP 实例身份校验（门禁 G1）
// 证明“CDP 端口上的进程就是预期的那个浏览器实例”：端口→pid→cmdline/profile/代理/SingletonLock/DevTools browser id。
// 只读：不连接页面、不读页面内容。失败时不尝试其他端口。
//
// 环境变量（严格模式必填前三项）：
//   CDP_HTTP                      如 http://127.0.0.1:9333
//   BROWSER_BRIDGE_EXPECT_PROFILE      期望的 --user-data-dir
//   BROWSER_BRIDGE_EXPECT_PROXY        期望的 --proxy-server；写 none 表示必须没有 --proxy-server（Windows 站点本地出口）
//   BROWSER_BRIDGE_EXPECT_FLAGS        额外必须出现的完整参数，用 \n 分隔（可选）
//   BROWSER_BRIDGE_EXPECT_DEVTOOLS_LOG 浏览器启动日志路径，用于交叉核对 browser id（可选）
//   BROWSER_BRIDGE_EXPECT_BINARY       期望的可执行文件真实路径（可选，/proc/<pid>/exe）

const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'];

function parsePort(cdpHttp) {
  const u = new URL(cdpHttp);
  if (u.hostname !== '127.0.0.1') throw new Error(`CDP_HTTP 必须是 127.0.0.1，实际 ${u.hostname}`);
  return Number(u.port);
}

function linuxListeners(port) {
  const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((line) => {
    const cols = line.trim().split(/\s+/);
    const local = cols[3] || '';
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    return { local, pids };
  });
}

function readProcArgs(pid) {
  return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
}

function readProcEnv(pid) {
  try {
    return Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
      .map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  } catch {
    return null;
  }
}

function argValue(args, name) {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

function expected(overrides = {}) {
  return {
    cdpHttp: overrides.cdpHttp || process.env.CDP_HTTP,
    profile: overrides.profile || process.env.BROWSER_BRIDGE_EXPECT_PROFILE,
    proxy: overrides.proxy || process.env.BROWSER_BRIDGE_EXPECT_PROXY,
    flags: overrides.flags || (process.env.BROWSER_BRIDGE_EXPECT_FLAGS ? process.env.BROWSER_BRIDGE_EXPECT_FLAGS.split('\n').filter(Boolean) : []),
    devtoolsLog: overrides.devtoolsLog || process.env.BROWSER_BRIDGE_EXPECT_DEVTOOLS_LOG || '',
    binary: overrides.binary || process.env.BROWSER_BRIDGE_EXPECT_BINARY || '',
  };
}

async function verifyLinux(exp) {
  const failures = [];
  const info = { port: null, pid: null, exe: null, display: null, browserId: null };
  if (!exp.cdpHttp || !exp.profile || !exp.proxy) {
    return { ok: false, failures: ['缺少 CDP_HTTP / EXPECT_PROFILE / EXPECT_PROXY'], ...info };
  }
  const port = parsePort(exp.cdpHttp);
  info.port = port;

  const listeners = linuxListeners(port);
  if (!listeners.length) return { ok: false, failures: [`${port} 无监听`], ...info };
  const bad = listeners.filter((l) => l.local !== `127.0.0.1:${port}`);
  if (bad.length) failures.push(`${port} 绑定了非 127.0.0.1 地址: ${bad.map((l) => l.local).join(',')}`);
  const pids = [...new Set(listeners.flatMap((l) => l.pids))];
  if (pids.length !== 1) return { ok: false, failures: [...failures, `${port} 监听 pid 不唯一或不可见: ${JSON.stringify(pids)}`], ...info };
  const pid = pids[0];
  info.pid = pid;

  const args = readProcArgs(pid);
  try { info.exe = fs.realpathSync(`/proc/${pid}/exe`); } catch { info.exe = null; }
  if (exp.binary && info.exe !== exp.binary) failures.push(`可执行文件不符: ${info.exe}`);
  if (argValue(args, '--user-data-dir') !== exp.profile) failures.push(`profile 不符: ${argValue(args, '--user-data-dir')}`);
  if (exp.proxy === 'none') { if (argValue(args, '--proxy-server') !== null) failures.push(`期望无代理，实际 --proxy-server=${argValue(args, '--proxy-server')}`); }
  else if (argValue(args, '--proxy-server') !== exp.proxy) failures.push(`proxy 不符: ${argValue(args, '--proxy-server')}`);
  if (argValue(args, '--remote-debugging-port') !== String(port)) failures.push(`remote-debugging-port 不符: ${argValue(args, '--remote-debugging-port')}`);
  if (argValue(args, '--remote-debugging-address') !== '127.0.0.1') failures.push('remote-debugging-address 不是 127.0.0.1');
  if (args.some((a) => a.startsWith('--proxy-pac-url') || a === '--no-proxy-server' || a.startsWith('--proxy-bypass-list'))) failures.push('存在额外代理参数');
  for (const flag of exp.flags) if (!args.includes(flag)) failures.push(`缺少参数: ${flag}`);

  const env = readProcEnv(pid);
  if (!env) failures.push('无法读取进程环境变量');
  else {
    const proxyVars = PROXY_ENV.filter((k) => env[k]);
    if (proxyVars.length) failures.push(`进程带代理环境变量: ${proxyVars.join(',')}`);
    info.display = env.DISPLAY || null;
  }

  // SingletonLock -> <hostname>-<pid>
  try {
    const lock = fs.readlinkSync(`${exp.profile}/SingletonLock`);
    const m = lock.match(/-(\d+)$/);
    if (!m || Number(m[1]) !== pid) failures.push(`SingletonLock 指向 ${lock}，与 pid ${pid} 不符`);
  } catch {
    failures.push('profile 无 SingletonLock');
  }

  // /json/version 与端口、启动日志 browser id 交叉核对
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(10000) });
    const ver = await res.json();
    const ws = new URL(ver.webSocketDebuggerUrl);
    if (ws.host !== `127.0.0.1:${port}`) failures.push(`webSocketDebuggerUrl 端口不符: ${ws.host}`);
    info.browserId = ws.pathname.split('/').pop();
    info.browser = ver.Browser;
    if (exp.devtoolsLog) {
      let logId = null;
      try {
        const text = fs.readFileSync(exp.devtoolsLog, 'utf8');
        const all = [...text.matchAll(new RegExp(`DevTools listening on ws://127\\.0\\.0\\.1:${port}/devtools/browser/([0-9a-f-]+)`, 'g'))];
        logId = all.length ? all[all.length - 1][1] : null;
      } catch { /* missing log */ }
      if (logId !== info.browserId) failures.push(`启动日志 browser id 不符: log=${logId}`);
    }
  } catch (err) {
    failures.push(`/json/version 读取失败: ${err.message}`);
  }

  return { ok: failures.length === 0, failures, ...info, profile: exp.profile, proxy: exp.proxy };
}

// Windows：用 Get-CimInstance Win32_Process 读取同样信息（端口→pid 用 Get-NetTCPConnection）。
async function verifyWindows(exp) {
  const failures = [];
  const port = parsePort(exp.cdpHttp);
  const ps = `$c=Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue; `
    + `$c | ForEach-Object { $p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$_.OwningProcess); `
    + `[pscustomobject]@{addr=$_.LocalAddress;pid=$_.OwningProcess;cmd=$p.CommandLine;exe=$p.ExecutablePath} } | ConvertTo-Json -Compress`;
  let rows = [];
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
    rows = out ? [].concat(JSON.parse(out)) : [];
  } catch (err) {
    return { ok: false, failures: [`PowerShell 查询失败: ${err.message}`], port };
  }
  if (!rows.length) return { ok: false, failures: [`${port} 无监听`], port };
  if (rows.some((r) => r.addr !== '127.0.0.1')) failures.push('绑定了非 127.0.0.1 地址');
  const pids = [...new Set(rows.map((r) => r.pid))];
  if (pids.length !== 1) failures.push('监听 pid 不唯一');
  const cmd = rows[0].cmd || '';
  const has = (name, value) => cmd.includes(`${name}=${value}`) || cmd.includes(`${name}="${value}"`);
  if (!has('--user-data-dir', exp.profile)) failures.push('profile 不符');
  if (exp.proxy === 'none') { if (/--proxy-server[= ]/.test(cmd)) failures.push('期望无代理，但命令行含 --proxy-server'); }
  else if (!has('--proxy-server', exp.proxy)) failures.push('proxy 不符');
  if (/--proxy-pac-url|--proxy-bypass-list/.test(cmd)) failures.push('存在额外代理参数');
  if (!has('--remote-debugging-port', String(port))) failures.push('remote-debugging-port 不符');
  for (const flag of exp.flags) if (!cmd.includes(flag)) failures.push(`缺少参数: ${flag}`);
  if (exp.binary && rows[0].exe !== exp.binary) failures.push('可执行文件不符');
  return { ok: failures.length === 0, failures, port, pid: pids[0], exe: rows[0].exe, profile: exp.profile, proxy: exp.proxy };
}

async function verify(overrides = {}) {
  const exp = expected(overrides);
  try {
    return os.platform() === 'win32' ? await verifyWindows(exp) : await verifyLinux(exp);
  } catch (err) {
    return { ok: false, failures: [`校验异常: ${err.message}`] };
  }
}

module.exports = { verify, parsePort };
