const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createFileLock, withUiLock } = require('../lib/cdp/concurrency');
const { hoverAndClick, pressKey, fillNative } = require('../lib/cdp/interaction');
const { createDesktopClient, summarizeSnapshotCapabilities } = require('../lib/desktop/agentDesktop');
const { createAutomation, ensureWindowReady, deliverMessagesVerified, runWorkflow } = require('../lib/automation');

const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'agent-desktop-fixture.cjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-perf-opt-'));
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function desktopClient(options = {}, scenario = 'batch-stdin-132') {
  return createDesktopClient({ binaryPath: process.execPath, binaryArgs: [fixture, scenario], ...options });
}

test('empty ghost ui.lock directory recovers within 400ms instead of stalling 5000ms', async () => {
  const lockDir = path.join(tempRoot, 'ghost-lock-dir');
  fs.mkdirSync(lockDir, { recursive: true });
  const ghostPath = path.join(lockDir, 'ui-19991.lock');
  fs.mkdirSync(ghostPath);
  const oldTime = new Date(Date.now() - 400);
  fs.utimesSync(ghostPath, oldTime, oldTime);

  const prevLockDir = process.env.BROWSER_BRIDGE_LOCK_DIR;
  process.env.BROWSER_BRIDGE_LOCK_DIR = lockDir;
  const started = Date.now();
  try {
    const res = await withUiLock(async () => 'acquired', { port: 19991, timeoutMs: 2000 });
    const elapsed = Date.now() - started;
    assert.equal(res, 'acquired');
    assert.ok(elapsed < 400, `expected fast recovery < 400ms, got ${elapsed}ms`);
    assert.equal(fs.existsSync(ghostPath), false);
  } finally {
    if (prevLockDir === undefined) delete process.env.BROWSER_BRIDGE_LOCK_DIR;
    else process.env.BROWSER_BRIDGE_LOCK_DIR = prevLockDir;
  }
});

test('withUiLock is re-entrant within the same async execution context', async () => {
  const lockDir = path.join(tempRoot, 'reentrant-lock');
  fs.mkdirSync(lockDir, { recursive: true });
  const prevLockDir = process.env.BROWSER_BRIDGE_LOCK_DIR;
  process.env.BROWSER_BRIDGE_LOCK_DIR = lockDir;
  try {
    const value = await withUiLock(async () => {
      return withUiLock(async () => 'nested-ok', { port: 19992, timeoutMs: 300 });
    }, { port: 19992, timeoutMs: 1000 });
    assert.equal(value, 'nested-ok');
  } finally {
    if (prevLockDir === undefined) delete process.env.BROWSER_BRIDGE_LOCK_DIR;
    else process.env.BROWSER_BRIDGE_LOCK_DIR = prevLockDir;
  }
});

