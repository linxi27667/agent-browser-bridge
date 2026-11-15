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

test('shell surfaces are explicit observation scopes and foreground opening stays guarded', async () => {
  const reader=client();
  assert.equal((await reader.adSnapshot(undefined,{surface:'taskbar'})).command,'snapshot');
  await assert.rejects(reader.adSnapshot(undefined,{surface:'window'}),isCode('INVALID_ARGS'));
  await assert.rejects(reader.adOpenSystemSurface('taskbar'),isCode('READ_ONLY_BLOCKED'));
  await assert.rejects(client({readOnly:false}).adOpenSystemSurface('system-tray-overflow'),isCode('DESKTOP_FOREGROUND_REQUIRED'));
  const exclusive=client({readOnly:false,mode:'exclusive'});
  const opened=await exclusive.adOpenSystemSurface('system-tray-overflow');
  assert.equal(opened.command,'open-system-surface');
  assert.ok(opened.args.includes('--headed'));
  await assert.rejects(exclusive.adOpenSystemSurface('desktop'),isCode('INVALID_ARGS'));
});

test('window restoration requires an explicit target and writable exclusive mode', async () => {
  await assert.rejects(client().adRestoreWindow(undefined,{windowId:'w-123'}),isCode('READ_ONLY_BLOCKED'));
  await assert.rejects(client({readOnly:false}).adRestoreWindow(undefined,{windowId:'w-123'}),isCode('DESKTOP_FOREGROUND_REQUIRED'));
  const desktop=client({readOnly:false,mode:'exclusive'});
  await assert.rejects(desktop.adRestoreWindow(),isCode('INVALID_ARGS'));
  assert.equal((await desktop.adRestoreWindow(undefined,{windowId:'w-123'})).command,'restore');
});

test('unlocked UIA queries and cooperative semantic actions preserve policy and argument contracts', async () => {
  const reader = client();
  assert.equal((await reader.adListDisplays()).command, 'list-displays');
  assert.equal((await reader.adListSurfaces('fixture.exe')).command, 'list-surfaces');
  const isRes = await reader.adIs(ref, 'checked');
  assert.equal(isRes.command, 'is');
  assert.ok(isRes.args.includes('--property=checked'));
  await assert.rejects(reader.adIs(ref, 'bogus'), isCode('INVALID_ARGS'));

  const findRes = await reader.adFind('fixture.exe', {
    role: 'button',
    text: 'Submit',
    nativeId: 'btnSubmit',
    states: ['enabled', 'focusable'],
    exact: true,
    first: true,
    limit: 5,
  });
  assert.ok(findRes.args.includes('--native-id=btnSubmit'));
  assert.ok(findRes.args.includes('--state=enabled'));
  assert.ok(findRes.args.includes('--state=focusable'));
  assert.ok(findRes.args.includes('--exact'));
  assert.ok(findRes.args.includes('--first'));
  assert.ok(findRes.args.includes('--limit=5'));

  assert.equal((await reader.adWait(120)).command, 'wait');
  assert.equal((await reader.adWait({ text: 'Ready', app: 'fixture.exe', timeout: 2000 })).command, 'wait');

  // Read-only blocks cooperative semantic mutations
  for (const op of [
    () => reader.adSelect(ref, 'Option A'),
    () => reader.adCheck(ref),
    () => reader.adUncheck(ref),
    () => reader.adToggle(ref),
    () => reader.adExpand(ref),
    () => reader.adCollapse(ref),
    () => reader.adClear(ref),
    () => reader.adFocus(ref),
    () => reader.adScroll(ref, { direction: 'down', amount: 3 }),
    () => reader.adScrollTo(ref),
  ]) await assert.rejects(op(), isCode('READ_ONLY_BLOCKED'));

  // Writable cooperative allows all background UIA pattern mutations without --headed
  const coop = client({ readOnly: false, mode: 'cooperative' });
  const sel = await coop.adSelect(ref, 'Option A');
  assert.deepEqual(sel.args, ['select', ref, 'Option A']);
  // Win32/WinForms DropDownList fallback: select ACTION_NOT_SUPPORTED -> set-value --stdin
  const fallbackSel = await client({ readOnly: false, mode: 'cooperative' }, 'select-unsupported').adSelect(ref, 'Urgent');
  assert.equal(fallbackSel.command, 'set-value');
  assert.equal(fallbackSel.fallback, 'set-value');
  assert.equal(fallbackSel.stdin, 'Urgent');

  assert.equal((await coop.adCheck(ref)).command, 'check');
  assert.equal((await coop.adUncheck(ref)).command, 'uncheck');
  assert.equal((await coop.adToggle(ref)).command, 'toggle');
  assert.equal((await coop.adExpand(ref)).command, 'expand');
  assert.equal((await coop.adCollapse(ref)).command, 'collapse');
  assert.equal((await coop.adClear(ref)).command, 'clear');
  // Windows SetFocus moves foreground window -> requires exclusive mode + --headed
  await assert.rejects(coop.adFocus(ref), isCode('DESKTOP_FOREGROUND_REQUIRED'));
  const scr = await coop.adScroll(ref, { direction: 'down', amount: 4 });
  assert.deepEqual(scr.args, ['scroll', ref, '--direction=down', '--amount=4']);
  assert.equal((await coop.adScrollTo(ref)).command, 'scroll-to');

  // Read-only blocks file-writing screenshot/clipboard-get while allowing base64/memory reads
  assert.ok((await reader.adScreenshot('fixture.exe')).data);
  await assert.rejects(reader.adScreenshot('fixture.exe', path.resolve('out.png')), isCode('READ_ONLY_BLOCKED'));
  await assert.rejects(reader.adClipboardGet({ out: path.resolve('clip.png') }), isCode('READ_ONLY_BLOCKED'));
  // surface=focused is allowed without --app, while invalid nth/limit fail fast
  assert.equal((await reader.adSnapshot(undefined, { surface: 'focused' })).command, 'snapshot');
  await assert.rejects(reader.adFind('fixture.exe', { nth: 'abc' }), isCode('INVALID_ARGS'));
  await assert.rejects(reader.adFind('fixture.exe', { limit: '0' }), isCode('INVALID_ARGS'));

  // Cooperative batch of rich UIA controls succeeds in 1 process
  const batchRes = await coop.adBatch([
    { command: 'set-value', ref, value: 'hello' },
    { command: 'select', ref, value: 'Option B' },
    { command: 'check', ref },
    { command: 'expand', ref },
    { command: 'scroll', ref, direction: 'down', amount: 2 },
    { command: 'is', ref, property: 'checked' },
  ], {}, );
  assert.equal(batchRes.completed_entries, 6);
});

