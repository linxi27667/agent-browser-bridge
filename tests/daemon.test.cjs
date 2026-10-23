const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { startDaemon } = require('../lib/cdp/daemon');
const { createCdp } = require('../lib/cdp/client');

test('local daemon remaps CDP ids so later clients do not open a second Edge socket', async t => {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => upstream.once('listening', resolve));
  let upstreamSockets = 0;
  let lastUpstreamId;
  upstream.on('connection', socket => {
    upstreamSockets++;
    socket.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      lastUpstreamId = msg.id;
      socket.send(JSON.stringify({ id: msg.id, result: { product: 'Edg/test', echo: msg.method } }));
    });
  });
  t.after(() => {
    for (const socket of upstream.clients) socket.terminate();
    upstream.close();
  });
  const edgeWsUrl = 'ws://127.0.0.1:' + upstream.address().port + '/devtools/browser/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const daemon = await startDaemon({ edgeWsUrl, edgePort: 9222, listenPort: 0, persist: false, timeoutMs: 2000 });
  t.after(() => daemon.close());
  assert.equal(upstreamSockets, 1);
  const first = createCdp(daemon.ws, { viaDaemon: true, timeoutMs: 1500, omitOrigin: true });
  const second = createCdp(daemon.ws, { viaDaemon: true, timeoutMs: 1500, omitOrigin: true });
  t.after(() => { first.close(); second.close(); });
  const a = await first.send('Runtime.evaluate', { expression: '1' });
  const b = await second.send('Browser.getVersion');
  assert.equal(a.echo, 'Runtime.evaluate');
  assert.equal(b.product, 'Edg/test');
  assert.equal(upstreamSockets, 1);
  assert.ok(lastUpstreamId >= 1);
});
