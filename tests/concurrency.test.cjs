const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sleep } = require('../lib/cdp/client');
const {
  resolveLockDir,
  isProcessAlive,
  acquireTargetLease,
  withUiLock,
  activateTarget,
  withDedicatedTab,
} = require('../lib/cdp/concurrency');

const testLockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-bridge-concurrency-'));
process.env.BROWSER_BRIDGE_LOCK_DIR = testLockDir;

test.after(() => {
  try {
    fs.rmSync(testLockDir, { recursive: true, force: true });
  } catch {}
});

test('resolveLockDir honors BROWSER_BRIDGE_LOCK_DIR', () => {
  assert.equal(resolveLockDir(), testLockDir);
});

test('isProcessAlive correctly detects current and dead PIDs', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(99999999), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive('invalid'), false);
});

test('acquireTargetLease requires non-empty targetId', () => {
  assert.throws(() => acquireTargetLease(''), /targetId/);
  assert.throws(() => acquireTargetLease({}), /targetId/);
  assert.throws(() => acquireTargetLease({ targetId: '   ' }), /targetId/);
});

test('acquireTargetLease locks target and rejects concurrent lease on same targetId', () => {
  const targetId = 'tab-alpha-001';
  const lease1 = acquireTargetLease({ port: 9224, targetId, ownerTag: 'task1' });
  assert.equal(lease1.targetId, targetId);
  assert.ok(fs.existsSync(lease1.leasePath));

  const owner = JSON.parse(fs.readFileSync(path.join(lease1.leasePath, 'owner.json'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.resource, 'target:' + targetId);

  assert.throws(
    () => acquireTargetLease({ port: 9224, targetId, ownerTag: 'task2' }),
    (err) => err.code === 'CDP_TARGET_LEASED' && err.targetId === targetId
  );

  const lease2 = acquireTargetLease({ port: 9224, targetId: 'tab-beta-002', ownerTag: 'task2' });
  assert.equal(lease2.targetId, 'tab-beta-002');
  lease2.release();

  lease1.release();
  assert.equal(fs.existsSync(lease1.leasePath), false);

  const lease1Again = acquireTargetLease({ port: 9224, targetId, ownerTag: 'task3' });
  assert.ok(lease1Again);
  lease1Again.release();
});

test('acquireTargetLease auto-heals stale locks from dead processes or expired TTL', () => {
  const targetId = 'tab-stale-003';
  const lockDir = resolveLockDir();
  const lockPath = path.join(lockDir, `target-9224-${targetId}.lock`);
  fs.mkdirSync(lockPath, { recursive: true });

  fs.writeFileSync(
    path.join(lockPath, 'owner.json'),
    JSON.stringify({
      pid: 99999999,
      port: 9224,
      resource: 'target:' + targetId,
      ownerTag: 'crashed-process',
      acquiredAt: Date.now() - 10000,
      expiresAt: Date.now() + 100000,
    })
  );

  const lease = acquireTargetLease({ port: 9224, targetId, ownerTag: 'recovery-task' });
  assert.ok(lease);
  const newOwner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  assert.equal(newOwner.pid, process.pid);
  assert.equal(newOwner.ownerTag, 'recovery-task');
  lease.release();
});

test('withUiLock serializes executions without overlap', async () => {
  const runTask = (tag, durationMs) =>
    withUiLock(
      async () => {
        const start = Date.now();
        await sleep(durationMs);
        const end = Date.now();
        return { tag, start, end };
      },
      { port: 9224, pollMs: 20 }
    );

  const [resA, resB] = await Promise.all([runTask('taskA', 120), runTask('taskB', 120)]);
  const first = resA.start < resB.start ? resA : resB;
  const second = resA.start < resB.start ? resB : resA;

  assert.ok(
    second.start >= first.end - 10,
    `Critical sections must not overlap: first.end=${first.end}, second.start=${second.start}`
  );
});

test('withUiLock times out when lock cannot be obtained within timeoutMs', async () => {
  const lockDir = resolveLockDir();
  const lockPath = path.join(lockDir, 'ui-9224.lock');
  fs.mkdirSync(lockPath, { recursive: true });

  fs.writeFileSync(
    path.join(lockPath, 'owner.json'),
    JSON.stringify({
      pid: process.pid,
      port: 9224,
      resource: 'ui:9224',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 100000,
    })
  );

  try {
    await assert.rejects(
      withUiLock(async () => 'never', { port: 9224, timeoutMs: 150, pollMs: 30 }),
      (err) => err.code === 'CDP_UI_LOCK_TIMEOUT' && err.port === 9224
    );
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});

test('withUiLock auto-recovers stale UI lock from dead process', async () => {
  const lockDir = resolveLockDir();
  const lockPath = path.join(lockDir, 'ui-9224.lock');
  fs.mkdirSync(lockPath, { recursive: true });

  fs.writeFileSync(
    path.join(lockPath, 'owner.json'),
    JSON.stringify({
      pid: 99999999,
      port: 9224,
      resource: 'ui:9224',
      acquiredAt: Date.now() - 5000,
      expiresAt: Date.now() + 10000,
    })
  );

  let ran = false;
  await withUiLock(
    async () => {
      ran = true;
    },
    { port: 9224, timeoutMs: 500, pollMs: 30 }
  );

  assert.equal(ran, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('activateTarget requires valid targetId', async () => {
  await assert.rejects(activateTarget(''), /targetId/);
  await assert.rejects(activateTarget('  '), /targetId/);
});

test('withDedicatedTab requires callback function', async () => {
  await assert.rejects(withDedicatedTab({}), /callback/);
});