test('createFileLock release renames atomically and leaves no directory behind', () => {
  const lockPath = path.join(tempRoot, 'atomic-release.lock');
  const handle = createFileLock(lockPath, { ttlMs: 5000, resource: 'test' });
  assert.ok(handle);
  assert.equal(fs.existsSync(lockPath), true);
  handle.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('pressKey Enter dispatches carriage return text on keyDown and enables focus emulation on background tabs', async () => {
  const sent = [];
  const fakeCdp = {
    targetId: 't-bg-1',
    autoUiLock: false,
    port: 19993,
    evalChecked: async () => true,
    send: async (method, params) => sent.push({ method, params }),
  };
  const res = await pressKey(fakeCdp, 'Enter', 'true');
  assert.equal(res.pressed, true);
  assert.equal(sent[0].method, 'Emulation.setFocusEmulationEnabled');
  assert.deepEqual(sent[0].params, { enabled: true });
  assert.equal(sent[1].method, 'Input.dispatchKeyEvent');
  assert.equal(sent[1].params.type, 'keyDown');
  assert.equal(sent[1].params.text, '\r');
  assert.equal(sent[1].params.unmodifiedText, '\r');
  assert.equal(sent[2].params.type, 'keyUp');
  assert.equal(sent[2].params.text, undefined);
});

test('hoverAndClick performs hover then click inside one UI lock and honors cooperative policy', async () => {
  const events = [];
  let hovered = false;
  const fakePage = {
    port: 19994,
    autoUiLock: false,
    evalChecked: async (expr) => {
      if (expr === 'fixtureGuard') return true;
      if (expr.includes('Hover target must be unique')) return { x: 40, y: 50 };
      if (expr.includes('Click target must be unique')) {
        if (!hovered) throw new Error('Destroy button still hidden before hover');
        events.push('dom-click');
        return { tag: 'BUTTON', text: '×' };
      }
      return true;
    },
    send: async (method, params) => {
      events.push({ method, params });
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') hovered = true;
    },
  };
  const out = await hoverAndClick(fakePage, '.todo-list li', 'button.destroy', 'fixtureGuard');
  assert.equal(out.hovered, true);
  assert.equal(out.clicked, true);
  const mouseMovedIdx = events.findIndex(e => e?.method === 'Input.dispatchMouseEvent' && e?.params?.type === 'mouseMoved');
  assert.ok(mouseMovedIdx >= 0, 'falls back to mouseMoved when CSS/DOM node resolution is unavailable');
  assert.equal(events[mouseMovedIdx + 1], 'dom-click');

  const cssEvents = [];
  let cssHoverActive = false;
  const cssPage = {
    port: 19994,
    autoUiLock: false,
    evalChecked: async (expr) => {
      if (expr === 'fixtureGuard') return true;
      if (expr.includes('Click target must be unique')) {
        if (!cssHoverActive) throw new Error('CSS :hover not active');
        cssEvents.push('dom-click');
        return { x: 70, y: 80, rect: { x: 60, y: 70, width: 20, height: 20 } };
      }
      return true;
    },
    send: async (method, params) => {
      cssEvents.push({ method, params });
      if (method === 'Runtime.evaluate') return { result: { objectId: 'obj-1' } };
      if (method === 'DOM.requestNode') return { nodeId: 42 };
      if (method === 'CSS.forcePseudoState') {
        cssHoverActive = Array.isArray(params.forcedPseudoClasses) && params.forcedPseudoClasses.includes('hover');
        return {};
      }
      if (method === 'Runtime.callFunctionOn') return { result: { value: { x: 40, y: 50 } } };
      return {};
    },
  };
  const cssOut = await hoverAndClick(cssPage, '.todo-list li', 'button.destroy', 'fixtureGuard');
  assert.equal(cssOut.hovered, true);
  assert.equal(cssOut.clicked, true);
  assert.equal(cssHoverActive, false, 'CSS.forcePseudoState must be cleared in finally');
  assert.equal(cssEvents.some(e => e?.method === 'Input.dispatchMouseEvent'), false, 'semantic hoverAndClick avoids mouseMoved stall');
  assert.ok(cssEvents.some(e => e?.method === 'CSS.forcePseudoState' && e.params.forcedPseudoClasses[0] === 'hover'));
  assert.ok(cssEvents.some(e => e?.method === 'Runtime.callFunctionOn'));
  assert.ok(cssEvents.some(e => e?.method === 'CSS.forcePseudoState' && e.params.forcedPseudoClasses.length === 0));

  const cdpDep = {
    resolveConfig: () => ({ strict: true, profile: tempRoot, browser: 'edge', proxy: 'none', port: 19994 }),
    identity: { verify: async () => {} },
    withDedicatedTab: async (_opts, cb) => cb(fakePage),
    withUiLock: async fn => fn(),
    hoverAndClick: async () => ({ hovered: true, clicked: true }),
  };
  await assert.rejects(
    createAutomation({}, { cdp: cdpDep }).browser.withDedicatedTab({ url: 'https://example.com' }, p => p.hoverAndClick('.a', '.b', 'true')),
    { code: 'READ_ONLY_BLOCKED' },
  );
  await assert.rejects(
    createAutomation({ readOnly: false, mode: 'cooperative' }, { cdp: cdpDep }).browser.withDedicatedTab({ url: 'https://example.com' }, p => p.hoverAndClick('.a', '.b', 'true', { box: true })),
    { code: 'FOREGROUND_REQUIRED' },
  );
});

test('adBatch uses native batch --stdin when supported, scrubs write secrets, and falls back safely on 1.3.1', async () => {
  const secret = 'sensitive-batch-payload-123';
  const d132 = desktopClient({ readOnly: false }, 'batch-stdin-132');
  const res132 = await d132.adBatch([
    { command: 'set-value', ref: '@s1:e1', value: secret },
    { command: 'get', ref: '@s1:e1', property: 'value' },
    { command: 'click', ref: '@s1:e2' },
  ]);
  assert.equal(res132.transport, 'native-batch-stdin');
  assert.equal(res132.completed_entries, 3);
  assert.equal(JSON.stringify(res132.results[0]).includes(secret), false);
  assert.equal(res132.results[1].data.value, secret);

  const d131 = desktopClient({ readOnly: false }, 'normal');
  const res131 = await d131.adBatch([
    { command: 'set-value', ref: '@s1:e1', value: secret },
    { command: 'click', ref: '@s1:e2' },
  ]);
  assert.equal(res131.transport, 'hybrid-1.3.1');
  assert.equal(res131.completed_entries, 2);
  assert.equal(JSON.stringify(res131.results[0]).includes(secret), false);

  await assert.rejects(desktopClient({ readOnly: true }).adBatch([{ command: 'click', ref: '@s1:e2' }]), { code: 'READ_ONLY_BLOCKED' });
  await assert.rejects(desktopClient({ readOnly: false, mode: 'cooperative' }).adBatch([{ command: 'press', combo: 'return', windowId: 'w-123' }]), { code: 'DESKTOP_FOREGROUND_REQUIRED' });
  await assert.rejects(desktopClient({ readOnly: false, mode: 'exclusive' }).adBatch([{ command: 'sandbox' }]), { code: 'DESKTOP_COMMAND_BLOCKED' });
});

test('adInspectCapabilities classifies minimized, caption-only custom UI, and semantic UIA windows', async () => {
  const prev = process.env.ABB_TEST_RESTORED;
  delete process.env.ABB_TEST_RESTORED;
  try {
    const minCap = await desktopClient({}, 'cap-minimized').adInspectCapabilities('chat.exe');
    assert.equal(minCap.mode, 'minimized_unobservable');
    assert.equal(minCap.minimized, true);

    const customCap = await desktopClient({}, 'cap-caption-only').adInspectCapabilities('fixture.exe');
    assert.equal(customCap.mode, 'custom_ui_visual');
    assert.equal(customCap.refCount, 5);
    assert.equal(customCap.clientInteractiveCount, 0);

    const uiaCap = await desktopClient({}, 'cap-uia').adInspectCapabilities('fixture.exe');
    assert.equal(uiaCap.mode, 'uia_semantic');
    assert.equal(uiaCap.editableRefs.length, 1);
    assert.equal(uiaCap.editableRefs[0].ref, '@suia1:e2');
    assert.equal(uiaCap.buttonRefs[0].ref, '@suia1:e3');
  } finally {
    if (prev === undefined) delete process.env.ABB_TEST_RESTORED;
    else process.env.ABB_TEST_RESTORED = prev;
  }
});

test('ensureWindowReady restores minimized windows, avoids unnecessary focus steal on UIA, and focuses custom UI', async () => {
  let restoredFlag = false;
  let focusedFlag = false;
  let currentMode = 'custom_ui_visual';
  const mockDesktop = {
    adInspectCapabilities: async () => (restoredFlag
      ? { windowId: 'w-min', minimized: false, isFocused: focusedFlag, bounds: { x: 20, y: 20, width: 900, height: 650 }, mode: currentMode }
      : { windowId: 'w-min', minimized: true, isFocused: false, bounds: { x: -32000, y: -32000, width: 0, height: 0 }, mode: 'minimized_unobservable' }),
    adRestoreWindow: async () => { restoredFlag = true; return { restored: true }; },
    adFocusWindow: async () => { focusedFlag = true; return { focused: true }; },
    adListWindows: async () => [{ id: 'w-min', is_focused: focusedFlag, bounds: { x: 20, y: 20, width: 900, height: 650 } }],
  };
  await assert.rejects(ensureWindowReady(mockDesktop, { app: 'chat.exe' }, { restoreIfMinimized: false }), { code: 'DESKTOP_WINDOW_MINIMIZED' });
  const ready = await ensureWindowReady(mockDesktop, { titleIncludes: 'CustomChat' });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.actions, ['restore', 'focus']);
  assert.equal(ready.mode, 'custom_ui_visual');

  restoredFlag = false;
  focusedFlag = false;
  currentMode = 'uia_semantic';
  const readyUia = await ensureWindowReady(mockDesktop, { titleIncludes: 'StandardUiaChat' });
  assert.equal(readyUia.ready, true);
  assert.deepEqual(readyUia.actions, ['restore']);
  assert.equal(readyUia.mode, 'uia_semantic');
});

test('deliverMessagesVerified delivers 4 UIA messages in 1 batch and never retries on mismatch or submit failure', async () => {
  const messages = ['消息一', '消息二', '消息三', '消息四'];
  const okClient = desktopClient({ readOnly: false }, 'composer-ok');
  const delivered = await deliverMessagesVerified(okClient, {
    mode: 'uia_semantic',
    editRef: '@s1:e1',
    sendRef: '@s1:e2',
  }, messages);
  assert.equal(delivered.ok, true);
  assert.equal(delivered.verifiedCount, 4);
  assert.equal(delivered.transport, 'native-batch-stdin');
  assert.equal(delivered.batchSteps, 12);

  const mismatchClient = desktopClient({ readOnly: false }, 'composer-mismatch');
  await assert.rejects(
    deliverMessagesVerified(mismatchClient, { mode: 'uia_semantic', editRef: '@s1:e1', sendRef: '@s1:e2' }, messages),
    err => err.code === 'COMPOSER_READBACK_MISMATCH' && err.disposition.retry === 'unsafe' && !err.message.includes('消息二'),
  );

  const failSubmitClient = desktopClient({ readOnly: false }, 'composer-submit-fail');
  await assert.rejects(
    deliverMessagesVerified(failSubmitClient, { mode: 'uia_semantic', editRef: '@s1:e1', sendRef: '@s1:e2' }, messages),
    err => err.code === 'ACTION_FAILED' && err.disposition.retry === 'unsafe' && err.details.verifiedCount === 1,
  );
});

test('deliverMessagesVerified visual mode verifies screenshot state change and flags unchanged frame as unsafe', async () => {
  const messages = ['第一条', '第二条', '第三条', '第四条'];
  const okVisual = desktopClient({ readOnly: false, mode: 'exclusive' }, 'composer-visual-ok');
  const res = await deliverMessagesVerified(okVisual, {
    mode: 'custom_ui_visual',
    windowId: 'w-123',
    bounds: { x: 10, y: 20, width: 200, height: 100 },
    composerRatio: { xRatio: 0.5, yRatio: 0.8 },
    settleMs: 10,
  }, messages);
  assert.equal(res.ok, true);
  assert.equal(res.verifiedCount, 4);
  assert.equal(res.batchSteps, 20);
  assert.notEqual(res.visualEvidence.beforeSha256, res.visualEvidence.afterSha256);

  const staticVisual = desktopClient({ readOnly: false, mode: 'exclusive' }, 'composer-visual-unchanged');
  await assert.rejects(
    deliverMessagesVerified(staticVisual, {
      mode: 'custom_ui_visual',
      windowId: 'w-123',
      bounds: { x: 10, y: 20, width: 200, height: 100 },
      composerRatio: { xRatio: 0.5, yRatio: 0.8 },
      settleMs: 10,
    }, messages),
    err => err.code === 'VISUAL_STATE_UNCHANGED' && err.disposition.delivery === 'delivered_unverified' && err.disposition.retry === 'unsafe',
  );
});

test('CLI agent.cjs supports desktop capabilities and desktop batch --stdin while enforcing write policy', () => {
  const env = { ...process.env, LOCALAPPDATA: path.join(tempRoot, 'cli-appdata') };
  const runCli = (cliArgs, input) => spawnSync(
    process.execPath,
    [path.join(root, 'cli/agent.cjs'), ...cliArgs],
    { encoding: 'utf8', env, input },
  );

  const batchPayload = JSON.stringify([{ command: 'click', ref: '@s1:e1' }]);
  const blocked = runCli(['desktop', 'batch', '--stdin'], batchPayload);
  assert.equal(blocked.status, 1);
  assert.equal(JSON.parse(blocked.stdout).error.code, 'READ_ONLY_BLOCKED');

  const invalidBrowser = runCli(['browser', 'click', 'e1']);
  assert.equal(invalidBrowser.status, 1);
  assert.equal(JSON.parse(invalidBrowser.stdout).error.code, 'BROWSER_NOT_CONFIGURED');
});

test('locator supports :has-text() with descendant selector and enriches generic Toggle Todo checkbox names', () => {
  const { parseSelectorOrLocator, BROWSER_LOCATOR_HELPERS_JS } = require('../lib/cdp/locator');
  const parsed = parseSelectorOrLocator('.todo-list li:has-text("采购核对") button.destroy');
  assert.equal(parsed.kind, 'cssText');
  assert.equal(parsed.selector, '.todo-list li');
  assert.equal(parsed.text, '采购核对');
  assert.equal(parsed.descendant, 'button.destroy');

  assert.equal(BROWSER_LOCATOR_HELPERS_JS.includes('/^toggle(?:\\s+(?:todo|item|row|all))?$/i'), true);
});

test('workflow refuses missing verifier before action and preserves action disposition on failed verification', async () => {
  let executed = 0;
  await assert.rejects(
    runWorkflow(async ({ step }) => {
      await step('missing-verifier', async () => { executed += 1; return { ok: true }; });
    }),
    err => err.code === 'STEP_UNVERIFIED' && err.disposition.delivery === 'not_delivered',
  );
  assert.equal(executed, 0);

  await assert.rejects(
    runWorkflow(async ({ step }) => {
      await step('custom-disposition', async () => ({ disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } }), () => false);
    }),
    err => err.code === 'VERIFICATION_FAILED' && err.disposition.delivery === 'delivered_unverified' && err.disposition.retry === 'unsafe',
  );
});

