// 硬化回归测试：跨进程租约拦截、同站点串行、证据截图隐藏 HUD、clickNative 串行、点击后鼠标归位
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hardening-'));
process.env.BROWSER_BRIDGE_LOCK_DIR = lockDir;
process.env.GCWEBAUTO_LOCK_DIR = lockDir;
for (const k of ['BROWSER_BRIDGE_REQUIRE_INSTANCE', 'GCWEBAUTO_REQUIRE_INSTANCE', 'GKWEBAUTO_REQUIRE_INSTANCE']) delete process.env[k];

const cdp = require('../lib/cdp');
const conc = require('../lib/cdp/concurrency');
const { sleep } = require('../lib/cdp/client');

test.after(() => {
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
});

function leaseWithOwner(targetId, ownerPatch) {
  const lease = conc.acquireTargetLease({ targetId, ownerTag: 'hardening-test', heartbeat: false });
  const port = Number(/target-(\d+)-/.exec(path.basename(lease.leasePath))[1]);
  const ownerFile = path.join(lease.leasePath, 'owner.json');
  const data = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  fs.writeFileSync(ownerFile, JSON.stringify({ ...data, ...ownerPatch }));
  return { port, cleanup: () => fs.rmSync(lease.leasePath, { recursive: true, force: true }) };
}

test('a tab leased by another live process cannot be attached or connected directly', () => {
  const id = 'FOREIGN-LIVE-TAB';
  const { port, cleanup } = leaseWithOwner(id, { pid: process.ppid });
  try {
    assert.throws(() => conc.assertNotLeasedByOtherProcess(id, { port }), (e) => e.code === 'CDP_TARGET_LEASED' && e.targetId === id);
    assert.throws(() => cdp.createCdp(`ws://127.0.0.1:${port}/devtools/page/${id}`), (e) => e.code === 'CDP_TARGET_LEASED');
  } finally {
    cleanup();
  }
});

test('own, dead-process and expired leases do not block attachment', () => {
  const cases = [
    ['SELF-TAB', { pid: process.pid }],
    ['DEAD-TAB', { pid: 99999999 }],
    ['EXPIRED-TAB', { pid: process.ppid, expiresAt: Date.now() - 1000 }],
  ];
  for (const [id, patch] of cases) {
    const { port, cleanup } = leaseWithOwner(id, patch);
    try {
      assert.doesNotThrow(() => conc.assertNotLeasedByOtherProcess(id, { port }), id);
    } finally {
      cleanup();
    }
  }
  assert.doesNotThrow(() => conc.assertNotLeasedByOtherProcess('NO-LOCK-TAB'));
});

test('withDedicatedTab keeps same-site work serial instead of opening a parallel tab', async () => {
  const id = 'k3-busy-tab';
  const lease = conc.acquireTargetLease({ targetId: id, ownerTag: 'other-agent', heartbeat: false });
  const created = [];
  const fakeBrowser = {
    send: async (method, params) => {
      if (method === 'Target.getTargets') {
        return { targetInfos: [{ targetId: id, type: 'page', title: 'K3Cloud', url: 'http://10.1.3.38/K3Cloud/html5/index.aspx' }] };
      }
      if (method === 'Target.createTarget') { created.push(params); return { targetId: 'parallel-tab' }; }
      return {};
    },
    close() {},
    isDead: () => null,
    on: () => () => {},
    ready: Promise.resolve(),
  };
  try {
    await assert.rejects(
      conc.withDedicatedTab(fakeBrowser, { url: 'http://10.1.3.38/K3Cloud', onLeased: 'fail' }, async () => {}),
      (e) => e.code === 'CDP_TARGET_LEASED'
    );
    const t0 = Date.now();
    await assert.rejects(
      conc.withDedicatedTab(fakeBrowser, { url: 'http://10.1.3.38/K3Cloud', leaseWaitMs: 600 }, async () => {}),
      (e) => e.code === 'CDP_TARGET_LEASED'
    );
    assert.ok(Date.now() - t0 >= 500, 'default policy must wait for the busy tab before giving up');
    assert.equal(created.length, 0, 'must never open a second tab on the same site while another task holds it');
  } finally {
    lease.release();
  }
});

test('capturePagePng hides the bridge HUD during evidence capture and restores it', async () => {
  const calls = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const fake = {
    async evalChecked(expr) {
      if (expr.includes('__abb_hud_host') && expr.includes('"hidden"')) { calls.push('hide'); return ''; }
      if (expr.includes('__abb_hud_host')) { calls.push('restore'); return true; }
      calls.push('guard');
      return true;
    },
    async send(method) { calls.push(method); return { data: png }; },
  };
  const out = path.join(lockDir, 'evidence.png');
  await cdp.capturePagePng(fake, out, 'true');
  assert.deepEqual(calls, ['guard', 'hide', 'Page.captureScreenshot', 'restore']);
  assert.ok(fs.existsSync(out));
});

