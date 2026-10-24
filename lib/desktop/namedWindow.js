const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function desktopShell() {
  return process.env.BROWSER_BRIDGE_PWSH || 'pwsh';
}

function artifactsDir() {
  if (process.env.BROWSER_BRIDGE_ARTIFACTS) return process.env.BROWSER_BRIDGE_ARTIFACTS;
  const projectDir = path.resolve(__dirname, '..', '..', 'artifacts');
  try {
    fs.mkdirSync(projectDir, { recursive: true });
    return projectDir;
  } catch {
    return os.tmpdir();
  }
}

function requireWindowTitle(windowTitle) {
  if (typeof windowTitle !== 'string' || !windowTitle.trim()) throw new Error('Named window title required');
}

function requireTimeout(timeoutSeconds) {
  if (timeoutSeconds < 1 || timeoutSeconds > 60) throw new Error('Named window timeout must be 1-60 seconds');
}

function runNamedWindow(action, options) {
  const windowTitle = options.windowTitle;
  const timeoutSeconds = options.timeoutSeconds ?? 10;
  requireWindowTitle(windowTitle);
  requireTimeout(timeoutSeconds);
  const args = [
    '-NoProfile',
    '-STA',
    '-File',
    path.join(__dirname, 'Invoke-NamedWindow.ps1'),
    '-Action',
    action,
    '-WindowTitle',
    windowTitle,
    '-TimeoutSeconds',
    String(timeoutSeconds)
  ];
  if (action === 'Keys') {
    const keys = options.keys;
    if (typeof keys !== 'string' || !keys.trim()) throw new Error('Named window keys required');
    if (keys.length > 200) throw new Error('Named window keys too long');
    if (/%\{F4\}|!\{F4\}/i.test(keys)) throw new Error('Refusing Alt+F4; this bridge does not close windows');
    args.push('-Keys', keys);
  }
  if (action === 'Capture') {
    args.push('-OutputPath', options.outputPath);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(desktopShell(), args, { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => reject(error));
    child.on('close', code => {
      const text = out.trim() || err.trim();
      if (code !== 0) {
        reject(new Error('Desktop named-window ' + action.toLowerCase() + ' failed: ' + (text || ('exit ' + code))));
        return;
      }
      const line = text.split(/\r?\n/).filter(Boolean).pop() || '';
      let parsed = {};
      try { parsed = JSON.parse(line); } catch { parsed = { ok: true, output: text }; }
      resolve({ ok: true, businessWrites: 0, ...parsed });
    });
  });
}

function focusNamedWindow(options = {}) {
  return runNamedWindow('Focus', options);
}

function sendKeysToNamedWindow(options = {}) {
  return runNamedWindow('Keys', options);
}

function captureNamedWindow(options = {}) {
  requireWindowTitle(options.windowTitle);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = options.outputPath || path.join(artifactsDir(), 'named-window-' + stamp + '.png');
  if (!path.isAbsolute(outputPath)) throw new Error('Capture output path must be absolute');
  return runNamedWindow('Capture', { ...options, outputPath });
}

module.exports = { focusNamedWindow, sendKeysToNamedWindow, captureNamedWindow };
