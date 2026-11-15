const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createDesktopClient } = require('../lib/desktop/agentDesktop');

const fixture = path.join(__dirname, 'fixtures', 'agent-desktop-fixture.cjs');
const ref = '@sfixture:e1';
function client(options = {}, scenario = 'normal') {
  return createDesktopClient({ binaryPath: process.execPath, binaryArgs: [fixture, scenario], ...options });
}
const isCode = code => error => error.code === code;

test('version preflight never receives the text intended for a mutation', async () => {
  const desktop = client({ expectedVersion: '1.3.1', readOnly: false }, 'version-no-input');
  const result = await desktop.adSetValue(ref, 'only the target action receives this text');
  assert.equal(result.stdin, 'only the target action receives this text');
});

test('desktop availability checks the binary and exact installed version', async () => {
  const missing = createDesktopClient({ binaryPath: path.join(__dirname, 'missing-desktop.exe') });
  assert.equal(await missing.adAvailable(), false);
  assert.equal((await missing.adDiagnostics()).code, 'AGENT_DESKTOP_NOT_FOUND');
  await assert.rejects(missing.adStatus(), isCode('AGENT_DESKTOP_NOT_FOUND'));
  const present = client({ expectedVersion: '1.3.1' });
  assert.equal(await present.adAvailable(), true);
  assert.equal((await present.adStatus()).accessibility, 'granted');
  assert.equal((await present.adDiagnostics()).version, '1.3.1');
  assert.equal(await client({ expectedVersion: '1.3.0' }).adAvailable(), false);
  await assert.rejects(client({ expectedVersion: '1.3.0' }).adStatus(), isCode('AGENT_DESKTOP_VERSION_MISMATCH'));
});

test('desktop rejects invalid executable configuration and limits', () => {
  assert.throws(() => client({ mode: 'background' }), isCode('INVALID_ARGS'));
  assert.throws(() => client({ readOnly: 'false' }), isCode('INVALID_ARGS'));
  assert.throws(() => client({ timeoutMs: 0 }), isCode('INVALID_ARGS'));
  assert.throws(() => client({ maxOutputBytes: Infinity }), isCode('INVALID_ARGS'));
  assert.throws(() => client({ expectedVersion: '^1.3.1' }), isCode('INVALID_ARGS'));
  assert.throws(() => client({ binaryArgs: [null] }), isCode('INVALID_ARGS'));
  assert.throws(() => client({ desktopHome: 'relative-state' }), isCode('INVALID_ARGS'));
});

test('desktop state directory is scoped to the child process', async () => {
  const previous = process.env.AGENT_DESKTOP_HOME;
  const desktopHome = path.join(__dirname, 'fixture-state');
  assert.equal((await client({ desktopHome }).adStatus()).desktopHome, desktopHome);
  assert.equal(process.env.AGENT_DESKTOP_HOME, previous);
});

test('read-only desktop forbids mutations through methods and raw calls', async () => {
  const desktop = client();
  for (const operation of [
    () => desktop.adClick(ref), () => desktop.adSetValue(ref, 'text'),
    () => desktop.adRaw(['set-value', ref, '--stdin'], { input: 'text', readOnly: false }),
    () => desktop.adClipboardSet('clipboard'), () => desktop.adCloseApp('fixture.exe'),
  ]) await assert.rejects(operation(), isCode('READ_ONLY_BLOCKED'));
});

test('cooperative desktop permits semantic writes and forbids shared input effects', async () => {
  const desktop = client({ readOnly: false });
  assert.equal((await desktop.adClick(ref)).command, 'click');
  for (const operation of [
    () => desktop.adType(ref, 'text'), () => desktop.adPress('return', { app: 'fixture.exe' }),
    () => desktop.adFocusWindow('fixture.exe'), () => desktop.adLaunch(process.execPath),
    () => desktop.adClipboardSet('clipboard'), () => desktop.adMouseClick(20, 30, { windowId: 'w-123' }),
  ]) await assert.rejects(operation(), isCode('DESKTOP_FOREGROUND_REQUIRED'));
});

test('raw desktop commands cannot bypass policy through command or flag injection', async () => {
  const desktop = client({ readOnly: false, mode: 'exclusive' });
  for (const args of [ ['batch', '[]'], ['mcp'], ['sandbox', 'exec'], ['session', 'start'], ['--headed', 'click', ref], ['constructor'] ]) {
    await assert.rejects(desktop.adRaw(args), isCode('DESKTOP_COMMAND_BLOCKED'));
  }
  for (const args of [ ['click', ref, '--headed'], ['press', 'return', '--app=fixture.exe', '--force'],
    ['click', ref, '--session=unsafe'], ['snapshot', '--app=one.exe', '--app=two.exe'],
    ['set-value', ref, 'plain text'], ['snapshot', '--app'], ['snapshot', '--app', '--headed'],
  ]) await assert.rejects(desktop.adRaw(args), isCode('INVALID_ARGS'));
});

