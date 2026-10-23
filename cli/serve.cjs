#!/usr/bin/env node
process.env.BROWSER_BRIDGE_DAEMON_OWNER = '1';
const path = require('node:path');
const { spawn } = require('node:child_process');
const cdp = require('../lib/cdp');
const { startDaemon } = require('../lib/cdp/daemon');

(async () => {
  const config = cdp.resolveConfig();
  if (!config.attachExisting) throw new Error('npm run serve 只用于已授权的日常 Edge 会话');
  await cdp.identity.verify();
  const live = await require('../lib/cdp/daemon').getLiveDaemon(config);
  if (live && live.pid !== process.pid) {
    console.log(JSON.stringify({ ok: true, reused: true, http: live.http, edgePort: live.edgePort, pid: live.pid }));
    return;
  }
  const approver = spawn('pwsh', [
    '-NoProfile',
    '-File',
    path.join(__dirname, '..', 'lib', 'profile', 'Approve-EdgeRemoteDebugging.ps1'),
    '-TimeoutSeconds',
    '40'
  ], { windowsHide: true, stdio: 'ignore' });
  const daemon = await startDaemon({
    edgeWsUrl: cdp.resolveBrowserWsUrl(config),
    edgePort: config.port,
    timeoutMs: Number(process.env.BROWSER_BRIDGE_WS_TIMEOUT_MS) || 45000
  });
  if (approver && !approver.killed) approver.unref();
  console.log(JSON.stringify({
    ok: true,
    reused: false,
    http: daemon.http,
    ws: daemon.ws,
    edgePort: daemon.edgePort,
    pid: process.pid,
    note: 'Keep this process running. Later check/smoke reuse this local proxy and should not prompt Edge again.'
  }));
})().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
