// AgentBrowserBridge - agent-desktop 适配器 (Desktop Semantic Backend)
// 把 vercel-labs/agent-desktop 的 CLI 暴露成 lib/desktop 的方法，供 cli/run.cjs 的脚本直接调用。
// 设计约束：
//   1. 纯增量：不改动原有 4 个 PowerShell 函数（invokeNamedButton / focusNamedWindow /
//      sendKeysToNamedWindow / captureNamedWindow），它们继续作为兜底。
//   2. 不引入新的 npm 依赖：agent-desktop 走全局安装的二进制，未安装时明确报错而不是静默降级。
//   3. 统一错误：agent-desktop 的 JSON 信封 { ok, data, error } 在本层被拆开，
//      成功返回 data，失败抛 Error 并附带 .code / .disposition / .raw。
//
// 依赖：npm i -g agent-desktop（或设置环境变量 AGENT_DESKTOP_BIN 指向原生 exe）

const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_BUFFER = 32 * 1024 * 1024;

let cachedBinary = null;
let binaryResolved = false;

function platformExeName() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return `agent-desktop-win32-${arch}.exe`;
  if (process.platform === 'darwin') return `agent-desktop-darwin-${arch}`;
  return `agent-desktop-linux-${arch}`;
}

function globalModuleRoots() {
  const roots = [];
  try {
    const out = execSync('npm root -g', { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const line = String(out).trim().split(/\r?\n/).pop();
    if (line) roots.push(line.trim());
  } catch { }
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  if (process.env.npm_config_prefix) roots.push(path.join(process.env.npm_config_prefix, 'node_modules'));
  return roots;
}

function resolveBinary() {
  if (binaryResolved) return cachedBinary;
  binaryResolved = true;

  const override = process.env.AGENT_DESKTOP_BIN;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`AGENT_DESKTOP_BIN points to a missing file: ${override}`);
    }
    cachedBinary = override;
    return cachedBinary;
  }

  const exeName = platformExeName();
  for (const root of globalModuleRoots()) {
    const candidate = path.join(root, 'agent-desktop', 'bin', exeName);
    if (fs.existsSync(candidate)) {
      cachedBinary = candidate;
      return cachedBinary;
    }
  }

  cachedBinary = null;
  return null;
}