test('cooperative background page skips Target.activateTarget and physical mouse focus in modal fillNative', async () => {
  const sent = [];
  let activated = false;
  const bgPage = {
    targetId: 't-coop-modal',
    autoUiLock: false,
    _backgroundCooperative: true,
    browser: { send: async (method) => { if (method === 'Target.activateTarget') activated = true; } },
    evalChecked: async (expr) => {
      if (expr === 'guardOk') return true;
      if (expr.includes('inModal')) return { ok: true, inModal: true, x: 50, y: 60, w: 120, h: 30 };
      if (expr.includes('Input changed before readback')) return 'secret-val';
      return true;
    },
    send: async (method, params) => sent.push({ method, params }),
  };
  const out = await fillNative(bgPage, '#modal-input', 'secret-val', 'guardOk');
  assert.equal(out.inputVerified, true);
  assert.equal(activated, false);
  assert.equal(sent.some(e => e.method === 'Input.dispatchMouseEvent'), false);
});

test('legacy PowerShell desktop helpers are blocked by default outside test harness', () => {
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_TEST_CONTEXT;
  delete cleanEnv.BROWSER_BRIDGE_GUI_TESTS;
  delete cleanEnv.BROWSER_BRIDGE_ALLOW_LEGACY_DESKTOP;

  const probe = spawnSync(
    process.execPath,
    ['-e', `
      const d = require('./lib/desktop');
      const codes = [];
      for (const fn of ['invokeNamedButton', 'focusNamedWindow', 'sendKeysToNamedWindow', 'captureNamedWindow']) {
        try { d[fn]({}); } catch (e) { codes.push(e.code); }
      }
      console.log(JSON.stringify(codes));
    `],
    { cwd: root, encoding: 'utf8', env: cleanEnv },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), [
    'LEGACY_INTERFACE_DISABLED',
    'LEGACY_INTERFACE_DISABLED',
    'LEGACY_INTERFACE_DISABLED',
    'LEGACY_INTERFACE_DISABLED',
  ]);
});

