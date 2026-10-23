const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { WebSocketServer } = require('ws');
for (const key of ['CDP_HTTP', 'BROWSER_BRIDGE_REQUIRE_INSTANCE', 'BROWSER_BRIDGE_ATTACH_EXISTING', 'BROWSER_BRIDGE_EXPECT_PROFILE', 'BROWSER_BRIDGE_EXPECT_PROXY', 'BROWSER_BRIDGE_EXPECT_BROWSER', 'BROWSER_BRIDGE_WS_TIMEOUT_MS']) {
  delete process.env[key];
}
const cdp = require('../lib/cdp');
const profile = path.resolve('test-profile');
const config = { port: 9222, profile, proxy: 'none' };
const info = { pid: 123, name: 'chrome.exe', loopback: true, command: 'chrome --remote-debugging-port=9222 --user-data-dir="' + profile + '"' };
test('strict configuration cannot silently use default browser', () => {
  assert.throws(() => cdp.resolveConfig({ BROWSER_BRIDGE_REQUIRE_INSTANCE: 'test' }), /CDP_HTTP/);
  assert.throws(() => cdp.resolveConfig({ BROWSER_BRIDGE_REQUIRE_INSTANCE: 'test', CDP_HTTP: 'http://127.0.0.1:9222' }), /PROFILE/);
});
test('remote and credential-bearing endpoints rejected', () => {
  for (const url of ['http://192.0.2.44:9222', 'http://user:pass@localhost:9222', 'http://localhost:9222/json/list']) assert.throws(() => cdp.resolveConfig({ CDP_HTTP: url }));
  assert.throws(() => cdp.createCdp('ws://192.0.2.44:9222/anything'), /local/);
});
test('strict configuration records the selected browser', () => {
  const c = cdp.resolveConfig({ CDP_HTTP: 'http://127.0.0.1:9222', BROWSER_BRIDGE_REQUIRE_INSTANCE: 'test', BROWSER_BRIDGE_EXPECT_PROFILE: profile, BROWSER_BRIDGE_EXPECT_PROXY: 'none', BROWSER_BRIDGE_EXPECT_BROWSER: 'chrome' });
  assert.equal(c.strict, true); assert.equal(c.profile, profile); assert.equal(c.browser, 'chrome');
});
test('identity checks reject wrong profile, port, proxy, process and exposed listener', () => {
  assert.equal(cdp.identity.validateProcess(info, config).ok, true);
  for (const wrong of [{ ...info, loopback: false }, { ...info, name: 'node.exe' }, { ...info, command: info.command + ' --type=renderer' }, { ...info, command: info.command.replace('9222', '9333') }, { ...info, command: info.command.replace(profile, path.resolve('other')) }, { ...info, command: info.command + ' --proxy-server=socks5://127.0.0.1:1088' }]) assert.throws(() => cdp.identity.validateProcess(wrong, config));
});
test('duplicate profile flags cannot conceal a second instance', () => {
  assert.throws(() => cdp.identity.flag(info.command + ' --user-data-dir=other', '--user-data-dir'), /duplicate/);
});
test('unreadable cross-user process identity stops with an actionable error', () => {
  for (const command of [null, undefined, '']) assert.throws(() => cdp.identity.validateProcess({ ...info, command }, config), /browser owner session/);
});
test('none proxy policy rejects PAC and auto-detection flags', () => {
  assert.throws(() => cdp.identity.validateProcess({ ...info, command: info.command + ' --proxy-pac-url=https://example.test/proxy.pac' }, config), /proxy auto/);
  assert.throws(() => cdp.identity.validateProcess({ ...info, command: info.command + ' --proxy-auto-detect' }, config), /proxy auto/);
});
test('target must be exact and unique', () => {
  const targets = [{ id: 'A', type: 'page', url: 'https://example.test' }, { id: 'B', type: 'page', url: 'https://example.test' }];
  assert.equal(cdp.requireTarget(targets, { id: 'B' }).id, 'B');
  assert.throws(() => cdp.requireTarget(targets, { exactUrl: 'https://example.test' }), /ambiguous/);
  assert.throws(() => cdp.requireTarget(targets, {}), /Explicit/);
});
test('input is stopped before write when context guard fails', async () => {
  let writes = 0;
  const fake = { evalChecked: async () => false, send: async () => writes++ };
  await assert.rejects(cdp.fillNative(fake, '#input', 'text', 'guard'), /guard/);
  assert.equal(writes, 0);
});
test('click and unique read stop when the context guard fails', async () => {
  let calls = 0;
  const fake = { evalChecked: async () => false, send: async () => calls++ };
  await assert.rejects(cdp.clickNative(fake, '#submit', 'guard'), /guard/);
  await assert.rejects(cdp.clickByBox(fake, '#submit', 'guard'), /guard/);
  await assert.rejects(cdp.readUnique(fake, '#result', 'guard'), /guard/);
  assert.equal(calls, 0);
});
test('coordinate click uses the unique element box center', async () => {
  const sent = [];
  const fake = {
    evalChecked: async expression => {
      if (expression === 'true') return true;
      return { x: 10, y: 20, width: 40, height: 10 };
    },
    send: async (method, params) => sent.push({ method, params })
  };
  const result = await cdp.clickByBox(fake, '#go', 'true');
  assert.equal(result.x, 30);
  assert.equal(result.y, 25);
  assert.equal(sent.filter(item => item.method === 'Input.dispatchMouseEvent').length, 3);
});
test('selector wait and box click reject unsafe targets before acting', async () => {
  await assert.rejects(cdp.waitForSelector({ evalChecked: async () => true }, '', 'true'), /selector and context guard/);
  await assert.rejects(cdp.clickNative({ evalChecked: async () => true, send: async () => {} }, '#go', '  '), /selector and context guard/);
  const sent = [];
  const fake = {
    evalChecked: async expression => expression === 'true' ? true : { x: 0, y: 0, width: 2, height: 2 },
    send: async (method, params) => sent.push({ method, params })
  };
  await assert.rejects(cdp.clickByBox(fake, '#tiny', 'true'), /not clickable/);
  assert.equal(sent.length, 0);
});
test('wait is bounded and page errors are not ignored', async () => {
  await assert.rejects(cdp.waitFor({ evalChecked: async () => false }, 'ready', { timeoutMs: 10, intervalMs: 2 }), /timed out/);
  await assert.rejects(cdp.waitFor({ evalChecked: async () => { throw Error('page error'); } }, 'ready'), /page error/);
});
async function mockServer(t, handler) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  server.on('connection', socket => socket.on('message', data => handler(socket, JSON.parse(data))));
  const client = cdp.createCdp('ws://127.0.0.1:' + server.address().port, { timeoutMs: 150 });
  t.after(() => { client.close(); for (const s of server.clients) s.terminate(); server.close(); });
  return client;
}
test('protocol and page execution errors cannot count as success', async t => {
  const client = await mockServer(t, (socket, msg) => socket.send(JSON.stringify(msg.method === 'Fail' ? { id: msg.id, error: { message: 'rejected' } } : { id: msg.id, result: { exceptionDetails: { text: 'Uncaught' } } })));
  await assert.rejects(client.send('Fail'), /protocol error/);
  await assert.rejects(client.evalChecked('throw'), /evaluation failed/);
});
test('command timeout performs no automatic duplicate retry', async t => {
  let calls = 0;
  const client = await mockServer(t, () => calls++);
  await assert.rejects(client.send('OneWrite'), /result unknown/);
  assert.equal(calls, 1);
});
test('disconnection rejects pending operations immediately', async t => {
  const client = await mockServer(t, socket => socket.close());
  await assert.rejects(client.send('OneWrite'), /disconnected/);
});
test('Inspector.detached preserves legacy dead callback and ready interface', async t => {
  let calls = 0;
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  server.on('connection', socket => socket.on('message', () => socket.send(JSON.stringify({ method: 'Inspector.detached', params: { reason: 'target closed' } }))));
  const client = cdp.createCdp('ws://127.0.0.1:' + server.address().port, { timeoutMs: 200, onDead: () => calls++ });
  t.after(() => { client.close(); for (const s of server.clients) s.terminate(); server.close(); });
  await client.ready;
  await assert.rejects(client.send('OneWrite'), error => error.code === 'CDP_DEAD');
  assert.ok(client.isDead()); assert.equal(calls, 1);
});

