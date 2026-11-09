// AgentBrowserBridge - Code-First 批量脚本运行器与页面上下文防呆门禁 (Runner & Page Context Guard)
// 借鉴 citrolabs/ego-lite/package/ego-browser/src/page-context-guard.ts 与 run.ts：
// 1. 拦截在 Node 侧误写 document / window / location / localStorage / sessionStorage 的常见大模型失误
// 2. 支持单回合批量执行多步浏览器动作（Observe -> Act -> Diff），避免高频往返

const util = require('node:util');

const GUARDED_GLOBALS = [
  'document',
  'window',
  'location',
  'localStorage',
  'sessionStorage',
];

const BROWSER_ONLY_GLOBALS = new Set([
  ...GUARDED_GLOBALS,
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'MutationObserver',
  'XMLHttpRequest',
  'getComputedStyle',
  'alert',
  'confirm',
  'prompt',
]);

function pageContextMessage(name) {
  return `${name} is not defined in the Node runner. Run DOM code inside the page with await page.evalChecked("...")`;
}

/**
 * 在目标全局对象上安装浏览器全局对象防呆拦截器，返回可恢复的卸载函数。
 */
function installPageContextGuard(target = globalThis) {
  const previous = new Map();
  for (const name of GUARDED_GLOBALS) {
    const desc = Object.getOwnPropertyDescriptor(target, name);
    if (desc && desc.configurable === false) continue;
    previous.set(name, desc);
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: false,
      get() {
        throw new ReferenceError(pageContextMessage(name));
      },
    });
  }

  return function uninstallPageContextGuard() {
    for (const [name, desc] of previous.entries()) {
      try {
        if (desc) {
          Object.defineProperty(target, name, desc);
        } else {
          delete target[name];
        }
      } catch {}
    }
  };
}

/**
 * 为未捕获的 ReferenceError 补充 page.evalChecked 指引。
 */
function addPageContextHint(error) {
  if (!(error instanceof ReferenceError)) return error;
  const match = /^([A-Za-z_$][0-9A-Za-z_$]*) is not defined$/.exec(error.message);
  const name = match?.[1];
  if (!name || !BROWSER_ONLY_GLOBALS.has(name)) return error;

  const hinted = new ReferenceError(pageContextMessage(name));
  hinted.stack = error.stack?.replace(error.message, hinted.message) ?? hinted.stack;
  return hinted;
}

function formatValue(val) {
  if (typeof val === 'string') return val;
  return util.inspect(val, { depth: 4, colors: false, breakLength: 100 });
}

/**
 * 在受控沙箱上下文中运行一段异步自动化代码（单次往返内完成快照、定位、操作与校验）。
 * @param {string} code - 异步 JS 函数体（可使用顶层 await 与 return）
 * @param {object} [options] - { bindings, maxOutputLength, guardGlobals }
 */
async function runScript(code, options = {}) {
  if (typeof code !== 'string' || !code.trim()) {
    throw new Error('runScript requires non-empty JavaScript code');
  }

  const cdpModule = require('./index');
  let desktopModule = {};
  try {
    desktopModule = require('../desktop');
  } catch {}

  const logs = [];
  const cliLog = (...args) => {
    const line = args.map(formatValue).join(' ');
    logs.push(line);
    if (options.streamLogs) {
      process.stdout.write(line + '\n');
    }
  };

  const injected = {
    cdp: cdpModule,
    desktop: desktopModule,
    withDedicatedTab: cdpModule.withDedicatedTab,
    connectTarget: cdpModule.connectTarget,
    snapshot: cdpModule.snapshot,
    snapshotText: cdpModule.snapshotText,
    diffSnapshots: cdpModule.diffSnapshots,
    waitFor: cdpModule.waitFor,
    waitForSelector: cdpModule.waitForSelector,
    fillNative: cdpModule.fillNative,
    clickNative: cdpModule.clickNative,
    clickByBox: cdpModule.clickByBox,
    dragByBox: cdpModule.dragByBox,
    pressKey: cdpModule.pressKey,
    selectOption: cdpModule.selectOption,
    readUnique: cdpModule.readUnique,
    loadSiteLearning: cdpModule.loadSiteLearning,
    runSiteTool: cdpModule.runSiteTool,
    listSiteLearnings: cdpModule.listSiteLearnings,
    sleep: cdpModule.sleep,
    cliLog,
    ...(options.bindings || {}),
  };

  const paramNames = Object.keys(injected);
  const paramValues = paramNames.map((k) => injected[k]);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  let fn;
  try {
    fn = new AsyncFunction(...paramNames, code);
  } catch (err) {
    throw addPageContextHint(err);
  }

  const uninstall = options.guardGlobals !== false ? installPageContextGuard(globalThis) : () => {};
  try {
    const result = await fn(...paramValues);
    const outParts = [...logs];
    if (result !== undefined) {
      outParts.push(formatValue(result));
    }
    let output = outParts.join('\n');
    const maxLen = Number(options.maxOutputLength) || 0;
    if (maxLen > 0 && output.length > maxLen) {
      output = `${output.slice(0, maxLen)}\n... [truncated ${output.length - maxLen} chars]`;
    }
    return {
      ok: true,
      result,
      logs,
      output,
    };
  } catch (rawErr) {
    throw addPageContextHint(rawErr);
  } finally {
    uninstall();
  }
}

module.exports = {
  GUARDED_GLOBALS,
  BROWSER_ONLY_GLOBALS,
  installPageContextGuard,
  addPageContextHint,
  runScript,
};