test('unified CLI supports browser scenes, desktop ensure-ready, desktop deliver --stdin, and legacy CLI stderr redirects', () => {
  const cleanEnv = { ...process.env, LOCALAPPDATA: path.join(tempRoot, 'cli-unified-appdata') };
  delete cleanEnv.NODE_TEST_CONTEXT;

  const scenesRun = spawnSync(
    process.execPath,
    [path.join(root, 'cli/agent.cjs'), 'browser', 'scenes'],
    { cwd: root, encoding: 'utf8', env: cleanEnv },
  );
  assert.equal(scenesRun.status, 0, scenesRun.stderr);
  const scenesOut = JSON.parse(scenesRun.stdout);
  assert.equal(scenesOut.ok, true);
  assert.ok(Array.isArray(scenesOut.data.presets) && scenesOut.data.presets.length > 0);

  const runWithFixtureScenario = (scenario, cliArgs, input = '') => spawnSync(
    process.execPath,
    [
      '-e',
      `
        const adMod = require('./lib/desktop/agentDesktop');
        const orig = adMod.createDesktopClient;
        adMod.createDesktopClient = (opts) => orig({ ...opts, binaryPath: process.execPath, binaryArgs: [${JSON.stringify(fixture)}, ${JSON.stringify(scenario)}] });
        const { main } = require('./cli/agent.cjs');
        const { serializeError } = require('./lib/automation/errors');
        main(${JSON.stringify(cliArgs)}).catch(err => {
          process.stdout.write(JSON.stringify({ ok: false, error: serializeError(err) }) + '\\n');
          process.exitCode = 1;
        });
      `,
    ],
    { cwd: root, encoding: 'utf8', env: cleanEnv, input },
  );

  const ensureRun = runWithFixtureScenario('cap-uia', ['desktop', 'ensure-ready', '--app', 'fixture.exe', '--no-focus']);
  assert.equal(ensureRun.status, 0, ensureRun.stdout + ensureRun.stderr);
  const ensureOut = JSON.parse(ensureRun.stdout);
  assert.equal(ensureOut.ok, true);
  assert.equal(ensureOut.data.ready, true);
  assert.equal(ensureOut.data.mode, 'uia_semantic');

  const deliverPayload = JSON.stringify({
    spec: { mode: 'uia_semantic', editRef: '@s1:e1', sendRef: '@s1:e2' },
    messages: ['测试一', '测试二'],
  });
  const blockedDeliver = runWithFixtureScenario('composer-ok', ['desktop', 'deliver', '--stdin'], deliverPayload);
  assert.equal(blockedDeliver.status, 1);
  assert.equal(JSON.parse(blockedDeliver.stdout).error.code, 'READ_ONLY_BLOCKED');

  const okDeliver = runWithFixtureScenario('composer-ok', ['--write', 'desktop', 'deliver', '--stdin'], deliverPayload);
  assert.equal(okDeliver.status, 0, okDeliver.stdout + okDeliver.stderr);
  const okDeliverOut = JSON.parse(okDeliver.stdout);
  assert.equal(okDeliverOut.ok, true);
  assert.equal(okDeliverOut.data.verifiedCount, 2);

  const legacyAbb = spawnSync(
    process.execPath,
    [path.join(root, 'cli/abb.cjs'), 'scenes'],
    { cwd: root, encoding: 'utf8', env: cleanEnv },
  );
  assert.equal(legacyAbb.status, 0);
  assert.match(legacyAbb.stderr, /Prefer unified entry "node cli\/agent\.cjs browser \.\.\."/);
  assert.ok(Array.isArray(JSON.parse(legacyAbb.stdout).presets));
});

