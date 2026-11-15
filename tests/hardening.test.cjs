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

test('v0.7.2: clickByBox skips parkPointer on popup/split-button triggers to prevent self-closing menus', async () => {
  const mouse = [];
  const popupPage = {
    async evalChecked(expr) {
      if (expr.includes('getBoundingClientRect')) {
        return { x: 200, y: 80, width: 24, height: 24, isPopupTrigger: true };
      }
      return true;
    },
    async send(method, params) {
      if (method === 'Input.dispatchMouseEvent') mouse.push(params);
      return {};
    },
    async eval() { return { result: { value: true } }; },
  };
  const res = await cdp.clickByBox(popupPage, '.k-i-arrow-s', 'true', { parkPointer: true });
  assert.equal(res.parked, false);
  assert.deepEqual(mouse.map((m) => m.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);

  mouse.length = 0;
  const forced = await cdp.clickByBox(popupPage, '.k-i-arrow-s', 'true', { parkPointer: true, forceParkPointer: true });
  assert.equal(forced.parked, true);
  assert.equal(mouse.length, 4);
});

test('v0.7.2: fillNative dispatches physical click + blur inside modals and typeKeysSafe never double-types', async () => {
  const events = [];
  let sawBlurExpr = false;
  const modalPage = {
    async evalChecked(expr) {
      if (expr === 'true') return true;
      if (expr.includes('inModal')) {
        return { ok: true, inModal: true, x: 320, y: 260, w: 200, h: 32 };
      }
      if (expr.includes('FocusEvent') || expr.includes('"focusout"')) {
        sawBlurExpr = expr.includes('true');
        return 'Sec#2026';
      }
      return true;
    },
    async send(method, params) {
      events.push({ method, params });
      return {};
    },
    async eval() { return { result: { value: true } }; },
  };
  const fillRes = await cdp.fillNative(modalPage, 'input[type="password"]', 'Sec#2026', 'true');
  assert.equal(fillRes.inputVerified, true);
  assert.equal(fillRes.blurred, true);
  assert.equal(sawBlurExpr, true);
  const mouseClicks = events.filter((e) => e.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(mouseClicks.map((m) => m.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(mouseClicks[1].params.x, 320);

  const keyEvents = [];
  const typedChunks = [];
  const keyPage = {
    async evalChecked(expr) {
      if (expr === 'true') return true;
      if (expr.includes('inModal')) return { ok: true, inModal: false, x: 50, y: 50, w: 120, h: 28 };
      if (expr.includes('Input changed before readback')) return typedChunks.join('');
      return true;
    },
    async send(method, params) {
      if (method === 'Input.dispatchKeyEvent') keyEvents.push(params);
      if (method === 'Input.insertText') typedChunks.push(params.text);
      return {};
    },
    async eval() { return { result: { value: true } }; },
  };
  const typeRes = await cdp.typeKeysSafe(keyPage, '#pwd', 'Ab1!', 'true', { physicalFocus: false });
  assert.equal(typeRes.typedLength, 4);
  assert.equal(typedChunks.join(''), 'Ab1!');
  assert.ok(keyEvents.every((k) => k.type !== 'char' && k.text === undefined), 'must never send text on keyDown or char events');
});

test('v0.7.2: saveScreenshot activates target even without autoUiLock and direct page WS records targetId/port', async () => {
  const activated = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const bgPage = {
    targetId: 'BG-TAB-9232',
    port: 9232,
    autoUiLock: false,
    browser: {
      async send(method, params) {
        if (method === 'Target.activateTarget') activated.push(params.targetId);
        return {};
      },
    },
    async evalChecked() { return null; },
    async send(method) {
      if (method === 'Page.captureScreenshot') return { data: png };
      return {};
    },
  };
  const saved = await cdp.saveScreenshot(bgPage, 'bg-test', { dir: lockDir });
  assert.deepEqual(activated, ['BG-TAB-9232']);
  assert.ok(fs.existsSync(saved));

  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const wsPort = wss.address().port;
  const direct = cdp.createCdp(`ws://127.0.0.1:${wsPort}/devtools/page/DIRECT-PAGE-ID`, { skipLeaseCheck: true });
  try {
    await direct.ready;
    assert.equal(direct.targetId, 'DIRECT-PAGE-ID');
    assert.equal(direct.port, wsPort);
  } finally {
    direct.close();
    wss.close();
  }
});

test('v0.7.2: @e1 RefMap serializes across processes and scene presets populate strict env safely', () => {
  const stateDir = path.join(lockDir, 'state');
  const fakeEnv = {
    LOCALAPPDATA: path.join(lockDir, 'LocalAppData'),
    BROWSER_BRIDGE_STATE_DIR: stateDir,
  };
  const { RefMap } = require('../lib/cdp/locator');
  const rm = new RefMap();
  rm.add('e1', 101, 'button', '重置密码', 0, { selector: 'button.reset-pwd' });
  rm.add('e2', 102, 'textbox', '管理员密码', 0, { selector: 'input[type="password"]' });

  cdp.saveRefState(9232, 'TAB-ADMIN', {
    url: 'http://10.1.3.38/k3cloud/html5/index.aspx',
    title: '金蝶云星空',
    text: '@e1 [button] "重置密码"\n@e2 [textbox] "管理员密码"',
  }, rm, fakeEnv);

  const loaded = cdp.loadRefState(9232, 'TAB-ADMIN', {}, fakeEnv);
  assert.ok(loaded);
  const freshClient = {};
  loaded.hydrate(freshClient);
  assert.equal(freshClient._refMap.get(1).name, '重置密码');
  assert.equal(freshClient._refMap.get('e2').selector, 'input[type="password"]');

  const applied = cdp.applySceneToEnv({ scene: 'k3-admin' }, fakeEnv);
  assert.equal(applied.port, 9232);
  assert.equal(applied.browser, 'edge');
  assert.equal(fakeEnv.BROWSER_BRIDGE_EXPECT_PORT, '9232');
  assert.equal(fakeEnv.GCWEBAUTO_EXPECT_PORT, '9232');
  assert.equal(fakeEnv.BROWSER_BRIDGE_REQUIRE_INSTANCE, '1');
  assert.equal(fakeEnv.GCWEBAUTO_REQUIRE_INSTANCE, '1');

  const dailyEdge = path.join(fakeEnv.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default');
  assert.equal(cdp.scene.isDailyUserProfile(dailyEdge, fakeEnv), true);
  assert.equal(cdp.scene.isDailyUserProfile(applied.profile, fakeEnv), false);
});

test('v0.7.2: snapshot shortens huge _cnneptstate_ header URLs and diffSnapshots.diff renders clean text', async () => {
  const longToken = 'A'.repeat(400);
  const rawUrl = `http://10.1.3.38/k3cloud/html5/index.aspx?ud=&_cnneptstate_=${longToken}`;
  const fakePage = {
    async evalChecked(expr) {
      if (expr === 'true') return true;
      return {
        url: rawUrl,
        title: '金蝶云星空',
        lines: [
          '[ActiveModal] "重置用户密码 - 修改"',
          '[ModalBody] "密码即将修改，请确认！ 是 否"',
          '- button "是" [ref=e1]',
        ],
        refs: [{ refId: 'e1', role: 'button', name: '是', selector: '[data-abb-ref="e1"]' }],
      };
    },
  };
  const snapBefore = await cdp.snapshot(fakePage, 'true');
  assert.equal(snapBefore.url, rawUrl, 'raw SnapshotResult.url stays intact');
  assert.ok(snapBefore.text.includes('[400chars]'), 'display header shortens 400-char _cnneptstate_ parameter');
  assert.ok(!snapBefore.text.includes(longToken), 'display header omits full 400-char token');

  const afterText = snapBefore.text
    .replace('[ModalBody] "密码即将修改，请确认！ 是 否"', '[ModalBody] "确定 取消 新密码 *"')
    .replace('\n- button "是" [ref=e1]', '\n- button "取消" [ref=e1]');
  const diffRes = cdp.diffSnapshots(snapBefore.text, afterText);
  const rendered = typeof diffRes === 'string' ? diffRes : String(diffRes?.diff || '(no changes)');
  assert.equal(diffRes.changed, true);
  assert.ok(!rendered.includes('[object Object]'));
  assert.ok(rendered.includes('- [ModalBody] "密码即将修改，请确认！ 是 否"'));
  assert.ok(rendered.includes('+ [ModalBody] "确定 取消 新密码 *"'));
});
