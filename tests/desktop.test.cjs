const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { invokeNamedButton } = require('../lib/desktop/invokeNamedButton');

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