test('summarizeSnapshotCapabilities separates readonly/disabled controls from writable editableRefs and buttonRefs', () => {
  const cap = summarizeSnapshotCapabilities({
    ref_count: 5,
    tree: {
      ref_id: '@w1:win',
      role: 'window',
      name: 'ChatFixture',
      children: [
        { ref_id: '@w1:e1', role: 'textfield', name: '消息历史', states: ['focused', 'readonly'], available_actions: ['SetFocus'] },
        { ref_id: '@w1:e2', role: 'textfield', name: '禁用输入框', states: ['disabled'], available_actions: ['SetFocus'] },
        { ref_id: '@w1:e3', role: 'textfield', name: '输入消息', states: ['enabled', 'focusable'], available_actions: ['SetValue', 'SetFocus'] },
        { ref_id: '@w1:e4', role: 'button', name: '禁用按钮', states: ['disabled'], available_actions: ['Invoke'] },
        { ref_id: '@w1:e5', role: 'button', name: '发送', states: ['enabled'], available_actions: ['Invoke'] },
      ],
    },
  });
  assert.equal(cap.mode, 'uia_semantic');
  assert.deepEqual(cap.editableRefs.map(r => r.ref), ['@w1:e3']);
  assert.deepEqual(cap.readOnlyEditableRefs.map(r => r.ref), ['@w1:e1', '@w1:e2']);
  assert.deepEqual(cap.buttonRefs.map(r => r.ref), ['@w1:e5']);
  assert.equal(cap.clientInteractiveCount, 3);
});

