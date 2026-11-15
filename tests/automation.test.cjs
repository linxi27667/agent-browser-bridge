const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAutomation, routeTask, runWorkflow, loadLocalConfig, doctor } = require('../lib/automation');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-automation-'));
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function dependencies() {
  const calls = [];
  const cdp = {
    resolveConfig: () => ({ strict: true, profile: temporary, browser: 'edge', proxy: 'none', port: 9229 }),
    identity: { verify: async () => calls.push('verify') },
    withDedicatedTab: async (options, run) => {
      calls.push({ kind: 'dedicated', options });
      return run({ port: 9229, autoUiLock: options.autoUiLock, readOnly: options.readOnly });
    },
    withLeasedTarget: async (criteria, options, run) => {
      calls.push({ kind: 'leased', criteria, options });
      return run({ port: 9229, autoUiLock: options.autoUiLock, readOnly: options.readOnly });
    },
    withUiLock: async (run, options) => { calls.push({ kind: 'ui-lock', options }); return run(); },
    readUnique: async () => 'observed',
    snapshot: async () => ({ text: 'snapshot' }),
    fillNative: async (page, selector, text) => {
      calls.push({ kind: 'fill', autoUiLock: page.autoUiLock, readOnly: page.readOnly });
      return { inputVerified: text === 'new value' };
    },
    clickByBox: async () => ({ clicked: true }),
  };
  return { cdp, calls, createDesktopClient: policy => ({ policy, adStatus: async () => ({ platform: 'test' }) }) };
}

test('route chooses direct interfaces and files before UI without executing anything', () => {
  assert.equal(routeTask({ api: true, url: 'https://example.com' }).route, 'api');
  assert.equal(routeTask({ file: 'input.csv', app: 'EXCEL.EXE' }).route, 'file');
  assert.equal(routeTask({ url: 'https://example.com', app: 'msedge.exe' }).route, 'browser');
  assert.equal(routeTask({ app: 'notepad.exe' }).route, 'desktop');
  assert.equal(routeTask({ app: 'custom.exe', visual: true }).route, 'visual');
  assert.equal(routeTask({}).route, 'clarify');
  assert.throws(() => routeTask({ url: 'javascript:alert(1)' }), { code: 'INVALID_ARGS' });
});

test('automation defaults are read-only and cooperative with no raw CDP escape in context', () => {
  const api = createAutomation({}, dependencies());
  assert.equal(api.desktop.policy.readOnly, true);
  assert.equal(api.desktop.policy.mode, 'cooperative');
  assert.equal(api.cdp, undefined);
  assert.equal(api.browser.connectBrowser, undefined);
  assert.throws(() => createAutomation({ mode: 'headless' }, dependencies()), { code: 'INVALID_ARGS' });
});

test('browser cooperative lease passes non-foreground options using the actual three-argument API', async () => {
  const deps = dependencies();
  const api = createAutomation({}, deps);
  await api.browser.withLeasedTarget({ id: 'fixture-id' }, async page => {
    assert.equal(page.evalChecked, undefined);
    assert.equal(page.send, undefined);
    assert.equal(await page.readUnique('#value', 'true'), 'observed');
  });
  const lease = deps.calls.find(c => c.kind === 'leased');
  assert.deepEqual(lease.criteria, { id: 'fixture-id' });
  assert.equal(lease.options.activate, false);
  assert.equal(lease.options.background, true);
  assert.equal(lease.options.autoUiLock, false);
  assert.equal(lease.options.readOnly, true);
  assert.equal(lease.options.onForeignAttach, 'fail');
});

test('cooperative semantic browser write retains serialization without foreground activation', async () => {
  const deps = dependencies();
  const api = createAutomation({ readOnly: false }, deps);
  await api.browser.withDedicatedTab({ url: 'https://example.com' }, async page => {
    assert.equal((await page.fillNative('#value', 'new value', 'true')).inputVerified, true);
    await assert.rejects(page.clickByBox('#value', 'true'), { code: 'FOREGROUND_REQUIRED' });
  });
  const lease = deps.calls.find(c => c.kind === 'dedicated');
  assert.equal(lease.options.keepOpen, true);
  assert.equal(lease.options.closeOnExit, false);
  assert.ok(deps.calls.some(c => c.kind === 'ui-lock'));
  assert.deepEqual(deps.calls.find(c => c.kind === 'fill'), { kind: 'fill', autoUiLock: false, readOnly: false });
});

test('read-only browser blocks mutators and task policy cannot be weakened by lease options', async () => {
  const api = createAutomation({}, dependencies());
  await api.browser.withDedicatedTab({ url: 'about:blank' }, async page => {
    await assert.rejects(page.fillNative('#value', 'new value', 'true'), { code: 'READ_ONLY_BLOCKED' });
    await assert.rejects(page.pressKey('Enter', 'true'), { code: 'READ_ONLY_BLOCKED' });
  });
  for (const override of [{ readOnly: false }, { activate: true }, { autoUiLock: false }, { keepOpen: false }, { port: 9222 }, { onLeased: 'newTab' }]) {
    await assert.rejects(api.browser.withDedicatedTab({ url: 'about:blank', ...override }, async () => {}), { code: 'POLICY_DENIED' });
  }
});