test('Edge and Chrome processes are matched only to their selected browser type', () => {
  const edgeConfig = { ...config, browser: 'edge' };
  const edge = { ...info, name: 'msedge.exe', command: info.command.replace('chrome', 'msedge') };
  assert.equal(cdp.identity.validateProcess(edge, edgeConfig).browser, 'edge');
  assert.throws(() => cdp.identity.validateProcess(info, edgeConfig), /Browser type mismatch/);
  assert.throws(() => cdp.identity.validateProcess(edge, { ...config, browser: 'chrome' }), /Browser type mismatch/);
});
test('existing Edge attachment accepts default profile without HTTP version', () => {
  const localApp = process.env.LOCALAPPDATA || 'C:\\Users\\tester\\AppData\\Local';
  const edgeData = path.join(localApp, 'Microsoft', 'Edge', 'User Data');
  const cfg = cdp.resolveConfig({
    CDP_HTTP: 'http://127.0.0.1:9222',
    BROWSER_BRIDGE_REQUIRE_INSTANCE: '1',
    BROWSER_BRIDGE_EXPECT_PROFILE: edgeData,
    BROWSER_BRIDGE_EXPECT_PROXY: 'none',
    BROWSER_BRIDGE_EXPECT_BROWSER: 'edge',
    BROWSER_BRIDGE_ATTACH_EXISTING: '1',
    LOCALAPPDATA: localApp
  });
  assert.equal(cfg.attachExisting, true);
  const edge = {
    pid: 11,
    name: 'msedge.exe',
    loopback: true,
    command: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"',
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    signatureStatus: 'Valid',
    signerSubject: 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
    activePort: { port: 9222, browserPath: '/devtools/browser/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
  };
  assert.equal(cdp.identity.validateProcess(edge, cfg).attachExisting, true);
});
test('flattened session commands carry sessionId', async t => {
  let received;
  const client = await mockServer(t, (socket, msg) => {
    received = msg;
    socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result: { ok: true } }));
  });
  const result = await client.send('Page.enable', {}, 'sess-1');
  assert.equal(received.sessionId, 'sess-1');
  assert.equal(result.ok, true);
});
test('Target.getTargets maps to listTargets ids', () => {
  const mapped = cdp.mapTargetInfos([{ targetId: 'T1', type: 'page', title: 'Blank', url: 'about:blank' }]);
  assert.equal(cdp.requireTarget(mapped, { id: 'T1' }).url, 'about:blank');
});