test('adBatch gives Node execute timeout headroom over native --timeout-ms so native deadline JSON survives', async () => {
  const mockBin = path.join(tempRoot, 'mock-deadline-ad.cjs');
  fs.writeFileSync(mockBin, `
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
      process.stdout.write('agent-desktop 1.3.2\\n');
      process.exit(0);
    }
    const tmArg = args.find(a => a.startsWith('--timeout-ms='));
    const nativeMs = tmArg ? Number(tmArg.split('=')[1]) : 0;
    let stdin = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { stdin += d; });
    process.stdin.on('end', () => {
      setTimeout(() => {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: { code: 'NATIVE_DEADLINE', message: 'deadline reached cleanly', details: { nativeMs } },
        }) + '\\n');
        process.exit(1);
      }, nativeMs);
    });
  `, 'utf8');

  const client = createDesktopClient({ binaryPath: process.execPath, binaryArgs: [mockBin] });
  await assert.rejects(
    client.adBatch([{ command: 'get', ref: '@w1:e1' }], { timeoutMs: 400 }),
    err => err.code === 'NATIVE_DEADLINE' && err.details && err.details.nativeMs === 280,
  );
  await assert.rejects(
    client.adBatch([{ command: 'get', ref: '@w1:e1' }], { timeoutMs: 300, nativeTimeoutMs: 120 }),
    err => err.code === 'NATIVE_DEADLINE' && err.details && err.details.nativeMs === 120,
  );
});

