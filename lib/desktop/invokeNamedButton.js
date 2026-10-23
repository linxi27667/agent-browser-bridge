const { spawn } = require('node:child_process');
const path = require('node:path');

function desktopShell() {
  return process.env.BROWSER_BRIDGE_PWSH || 'pwsh';
}

function invokeNamedButton(options = {}) {
  const buttonName = options.buttonName;
  const windowTitle = options.windowTitle || '';
  const timeoutSeconds = options.timeoutSeconds ?? 10;
  const maxClicks = options.maxClicks ?? 1;
  if (typeof buttonName !== 'string' || !buttonName.trim()) throw new Error('Named desktop button required');
  if (timeoutSeconds < 1 || timeoutSeconds > 60) throw new Error('Desktop click timeout must be 1-60 seconds');
  if (maxClicks < 1 || maxClicks > 3) throw new Error('Desktop click count must be 1-3');
  const script = path.join(__dirname, 'Invoke-NamedButton.ps1');
  const args = [
    '-NoProfile',
    '-File',
    script,
    '-ButtonName',
    buttonName,
    '-TimeoutSeconds',
    String(timeoutSeconds),
    '-MaxClicks',
    String(maxClicks)
  ];
  if (windowTitle) args.push('-WindowTitle', windowTitle);
  return new Promise((resolve, reject) => {
    const child = spawn(desktopShell(), args, { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => reject(error));
    child.on('close', code => {
      if (code === 0) resolve({ ok: true, clicked: true, output: out.trim(), businessWrites: 0 });
      else reject(new Error('Desktop named-button click failed: ' + (out.trim() || err.trim() || ('exit ' + code))));
    });
  });
}

module.exports = { invokeNamedButton };
