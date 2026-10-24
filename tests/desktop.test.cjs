const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { invokeNamedButton, focusNamedWindow, sendKeysToNamedWindow, captureNamedWindow } = require('../lib/desktop');

test('named desktop button requires an explicit name', () => {
  assert.throws(() => invokeNamedButton({}), /Named desktop button required/);
});

test('named desktop button clicks an isolated local dialog', { timeout: 25000 }, async t => {
  const resultPath = path.join(os.tmpdir(), 'abb-desktop-smoke-' + process.pid + '.txt');
  try { fs.unlinkSync(resultPath); } catch { }
  const dialog = spawn('pwsh', [
    '-NoProfile',
    '-STA',
    '-File',
    path.join(__dirname, '..', 'scripts', 'Show-DesktopSmokeDialog.ps1'),
    '-ResultPath',
    resultPath
  ], { windowsHide: false });
  t.after(() => {
    if (!dialog.killed) dialog.kill();
    try { fs.unlinkSync(resultPath); } catch { }
  });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const result = await invokeNamedButton({
    buttonName: '允许',
    windowTitle: 'AgentBrowserBridge-desktop-smoke',
    timeoutSeconds: 15
  });
  assert.equal(result.clicked, true);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !fs.existsSync(resultPath)) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(fs.readFileSync(resultPath, 'utf8').trim(), 'clicked');
});

test('named window APIs require an explicit title and refuse Alt+F4', () => {
  assert.throws(() => focusNamedWindow({}), /Named window title required/);
  assert.throws(() => sendKeysToNamedWindow({ windowTitle: 'x' }), /Named window keys required/);
  assert.throws(() => sendKeysToNamedWindow({ windowTitle: 'x', keys: '%{F4}' }), /Alt\+F4/);
});

test('named window can focus, type and capture an isolated local dialog', { timeout: 25000 }, async t => {
  const resultPath = path.join(os.tmpdir(), 'abb-window-smoke-' + process.pid + '.txt');
  const shotPath = path.join(os.tmpdir(), 'abb-window-smoke-' + process.pid + '.png');
  const windowTitle = 'AgentBrowserBridge-window-smoke-' + process.pid;
  try { fs.unlinkSync(resultPath); } catch { }
  try { fs.unlinkSync(shotPath); } catch { }
  const dialog = spawn('pwsh', [
    '-NoProfile',
    '-STA',
    '-File',
    path.join(__dirname, '..', 'scripts', 'Show-DesktopWindowSmoke.ps1'),
    '-ResultPath',
    resultPath,
    '-WindowTitle',
    windowTitle
  ], { windowsHide: false });
  t.after(() => {
    if (!dialog.killed) dialog.kill();
    try { fs.unlinkSync(resultPath); } catch { }
    try { fs.unlinkSync(shotPath); } catch { }
  });
  await new Promise(resolve => setTimeout(resolve, 1800));
  const focused = await focusNamedWindow({
    windowTitle,
    timeoutSeconds: 15
  });
  assert.equal(focused.ok, true);
  const typed = await sendKeysToNamedWindow({
    windowTitle,
    keys: 'ok',
    timeoutSeconds: 15
  });
  assert.equal(typed.ok, true);
  const deadline = Date.now() + 5000;
  let typedText = '';
  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath)) {
      typedText = fs.readFileSync(resultPath, 'utf8').trim();
      if (typedText === 'ok') break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(typedText, 'ok');
  const shot = await captureNamedWindow({
    windowTitle,
    outputPath: shotPath,
    timeoutSeconds: 15
  });
  assert.equal(shot.ok, true);
  assert.equal(shot.path, shotPath);
  assert.ok(fs.statSync(shotPath).size > 100);
});