test('exclusive mouse, hover, wheel, and window geometry commands enforce foreground and bounds checks', async () => {
  const coop = client({ readOnly: false, mode: 'cooperative' });
  for (const op of [
    () => coop.adDoubleClick(ref),
    () => coop.adRightClick(ref),
    () => coop.adHover(ref),
    () => coop.adMouseWheel(20, 30, { dy: -3, windowId: 'w-123' }),
    () => coop.adResizeWindow(undefined, 800, 600, { windowId: 'w-123' }),
    () => coop.adMoveWindow(undefined, 50, 60, { windowId: 'w-123' }),
    () => coop.adMinimizeWindow(undefined, { windowId: 'w-123' }),
    () => coop.adMaximizeWindow(undefined, { windowId: 'w-123' }),
  ]) await assert.rejects(op(), isCode('DESKTOP_FOREGROUND_REQUIRED'));

  const exclusive = client({ readOnly: false, mode: 'exclusive' });
  const dbl = await exclusive.adDoubleClick(ref);
  assert.equal(dbl.args[0], '--headed');
  assert.equal(dbl.command, 'double-click');

  const rclick = await exclusive.adRightClick(ref);
  assert.equal(rclick.args[0], '--headed');
  assert.equal(rclick.command, 'right-click');

  const hoverRef = await exclusive.adHover(ref);
  assert.equal(hoverRef.args[0], '--headed');
  // Coordinate hover & wheel must verify windowId + bounds!
  await assert.rejects(exclusive.adHover({ x: 20, y: 30 }), isCode('INVALID_ARGS'));
  await assert.rejects(exclusive.adHover({ x: 500, y: 30 }, { windowId: 'w-123' }), isCode('DESKTOP_TARGET_UNVERIFIED'));
  const hoverXy = await exclusive.adHover({ x: 20, y: 30 }, { windowId: 'w-123' });
  assert.equal(hoverXy.args[0], '--headed');

  await assert.rejects(exclusive.adMouseWheel(20, 30, { dy: -4 }), isCode('INVALID_ARGS'));
  await assert.rejects(exclusive.adMouseWheel(500, 30, { dy: -4, windowId: 'w-123' }), isCode('DESKTOP_TARGET_UNVERIFIED'));
  const wheel = await exclusive.adMouseWheel(20, 30, { dy: -4, windowId: 'w-123' });
  assert.equal(wheel.args[0], '--headed');
  assert.equal(wheel.command, 'mouse-wheel');

  assert.equal((await exclusive.adResizeWindow(undefined, 900, 700, { windowId: 'w-123' })).command, 'resize-window');
  assert.equal((await exclusive.adMoveWindow(undefined, 40, 50, { windowId: 'w-123' })).command, 'move-window');
  assert.equal((await exclusive.adMinimizeWindow(undefined, { windowId: 'w-123' })).command, 'minimize');
  assert.equal((await exclusive.adMaximizeWindow(undefined, { windowId: 'w-123' })).command, 'maximize');
  const focusRes = await exclusive.adFocus(ref);
  assert.equal(focusRes.args[0], '--headed');
  assert.equal(focusRes.command, 'focus');

  // Intra-batch TOCTOU guard: coordinate clicks cannot follow window geometry/focus mutations in the same batch
  await assert.rejects(
    exclusive.adBatch([
      { command: 'minimize', windowId: 'w-123' },
      { command: 'mouse-click', x: 20, y: 30, windowId: 'w-123' },
    ]),
    isCode('DESKTOP_TARGET_UNVERIFIED'),
  );

  // Dangerous shortcuts blocked across whitespace and modifier aliases
  for (const badCombo of ['alt + f4', 'meta+l', 'option+f4', 'ctrl + alt + del']) {
    await assert.rejects(exclusive.adPress(badCombo, { windowId: 'w-123' }), isCode('INVALID_ARGS'));
  }
});