test('unconfigured browser is refused without connecting or launching', async () => {
  const deps = dependencies();
  deps.cdp.resolveConfig = () => ({ strict: false });
  const api = createAutomation({}, deps);
  await assert.rejects(api.browser.withDedicatedTab({ url: 'about:blank' }, async () => {}), { code: 'BROWSER_NOT_CONFIGURED' });
  assert.deepEqual(deps.calls, []);
});

test('workflow reports only actual verifier success and does not record action inputs or outputs', async () => {
  const secret = 'do not print this value';
  const report = await runWorkflow(async ({ step }) => {
    const value = await step('read source', async () => secret, actual => actual === secret);
    assert.equal(value, secret);
  }, {}, dependencies());
  assert.equal(report.status, 'verified');
  assert.equal(report.steps[0].status, 'verified');
  assert.ok(report.durationMs >= 0);
  assert.ok(!JSON.stringify(report).includes(secret));
});

test('workflow without verifiers or without registered steps remains unverified', async () => {
  let later = false;
  await assert.rejects(runWorkflow(async ({ step }) => {
    await step('observed', async () => 1);
    later = true;
  }, {}, dependencies()), error => error.code === 'STEP_UNVERIFIED' && error.report.status === 'unverified');
  assert.equal(later, false);
  assert.equal((await runWorkflow(async () => {}, {}, dependencies())).status, 'unverified');
});

test('verification failure stops the workflow and never retries the action', async () => {
  let calls = 0;
  await assert.rejects(runWorkflow(async ({ step }) => {
    await step('write', async () => { calls++; }, () => false);
    calls += 100;
  }, {}, dependencies()), error => {
    assert.equal(error.code, 'VERIFICATION_FAILED');
    assert.equal(error.disposition.retry, 'unsafe');
    assert.equal(error.report.status, 'failed');
    assert.equal(error.report.steps[0].status, 'failed');
    return true;
  });
  assert.equal(calls, 1);
});

test('uncertain delivery is preserved and a caught failed step cannot restart the workflow', async () => {
  let calls = 0;
  const uncertain = Object.assign(new Error('private native text'), { code: 'TIMEOUT', disposition: { delivery: 'delivery_uncertain', retry: 'unsafe' } });
  await assert.rejects(runWorkflow(async ({ step }) => {
    try { await step('uncertain action', async () => { throw uncertain; }, () => true); } catch {}
    await step('second action', async () => { calls++; }, () => true);
  }, {}, dependencies()), error => {
    assert.equal(error.report.steps[0].error.disposition.delivery, 'delivery_uncertain');
    assert.ok(!JSON.stringify(error.report).includes('private native text'));
    return true;
  });
  assert.equal(calls, 0);
});

test('unawaited steps drain before exclusive ownership is released', async () => {
  const lockDir = path.join(temporary, 'unawaited');
  let completed = false;
  await assert.rejects(runWorkflow(async ({ step }) => {
    step('slow fixture', async () => { await sleep(30); completed = true; }, () => true);
  }, { mode: 'exclusive', lockDir }, dependencies()), { code: 'WORKFLOW_CONCURRENCY' });
  assert.equal(completed, true);
  assert.equal(fs.existsSync(path.join(lockDir, 'automation-exclusive.lock')), false);
});

test('exclusive workflows reject concurrent callers and release ownership after completion', async () => {
  const lockDir = path.join(temporary, 'exclusive');
  let release;
  const pending = runWorkflow(async ({ step }) => step('hold', () => new Promise(resolve => { release = resolve; }), () => true), { mode: 'exclusive', lockDir }, dependencies());
  while (!release) await sleep(1);
  await assert.rejects(runWorkflow(async () => {}, { mode: 'exclusive', lockDir }, dependencies()), { code: 'AUTOMATION_BUSY' });
  release();
  assert.equal((await pending).status, 'verified');
  assert.equal(fs.existsSync(path.join(lockDir, 'automation-exclusive.lock')), false);
});

test('cancelled workflows perform no step actions', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(runWorkflow(async ({ step }) => step('cancelled', () => { calls++; }), { signal: controller.signal }, dependencies()));
  assert.equal(calls, 0);
});