function parseEnvelope(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function envelopeError(command, error, envelope) {
  const err = new Error(`agent-desktop ${command} failed: ${error && error.message ? error.message : 'unknown error'}`);
  err.code = (error && error.code) || 'AGENT_DESKTOP_ERROR';
  err.disposition = (error && error.disposition) || null;
  err.raw = envelope || null;
  return err;
}

function run(args, options = {}) {
  const command = args[0];
  const bin = resolveBinary();
  const timeout = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const execOptions = {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
  };
  if (typeof options.input === 'string') execOptions.input = options.input;

  let stdout = '';
  if (bin) {
    try {
      stdout = execFileSync(bin, args, execOptions);
    } catch (err) {
      const envelope = parseEnvelope(`${err.stdout || ''}\n${err.stderr || ''}`);
      if (envelope && envelope.error) throw envelopeError(command, envelope.error, envelope);
      throw err;
    }
  } else {
    const quoted = args.map(a => (/[\s"']/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a)).join(' ');
    try {
      stdout = execSync(`agent-desktop ${quoted}`, execOptions);
    } catch (err) {
      const envelope = parseEnvelope(`${err.stdout || ''}\n${err.stderr || ''}`);
      if (envelope && envelope.error) throw envelopeError(command, envelope.error, envelope);
      const hint = 'agent-desktop binary not found in npm global root; install with "npm i -g agent-desktop" or set AGENT_DESKTOP_BIN';
      throw new Error(`${hint} (original: ${err.message})`);
    }
  }

  const envelope = parseEnvelope(stdout);
  if (!envelope) {
    throw new Error(`agent-desktop ${command} returned non-JSON output: ${String(stdout).slice(0, 300)}`);
  }
  if (!envelope.ok) throw envelopeError(command, envelope.error, envelope);
  return envelope.data;
}

function isAscii(text) {
  return /^[\x00-\x7F]*$/.test(text);
}

// ---- 环境与观测 ----

function adStatus() {
  return run(['status']);
}

function adAvailable() {
  try {
    return Boolean(resolveBinary()) || true;
  } catch {
    return false;
  }
}

function adListApps() {
  const data = run(['list-apps']);
  return data.apps || data;
}

function adListWindows(app) {
  const args = ['list-windows'];
  if (app) args.push('--app', app);
  const data = run(args);
  return Array.isArray(data) ? data : (data.windows || data);
}

function adSnapshot(app, options = {}) {
  const args = ['snapshot'];
  if (app) args.push('--app', app);
  if (options.windowId) args.push('--window-id', options.windowId);
  if (options.surface) args.push('--surface', options.surface);
  if (options.root) args.push('--root', options.root);
  if (options.skeleton) args.push('--skeleton');
  if (options.interactiveOnly !== false) args.push('-i');
  if (options.compact !== false) args.push('--compact');
  return run(args, { timeoutMs: options.timeoutMs });
}

function adFind(app, options = {}) {
  const args = ['find'];
  if (app) args.push('--app', app);
  if (options.windowId) args.push('--window-id', options.windowId);
  if (options.role) args.push('--role', options.role);
  if (options.name) args.push('--name', options.name);
  return run(args, { timeoutMs: options.timeoutMs });
}

function adGet(ref, property = 'text') {
  const data = run(['get', '--property', property, ref]);
  return data.value !== undefined ? data.value : data;
}

// ---- 动作 ----

function adClick(ref, options = {}) {
  const args = ['click'];
  if (options.headed) args.push('--headed');
  args.push(ref);
  return run(args, { timeoutMs: options.timeoutMs });
}

function adType(ref, text, options = {}) {
  const args = ['type'];
  if (options.headed) args.push('--headed');
  args.push(ref);
  const value = String(text == null ? '' : text);
  if (options.intervalMs) args.push('--interval-ms', String(options.intervalMs));
  if (isAscii(value) && !options.forceStdin) {
    args.push(value);
    return run(args, { timeoutMs: options.timeoutMs });
  }
  args.push('--stdin');
  return run(args, { input: value, timeoutMs: options.timeoutMs });
}

function adSetValue(ref, text, options = {}) {
  const args = ['set-value'];
  if (options.headed) args.push('--headed');
  args.push(ref);
  const value = String(text == null ? '' : text);
  if (isAscii(value) && !options.forceStdin) {
    args.push(value);
    return run(args, { timeoutMs: options.timeoutMs });
  }
  args.push('--stdin');
  return run(args, { input: value, timeoutMs: options.timeoutMs });
}

function adPress(combo, options = {}) {
  const args = ['press'];
  if (options.app) args.push('--app', options.app);
  if (options.windowId) args.push('--window-id', options.windowId);
  if (options.force) args.push('--force');
  args.push(combo);
  return run(args, { timeoutMs: options.timeoutMs });
}

function adFocusWindow(app, options = {}) {
  const args = ['focus-window'];
  if (app) args.push('--app', app);
  if (options.windowId) args.push('--window-id', options.windowId);
  return run(args, { timeoutMs: options.timeoutMs });
}

function adLaunch(target, options = {}) {
  const args = ['launch'];
  if (options.args) args.push('--args', options.args);
  args.push(target);
  return run(args, { timeoutMs: options.timeoutMs });
}

function adCloseApp(app) {
  return run(['close-app', '--app', app]);
}

// ---- 像素级兜底（自绘界面专用：微信 / LVGL / 各类 Canvas） ----

function adMouseClick(x, y, options = {}) {
  const args = ['mouse-click', '--headed', '--xy', `${Math.round(x)},${Math.round(y)}`];
  if (options.button) args.push('--button', options.button);
  if (options.count) args.push('--count', String(options.count));
  return run(args, { timeoutMs: options.timeoutMs });
}

function adClipboardSet(text) {
  return run(['clipboard-set', '--stdin'], { input: String(text == null ? '' : text) });
}

function adClipboardGet() {
  const data = run(['clipboard-get']);
  return data.text !== undefined ? data.text : data;
}

function adScreenshot(app, outputPath, options = {}) {
  const args = ['screenshot'];
  if (app) args.push('--app', app);
  if (options.windowId) args.push('--window-id', options.windowId);
  if (options.screen !== undefined) args.push('--screen', String(options.screen));
  if (outputPath) args.push(path.resolve(outputPath));
  const data = run(args, { timeoutMs: options.timeoutMs });
  return data;
}

// ---- 逃生舱：任何未封装的新命令 ----

function adRaw(args, options = {}) {
  return run(Array.isArray(args) ? args : [args], options);
}

module.exports = {
  adStatus,
  adAvailable,
  adListApps,
  adListWindows,
  adSnapshot,
  adFind,
  adGet,
  adClick,
  adType,
  adSetValue,
  adPress,
  adFocusWindow,
  adLaunch,
  adCloseApp,
  adMouseClick,
  adClipboardSet,
  adClipboardGet,
  adScreenshot,
  adRaw,
};