test('hoverAndClick cleans up CSS.forcePseudoState on failure and preserves mouseMoved for box mode', async () => {
  let cssHoverActive = false;
  const failPage = {
    port: 19995,
    autoUiLock: false,
    evalChecked: async (expr) => {
      if (expr === 'fixtureGuard') return true;
      if (expr.includes('Click target must be unique')) throw new Error('Click target unavailable');
      return true;
    },
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'obj-fail' } };
      if (method === 'DOM.requestNode') return { nodeId: 99 };
      if (method === 'CSS.forcePseudoState') {
        cssHoverActive = Array.isArray(params.forcedPseudoClasses) && params.forcedPseudoClasses.includes('hover');
        return {};
      }
      if (method === 'Runtime.callFunctionOn') return { result: { value: { x: 10, y: 10 } } };
      return {};
    },
  };
  await assert.rejects(
    hoverAndClick(failPage, '.row', '.btn', 'fixtureGuard'),
    /Click target unavailable/,
  );
  assert.equal(cssHoverActive, false, 'CSS hover state must be cleared even when click fails');

  const boxEvents = [];
  const boxPage = {
    port: 19995,
    autoUiLock: false,
    evalChecked: async (expr) => {
      if (expr === 'fixtureGuard') return true;
      if (expr.includes('Hover target must be unique')) return { x: 12, y: 14 };
      if (expr.includes('Click target must be unique')) return { x: 30, y: 40, width: 20, height: 10, isPopupTrigger: false };
      return true;
    },
    send: async (method, params) => {
      boxEvents.push({ method, params });
      return {};
    },
  };
  const boxOut = await hoverAndClick(boxPage, '.row', '.btn', 'fixtureGuard', { box: true });
  assert.equal(boxOut.clicked, true);
  assert.equal(boxEvents.some(e => e.method === 'CSS.forcePseudoState'), false);
  assert.ok(boxEvents.some(e => e.method === 'Input.dispatchMouseEvent' && e.params.type === 'mouseMoved'));
  assert.ok(boxEvents.some(e => e.method === 'Input.dispatchMouseEvent' && e.params.type === 'mousePressed'));
});

test('identity persisted cache verifies loopback /json/version browserWsUrl without spawning netstat', async () => {
  const http = require('node:http');
  let activeUuid = 'ws-uuid-1';
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      const { port } = server.address();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${activeUuid}` }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const stateDir = path.join(tempRoot, 'id-state');
  const profileDir = path.join(tempRoot, 'id-profile');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const cacheFile = path.join(stateDir, `identity-verified-${port}.json`);
  const key = `${port}|edge|${profileDir}|none|false`;
  fs.writeFileSync(cacheFile, JSON.stringify({
    key,
    at: Date.now(),
    activePortSig: null,
    browserWsUrl: `ws://127.0.0.1:${port}/devtools/browser/ws-uuid-1`,
    result: { ok: true, pid: process.pid, browser: 'edge', profile: profileDir, port, proxy: 'none', loopback: true },
  }), 'utf8');

  const script = `
    process.env.BROWSER_BRIDGE_STATE_DIR = ${JSON.stringify(stateDir)};
    const identity = require(${JSON.stringify(path.join(root, 'lib/cdp/identity.js'))});
    (async () => {
      const t0 = performance.now();
      const res = await identity.verify({ config: { port: ${port}, browser: 'edge', profile: ${JSON.stringify(profileDir)}, proxy: 'none', attachExisting: false } });
      console.log(JSON.stringify({ ok: res.ok, pid: res.pid, ms: performance.now() - t0 }));
    })();
  `;
  const { execFile } = require('node:child_process');
  const runChild = () => new Promise((resolve) => {
    execFile(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ status: err ? (err.code || 1) : 0, stdout, stderr });
    });
  });
  try {
    if (process.platform === 'win32') {
      const hit = await runChild();
      assert.equal(hit.status, 0, hit.stderr);
      const parsed = JSON.parse(hit.stdout.trim());
      assert.equal(parsed.ok, true);
      assert.equal(parsed.pid, process.pid);
      assert.ok(parsed.ms < 250, `Expected fast /json/version cache hit, got ${parsed.ms}ms`);

      activeUuid = 'ws-uuid-changed';
      const miss = await runChild();
      assert.notEqual(miss.status, 0, 'Mismatched browserWsUrl must reject stale cache and fail full inspection');
    }
  } finally {
    server.close();
  }
});

