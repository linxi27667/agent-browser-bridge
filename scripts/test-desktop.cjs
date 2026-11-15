#!/usr/bin/env node
// Opt-in legacy GUI checks: these isolated fixtures can take foreground focus.
const { spawn } = require('node:child_process');
const path = require('node:path');

const child = spawn(process.execPath, ['--test', 'tests/desktop.test.cjs'], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, BROWSER_BRIDGE_GUI_TESTS: '1' },
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