test('desktop requires explicit scopes and snapshot-qualified refs', async () => {
  const desktop = client({ readOnly: false, mode: 'exclusive' });
  for (const operation of [
    () => desktop.adSnapshot(), () => desktop.adFind(), () => desktop.adScreenshot(),
    () => desktop.adGet('@e1'), () => desktop.adClick('@e1'), () => desktop.adPress('return'),
    () => desktop.adSnapshot('fixture.exe', { windowId: '--headed' }),
    () => desktop.adLaunch('notepad.exe'), () => desktop.adMouseClick(NaN, 1),
    () => desktop.adScreenshot('fixture.exe', 'relative.png'),
  ]) await assert.rejects(operation(), isCode('INVALID_ARGS'));
});

test('desktop transmits all text on stdin, preserving Unicode and shell metacharacters', async () => {
  const value = '中文 "quotes" & $(not-a-command) `literal`\r\nline 2\n';
  const desktop = client({ readOnly: false });
  const result = await desktop.adSetValue(ref, value);
  assert.equal(result.stdin, value);
  assert.ok(result.args.includes('--stdin'));
  assert.ok(!result.args.some(arg => arg.includes(value)));
  const found = await desktop.adFind('fixture.exe', { name: 'one & two "$(literal)"' });
  assert.ok(found.args.includes('--name=one & two "$(literal)"'));
  await assert.rejects(desktop.adSetValue(ref, 'bad\0text'), isCode('INVALID_ARGS'));
  await assert.rejects(desktop.adSetValue(ref, 'x'.repeat(128 * 1024 + 1)), isCode('INVALID_ARGS'));
});

test('desktop preserves unsafe delivery metadata while redacting submitted text from errors', async () => {
  const secret = 'private-value';
  try { await client({ readOnly: false }, 'unsafe-error').adSetValue(ref, secret); assert.fail('must reject'); }
  catch (error) {
    assert.equal(error.code, 'ACTION_FAILED');
    assert.deepEqual(error.disposition, { delivery: 'delivered_unverified', retry: 'unsafe' });
    assert.equal(error.recovery.strategy, 'observe_only');
    assert.ok(!JSON.stringify({ message: error.message, raw: error.raw, details: error.details }).includes(secret));
    assert.ok(!JSON.stringify(error.raw).includes(secret.slice(0, 5)));
  }
});

test('desktop asynchronous execution leaves event-loop heartbeat running', async () => {
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 10);
  try { await client({ readOnly: false }, 'delay').adSetValue(ref, 'text'); }
  finally { clearInterval(heartbeat); }
  assert.ok(ticks >= 5, `expected live heartbeat, got ${ticks}`);
});

test('desktop timeout and cancellation after spawn never claim safe mutation retry', async () => {
  const desktop = client({ readOnly: false, timeoutMs: 100 }, 'slow');
  await assert.rejects(desktop.adSetValue(ref, 'text'), error => error.code === 'DESKTOP_TIMEOUT' && error.disposition.retry === 'unsafe');
  const controller = new AbortController();
  const pending = client({ readOnly: false }, 'slow').adSetValue(ref, 'text', { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, error => error.code === 'DESKTOP_ABORTED' && error.disposition.delivery === 'unknown');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(client({ readOnly: false }).adSetValue(ref, 'text', { signal: aborted.signal }), error => error.code === 'DESKTOP_ABORTED' && error.disposition.retry === 'safe');
});

test('desktop bounds output and treats malformed mutation results as unsafe', async () => {
  await assert.rejects(client({ maxOutputBytes: 1024 }, 'overflow').adStatus(), isCode('DESKTOP_OUTPUT_LIMIT'));
  await assert.rejects(client({ readOnly: false }, 'malformed').adSetValue(ref, 'secret'), error => error.code === 'AGENT_DESKTOP_PROTOCOL_ERROR' && error.disposition.retry === 'unsafe' && !error.message.includes('secret'));
});

test('exclusive coordinate input requires the current focused window and contained point', async () => {
  const desktop = client({ readOnly: false, mode: 'exclusive' });
  await assert.rejects(desktop.adMouseClick(20, 30), isCode('INVALID_ARGS'));
  await assert.rejects(desktop.adMouseClick(400, 30, { windowId: 'w-123' }), isCode('DESKTOP_TARGET_UNVERIFIED'));
  await assert.rejects(client({ readOnly: false, mode: 'exclusive' }, 'unfocused').adMouseClick(20, 30, { windowId: 'w-123' }), isCode('DESKTOP_TARGET_UNVERIFIED'));
  const result = await desktop.adMouseClick(20, 30, { windowId: 'w-123' });
  assert.equal(result.args[0], '--headed');
});

test('exclusive wrappers use native launch and close argument contracts', async () => {
  const desktop = client({ readOnly: false, mode: 'exclusive' });
  const launch = await desktop.adLaunch(process.execPath, { args: ['--test-flag', 'two words'] });
  assert.deepEqual(launch.args, ['launch', process.execPath, '--arg=--test-flag', '--arg=two words']);
  assert.deepEqual((await desktop.adCloseApp('fixture.exe')).args, ['close-app', 'fixture.exe']);
});