test('withDedicatedTab waits for document.readyState complete on fresh http(s) tabs', async () => {
  const { withDedicatedTab } = require('../lib/cdp/concurrency');
  let evalCalls = 0;
  const fakeBrowser = {
    send: async (method) => {
      if (method === 'Target.getTargets') return { targetInfos: [] };
      if (method === 'Target.createTarget') return { targetId: 'fresh-spa-tab' };
      if (method === 'Target.attachToTarget') return { sessionId: 'sess-spa' };
      if (method === 'Runtime.evaluate') {
        evalCalls += 1;
        if (evalCalls === 1) return { result: { value: { href: 'about:blank', ready: 'complete' } } };
        if (evalCalls === 2) return { result: { value: { href: 'https://example.test/app', ready: 'loading' } } };
        return { result: { value: { href: 'https://example.test/app', ready: 'complete' } } };
      }
      return {};
    },
    close: () => {},
    isDead: () => null,
    on: () => () => {},
    ready: Promise.resolve(),
  };

  await withDedicatedTab(fakeBrowser, { port: 19996, url: 'https://example.test/app' }, async () => {});
  assert.equal(evalCalls, 3, 'Should wait until href transitions away from about:blank AND readyState reaches complete');
});

test('cli/agent.cjs documents browser flags/subcommands, enforces browser close policy, and surfaces load errors', () => {
  const cleanEnv = { ...process.env };
  delete cleanEnv.CDP_HTTP;
  delete cleanEnv.BROWSER_BRIDGE_PROFILE;
  delete cleanEnv.BROWSER_BRIDGE_BROWSER;
  delete cleanEnv.BROWSER_BRIDGE_PROXY;

  const helpRun = spawnSync(process.execPath, [path.join(root, 'cli/agent.cjs'), '--help'], { cwd: root, encoding: 'utf8', env: cleanEnv });
  assert.equal(helpRun.status, 0);
  for (const token of ['browser select', 'browser wait', 'browser close', '--url', '--open-url', '--target', '--no-diff', '--all', '--box', '--guard']) {
    assert.ok(helpRun.stdout.includes(token), `Expected --help to include ${token}`);
  }

  const closeReadOnly = spawnSync(process.execPath, [path.join(root, 'cli/agent.cjs'), '--scene', 'smoke', 'browser', 'close', '--url', 'example.com'], { cwd: root, encoding: 'utf8', env: cleanEnv });
  assert.equal(closeReadOnly.status, 1);
  assert.equal(JSON.parse(closeReadOnly.stdout).error.code, 'READ_ONLY_BLOCKED');

  const closeNoTarget = spawnSync(process.execPath, [path.join(root, 'cli/agent.cjs'), '--write', '--scene', 'smoke', 'browser', 'close'], { cwd: root, encoding: 'utf8', env: cleanEnv });
  assert.equal(closeNoTarget.status, 1);
  assert.equal(JSON.parse(closeNoTarget.stdout).error.code, 'INVALID_ARGS');

  const missingWf = spawnSync(process.execPath, [path.join(root, 'cli/agent.cjs'), 'run', '--file', path.join(tempRoot, 'does-not-exist.cjs')], { cwd: root, encoding: 'utf8', env: cleanEnv });
  assert.equal(missingWf.status, 1);
  const missingErr = JSON.parse(missingWf.stdout).error;
  assert.equal(missingErr.code, 'INVALID_ARGS');
  assert.match(missingErr.message, /Workflow file not found: does-not-exist\.cjs/);

  const badWfPath = path.join(tempRoot, 'broken-require-wf.cjs');
  fs.writeFileSync(badWfPath, "require('./nonexistent-dep-xyz');\nmodule.exports = async () => {};\n", 'utf8');
  const brokenWf = spawnSync(process.execPath, [path.join(root, 'cli/agent.cjs'), 'run', '--file', badWfPath], { cwd: root, encoding: 'utf8', env: cleanEnv });
  assert.equal(brokenWf.status, 1);
  const brokenErr = JSON.parse(brokenWf.stdout).error;
  assert.equal(brokenErr.code, 'MODULE_NOT_FOUND');
  assert.match(brokenErr.message, /Failed to load workflow \(broken-require-wf\.cjs\): Cannot find module/);
});




