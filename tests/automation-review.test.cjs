const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createAutomation, runWorkflow } = require('../lib/automation');
const { createDesktopClient } = require('../lib/desktop/agentDesktop');
const { parse } = require('../cli/agent.cjs');
const { normalizeOptions } = require('../lib/automation/errors');

test('coordinate CLI target stays outside native argv and cannot change execution mode', () => {
  const parsed = parse(['desktop', 'mouse-click', '--xy=20,30', '--target-window', 'w-123']);
  const policy = normalizeOptions(parsed.options);
  assert.equal(parsed.options.windowId, 'w-123');
  assert.equal(policy.mode, 'cooperative');
  assert.equal(policy.readOnly, true);
  assert.deepEqual(parsed.rest, ['desktop', 'mouse-click', '--xy=20,30']);
});

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-independent-review-'));
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function dependencies() {
  const cdp = {
    resolveConfig: () => ({ strict: true, profile: temporary, browser: 'edge', proxy: 'none', port: 9229 }),
    identity: { verify: async () => {} },
    withDedicatedTab: async (options, callback) => callback({ port: options.port }),
    withLeasedTarget: async (criteria, options, callback) => callback({ port: options.port }),
  };
  return { cdp, createDesktopClient: () => ({}) };
}

test('a swallowed missing-verifier failure still ends the workflow unverified', async () => {
  await assert.rejects(runWorkflow(async ({ step }) => {
    try { await step('unverified operation', async () => 1); } catch {}
  }, {}, dependencies()), error => error.code === 'STEP_UNVERIFIED' && error.report.status === 'unverified');
});

test('a swallowed overlapping-step refusal cannot become a verified workflow', async () => {
  let calls = 0;
  await assert.rejects(runWorkflow(async ({ step }) => {
    const running = step('in flight', async () => { await sleep(30); calls++; }, () => true);
    try { await step('overlap', async () => { calls += 100; }, () => true); } catch {}
    await running;
  }, {}, dependencies()), { code: 'WORKFLOW_CONCURRENCY' });
  assert.equal(calls, 1);
});

test('loss of exclusive ownership prevents verification and later operations', async () => {
  const lockDir = path.join(temporary, 'ownership-loss');
  let verified = false;
  let later = false;
  await assert.rejects(runWorkflow(async ({ step }) => {
    await step('in flight', async () => {
      const ownerPath = path.join(lockDir, 'automation-exclusive.lock', 'owner.json');
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, token: 'independent-review-owner' }));
      await sleep(10);
    }, () => { verified = true; return true; });
    later = true;
  }, { mode: 'exclusive', lockDir }, dependencies()), { code: 'CDP_LEASE_LOST' });
  assert.equal(verified, false);
  assert.equal(later, false);
});

test('the unified browser cannot disable target lease renewal', async () => {
  const api = createAutomation({}, dependencies());
  await assert.rejects(api.browser.withLeasedTarget({ id: 'fixture-target', heartbeat: false }, async () => {}), { code: 'POLICY_DENIED' });
});

test('cooperative browser refuses every physical or capture facade before backend invocation', async () => {
  const api = createAutomation({ readOnly: false }, dependencies());
  await api.browser.withDedicatedTab({ url: 'about:blank' }, async page => {
    for (const name of ['clickByBox', 'dragByBox', 'pressKey', 'capturePagePng', 'captureUniquePng']) {
      await assert.rejects(page[name]('#fixture', 'true'), { code: 'FOREGROUND_REQUIRED' });
    }
  });
});

test('a native failure cannot echo a partial stdin secret through the JS error', async () => {
  const fixture = path.join(temporary, 'partial-secret-error.cjs');
  fs.writeFileSync(fixture, `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ ok: false, error: {
    code: 'ACTION_FAILED', message: 'Rejected: ' + input.slice(0, 7),
    disposition: { delivery: 'delivery_uncertain', retry: 'unsafe' },
    details: { fragment: input.slice(0, 8) }
  }}));
  process.exitCode = 1;
});

`);
  const client = createDesktopClient({ binaryPath: process.execPath, binaryArgs: [fixture], readOnly: false });
  const secret = 'private-stdin-value-42';
  await assert.rejects(client.adSetValue('@review:e1', secret), error => {
    assert.equal(error.code, 'ACTION_FAILED');
    assert.equal(error.disposition.delivery, 'delivery_uncertain');
    const report = JSON.stringify({ message: error.message, raw: error.raw, details: error.details });
    assert.equal(report.includes(secret.slice(0, 7)), false);
    return true;
  });
});


test('exclusive CLI ownership spans separate Node processes', async () => {
  const dir = fs.mkdtempSync(path.join(temporary, 'cli-lock-'));
  const marker = path.join(dir, 'started');
  const stop = path.join(dir, 'stop');
  const workflow = path.join(dir, 'workflow.cjs');
  fs.writeFileSync(workflow, `
const fs = require('node:fs');
module.exports = async ({step}) => {
  await step('hold exclusive fixture', async () => {
    fs.writeFileSync(${JSON.stringify(marker)}, 'started');
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(${JSON.stringify(stop)}) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }, () => true);
};
`);
  function start() {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../cli/agent.cjs'), 'run', '--file', workflow, '--mode', 'exclusive'], {
      windowsHide: true, env: { ...process.env, BROWSER_BRIDGE_LOCK_DIR: path.join(dir, 'locks') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    const result = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve({ code, output }));
    });
    return { child, result };
  }
  const first = start();
  let second;
  try {
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(marker) && Date.now() < deadline && first.child.exitCode === null) await sleep(20);
    assert.ok(fs.existsSync(marker), 'The first process must own the workflow before starting the second');
    second = start();
    const refused = await second.result;
    assert.equal(refused.code, 1);
    assert.equal(JSON.parse(refused.output).error.code, 'AUTOMATION_BUSY');
    fs.writeFileSync(stop, 'stop');
    assert.equal((await first.result).code, 0);
  } finally {
    fs.writeFileSync(stop, 'stop');
    for (const worker of [first, second]) if (worker && worker.child.exitCode === null) worker.child.kill();
    await Promise.allSettled([first.result, second?.result].filter(Boolean));
  }
});