test('clickNative waits behind the shared UI lock when autoUiLock is enabled', async () => {
  const order = [];
  const page = {
    autoUiLock: true,
    async evalChecked(expr) {
      if (expr.includes('e.click()')) { order.push('click'); return { x: 5, y: 5, rect: { x: 0, y: 0, width: 10, height: 10 } }; }
      return true;
    },
    async send() { return {}; },
    async eval() { return { result: { value: true } }; },
  };
  const holder = conc.withUiLock(async () => {
    order.push('hold-start');
    await sleep(250);
    order.push('hold-end');
  }, { pollMs: 20 });
  await sleep(40);
  await cdp.clickNative(page, '#btn', 'true');
  await holder;
  assert.deepEqual(order, ['hold-start', 'hold-end', 'click']);
});

test('clickByBox parkPointer moves the pointer away after clicking', async () => {
  const mouse = [];
  const page = {
    async evalChecked(expr) {
      if (expr.includes('getBoundingClientRect')) return { x: 100, y: 100, width: 40, height: 20 };
      return true;
    },
    async send(method, params) {
      if (method === 'Input.dispatchMouseEvent') mouse.push(params);
      return {};
    },
    async eval() { return { result: { value: true } }; },
  };
  await cdp.clickByBox(page, '#menu-hit', 'true', { parkPointer: true });
  assert.deepEqual(mouse.map((m) => m.type), ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseMoved']);
  assert.equal(mouse[3].x, 2);
  assert.equal(mouse[3].y, 2);
});

test('read-only mode refuses clicks on business write buttons and allows others', async () => {
  const clicked = [];
  const makePage = (labelText) => ({
    readOnly: true,
    async evalChecked(expr) {
      if (expr.startsWith('/*abb-readonly*/')) return { own: labelText, item: labelText };
      if (expr.includes('e.click()')) { clicked.push(labelText); return { x: 5, y: 5, rect: { x: 0, y: 0, width: 10, height: 10 } }; }
      if (expr.includes('getBoundingClientRect')) return { x: 100, y: 100, width: 40, height: 20 };
      return true;
    },
    async send(method) { if (method === 'Input.dispatchMouseEvent') clicked.push('mouse:' + labelText); return {}; },
    async eval() { return { result: { value: true } }; },
  });
  await assert.rejects(cdp.clickNative(makePage('保存'), '#save', 'true'), (e) => e.code === 'READ_ONLY_BLOCKED' && e.denied === '保存');
  await assert.rejects(cdp.clickByBox(makePage(' 审 核 '), '#audit', 'true'), (e) => e.code === 'READ_ONLY_BLOCKED');
  assert.deepEqual(clicked, [], 'blocked buttons must never receive a click');
  await cdp.clickByBox(makePage('查询'), '#query', 'true');
  await cdp.clickNative(makePage('保存方案管理'), '#scheme', 'true');
  assert.ok(clicked.includes('mouse:查询') && clicked.includes('保存方案管理'));
  const custom = { ...makePage('导出'), readOnly: { denyText: ['导出'] } };
  await assert.rejects(cdp.clickNative(custom, '#export', 'true'), (e) => e.code === 'READ_ONLY_BLOCKED');
});

test('a tab already driven by a debugger outside this library is reported (onForeignAttach: fail)', async () => {
  const id = 'foreign-driven-tab';
  const fakeBrowser = {
    send: async (method) => {
      if (method === 'Target.getTargets') {
        return { targetInfos: [{ targetId: id, type: 'page', title: 'K3Cloud', url: 'http://10.1.3.38/K3Cloud/html5/index.aspx', attached: true }] };
      }
      return {};
    },
    close() {},
    isDead: () => null,
    on: () => () => {},
    ready: Promise.resolve(),
  };
  await assert.rejects(
    conc.withDedicatedTab(fakeBrowser, { url: 'http://10.1.3.38/K3Cloud', onForeignAttach: 'fail' }, async () => {}),
    (e) => e.code === 'CDP_FOREIGN_ATTACHED' && e.targetId === id
  );
  const t0 = Date.now();
  await assert.rejects(
    conc.withDedicatedTab(fakeBrowser, { url: 'http://10.1.3.38/K3Cloud', onForeignAttach: 'wait', leaseWaitMs: 600 }, async () => {}),
    (e) => e.code === 'CDP_TARGET_LEASED'
  );
  assert.ok(Date.now() - t0 >= 500, "onForeignAttach 'wait' must wait for the external debugger to detach");
  const again = conc.acquireTargetLease({ targetId: id, heartbeat: false });
  again.release();
});