test('local config imports only connection fields and honors explicit options and environment', () => {
  const filename = path.join(temporary, 'config.json');
  fs.writeFileSync(filename, JSON.stringify({ desktop: { binaryPath: 'config-binary', expectedVersion: '1.3.1' }, browser: { endpoint: 'http://127.0.0.1:9229', profile: temporary, browser: 'edge', proxy: 'none' } }));
  const env = { AGENT_DESKTOP_BIN: 'env-binary' };
  const loaded = loadLocalConfig({ configPath: filename, binaryPath: 'explicit-binary' }, env);
  assert.equal(loaded.options.binaryPath, 'explicit-binary');
  assert.equal(loaded.options.expectedVersion, '1.3.1');
  assert.equal(loaded.options.readOnly, undefined);
  assert.equal(env.CDP_HTTP, 'http://127.0.0.1:9229');
  assert.equal(env.BROWSER_BRIDGE_REQUIRE_INSTANCE, '1');
  fs.writeFileSync(filename, JSON.stringify({ desktop: { mode: 'exclusive' } }));
  assert.throws(() => loadLocalConfig({ configPath: filename }, {}), { code: 'CONFIG_INVALID' });
  const missing = loadLocalConfig({}, { LOCALAPPDATA: path.join(temporary, 'no-config'), AGENT_DESKTOP_EXPECT_VERSION: '1.3.1', AGENT_DESKTOP_HOME: temporary });
  assert.equal(missing.config.loaded, false);
  assert.equal(missing.options.expectedVersion, '1.3.1');
  assert.equal(missing.options.desktopHome, temporary);
});

test('doctor distinguishes executable availability from usable accessibility without enumerating applications', async () => {
  const deps = { createDesktopClient: () => ({
    adVersion: async () => ({ version: '1.3.1' }),
    adStatus: async () => { throw Object.assign(new Error('private local details'), { code: 'INTERNAL', disposition: { delivery: 'not_delivered', retry: 'safe' } }); },
  }) };
  const report = await doctor({}, deps);
  assert.equal(report.desktop.available, true);
  assert.equal(report.desktop.ready, false);
  assert.equal(report.desktop.error.code, 'INTERNAL');
  assert.ok(!JSON.stringify(report).includes('private local details'));
  deps.createDesktopClient = () => ({ adVersion: async () => ({ version: '1.3.1' }), adStatus: async () => ({ os: 'windows', permissions: { accessibility: { state: 'granted' } } }) });
  assert.equal((await doctor({}, deps)).desktop.ready, true);
});

test('CLI help, route, invalid options and workflow results have predictable exit status', () => {
  const env = { ...process.env, LOCALAPPDATA: path.join(temporary, 'empty-appdata') };
  const run = args => spawnSync(process.execPath, [path.join(root, 'cli/agent.cjs'), ...args], { encoding: 'utf8', env });
  assert.equal(run(['--help']).status, 0);
  assert.equal(JSON.parse(run(['route', '--url', 'https://example.com']).stdout).data.route, 'browser');
  const invalid = run(['--mode', 'invalid', 'route', '--api']);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_ARGS');
  const filename = path.join(temporary, 'workflow.cjs');
  fs.writeFileSync(filename, "module.exports=async({step})=>{await step('fixture',async()=>42, v=>v===42)}");
  const verified = run(['run', '--file', filename]);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.equal(JSON.parse(verified.stdout).data.status, 'verified');
  fs.writeFileSync(filename, "module.exports=async({step})=>{await step('fixture',async()=>42)}");
  const unverified = run(['run', '--file', filename]);
  assert.equal(unverified.status, 2, unverified.stdout + unverified.stderr);
  assert.equal(JSON.parse(unverified.stdout).report.status, 'unverified');
});

test('cooperative page keys keep port serialization and never activate the target', async () => {
  const deps = dependencies();
  deps.cdp.pressKey = async (page, key, guard) => {
    deps.calls.push({kind:'page-key', autoUiLock:page.autoUiLock, key, guard});
    return {pressed:true,key};
  };
  const api = createAutomation({readOnly:false}, deps);
  await api.browser.withLeasedTarget({id:'fixture-id'}, async page => {
    assert.equal((await page.pressKey('Enter','fixtureGuard')).pressed,true);
  });
  assert.ok(deps.calls.some(c => c.kind === 'ui-lock'));
  assert.deepEqual(deps.calls.find(c => c.kind === 'page-key'), {kind:'page-key',autoUiLock:false,key:'Enter',guard:'fixtureGuard'});
  assert.equal(deps.calls.find(c => c.kind === 'leased').options.activate,false);
});

test('cooperative hover stays in the leased page and preserves read-only protection', async () => {
  const deps=dependencies();
  let sent;
  deps.cdp.buildFindElementsExpression=(_page,selector)=>'document.querySelectorAll('+JSON.stringify(selector)+')';
  deps.cdp.withDedicatedTab=async(options,run)=>run({port:9229,autoUiLock:options.autoUiLock,evalChecked:async expression=>expression.includes('getBoundingClientRect')?{x:10,y:20}:true,send:async(method,args)=>{sent={method,args};}});
  await createAutomation({readOnly:false},deps).browser.withDedicatedTab({url:'about:blank'},async page=>{assert.equal((await page.hover('.todo-list li','fixtureGuard')).hovered,true);});
  assert.deepEqual(sent,{method:'Input.dispatchMouseEvent',args:{type:'mouseMoved',x:10,y:20,button:'none'}});
  await createAutomation({},deps).browser.withDedicatedTab({url:'about:blank'},async page=>{await assert.rejects(page.hover('.todo-list li','fixtureGuard'),{code:'READ_ONLY_BLOCKED'});});
});
