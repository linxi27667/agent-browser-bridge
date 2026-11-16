const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { safeDesktopError } = require('./agentDesktopProcess');
const winHelper = require('./winHelper');

const APP_PRESETS = [
  {
    key: 'wecom',
    displayName: 'WeCom (企业微信)',
    aliases: ['wecom', 'wxwork', 'wxwork.exe', 'wework', '企业微信', '企微'],
    exeNames: ['WXWork.exe'],
    strictExeMatch: true,
    appMatchers: ['wxwork', 'wecom'],
    titleMatchers: ['企业微信'],
    excludeExeNames: ['weixin.exe', 'wechat.exe', 'wechatappex.exe', 'weixinappex.exe', 'wxworkweb.exe', 'wxworkhelper.exe'],
    excludeTitleSubstrings: [],
    auxiliaryTitleSubstrings: ['智能助理', '预览', '图片查看', '视频', '微文档'],
    trayKeywords: ['企业微信', 'wecom', 'wxwork'],
    trayExcludeKeywords: [],
    layoutProfile: 'im_split_pane',
    defaultComposerRatio: { xRatio: 0.62, yRatio: 0.84 },
    chatTabRailOffset: { x: 32, y: 108 },
    searchShortcut: 'ctrl+f',
    minMainWindow: { width: 420, height: 320 },
    candidatePaths: [
      '%ProgramFiles(x86)%\\WXWork\\WXWork.exe',
      '%ProgramFiles%\\WXWork\\WXWork.exe',
      'D:\\WXWork\\WXWork.exe',
      'D:\\Program Files (x86)\\WXWork\\WXWork.exe',
      'D:\\Program Files\\WXWork\\WXWork.exe',
    ],
    registryProbes: [
      { key: 'HKCU\\Software\\Tencent\\WXWork', value: 'Executable' },
      { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\企业微信', value: 'DisplayIcon' },
    ],
  },
  {
    key: 'wechat',
    displayName: 'WeChat (微信)',
    aliases: ['wechat', 'weixin', 'wechat.exe', 'weixin.exe', '微信'],
    exeNames: ['Weixin.exe', 'WeChat.exe'],
    strictExeMatch: true,
    appMatchers: ['weixin', 'wechat'],
    titleMatchers: ['微信'],
    excludeExeNames: [
      'wxwork.exe', 'wxworkweb.exe', 'wechatappex.exe', 'weixinappex.exe',
      'wechatbrowser.exe', 'wechatplayer.exe', 'wechatutility.exe',
      'weixinhelper.exe', 'radiumwmpf.exe',
    ],
    excludeTitleSubstrings: ['企业微信'],
    auxiliaryTitleSubstrings: ['图片查看', '视频', '朋友圈', '小程序', '公众号', 'QQ邮箱', 'QQ 邮箱'],
    trayKeywords: ['微信', 'wechat', 'weixin'],
    trayExcludeKeywords: ['企业微信', 'wecom', 'wxwork'],
    layoutProfile: 'im_split_pane',
    defaultComposerRatio: { xRatio: 0.62, yRatio: 0.84 },
    chatTabRailOffset: { x: 35, y: 114 },
    searchShortcut: 'ctrl+f',
    minMainWindow: { width: 420, height: 320 },
    loginWindow: { minWidth: 220, minHeight: 280, maxWidth: 419, maxHeight: 540 },
    candidatePaths: [
      'C:\\Weixin\\Weixin.exe',
      'D:\\Weixin\\Weixin.exe',
      '%ProgramFiles%\\Tencent\\Weixin\\Weixin.exe',
      '%ProgramFiles(x86)%\\Tencent\\Weixin\\Weixin.exe',
      '%ProgramFiles%\\Tencent\\WeChat\\WeChat.exe',
      '%ProgramFiles(x86)%\\Tencent\\WeChat\\WeChat.exe',
      'D:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
      'D:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
    ],
    registryProbes: [
      { key: 'HKCU\\Software\\Tencent\\Weixin', value: 'InstallPath', appendExe: 'Weixin.exe' },
      { key: 'HKCU\\Software\\Tencent\\WeChat', value: 'InstallPath', appendExe: 'WeChat.exe' },
    ],
  },
  {
    key: 'qq',
    displayName: 'Tencent QQ',
    aliases: ['qq', 'qq.exe', 'qqnt', '腾讯qq'],
    exeNames: ['QQ.exe', 'QQScLauncher.exe'],
    strictExeMatch: true,
    appMatchers: ['qq'],
    excludeExeNames: ['qqexternal.exe', 'txplatform.exe'],
    auxiliaryTitleSubstrings: ['图片查看', '视频', 'QQ空间', 'QQ画板'],
    trayKeywords: ['qq', 'tencent qq', '腾讯qq'],
    trayExcludeKeywords: [],
    layoutProfile: 'im_split_pane',
    defaultComposerRatio: { xRatio: 0.62, yRatio: 0.84 },
    chatTabRailOffset: { x: 34, y: 112 },
    searchShortcut: 'ctrl+f',
    minMainWindow: { width: 420, height: 320 },
    candidatePaths: [
      '%ProgramFiles%\\Tencent\\QQNT\\QQ.exe',
      '%ProgramFiles(x86)%\\Tencent\\QQNT\\QQ.exe',
      '%ProgramFiles(x86)%\\Tencent\\QQ\\Bin\\QQScLauncher.exe',
      'D:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    ],
    registryProbes: [
      { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT', value: 'Install', appendExe: 'QQ.exe' },
    ],
  },
  {
    key: 'feishu',
    displayName: 'Feishu / Lark (飞书)',
    aliases: ['feishu', 'lark', 'feishu.exe', 'lark.exe', '飞书'],
    exeNames: ['Feishu.exe', 'Lark.exe'],
    strictExeMatch: true,
    appMatchers: ['feishu', 'lark', '飞书'],
    auxiliaryTitleSubstrings: ['图片预览', '飞书文档', '视频'],
    trayKeywords: ['飞书', 'feishu', 'lark'],
    trayExcludeKeywords: [],
    layoutProfile: 'im_split_pane',
    defaultComposerRatio: { xRatio: 0.62, yRatio: 0.85 },
    searchShortcut: 'ctrl+k',
    minMainWindow: { width: 480, height: 340 },
    candidatePaths: [
      '%LOCALAPPDATA%\\Feishu\\Feishu.exe',
      '%ProgramFiles%\\Feishu\\Feishu.exe',
      '%LOCALAPPDATA%\\Programs\\Feishu\\Feishu.exe',
    ],
    registryProbes: [],
  },
  {
    key: 'dingtalk',
    displayName: 'DingTalk (钉钉)',
    aliases: ['dingtalk', 'dingtalk.exe', '钉钉'],
    exeNames: ['DingTalk.exe', 'DingtalkLauncher.exe'],
    strictExeMatch: true,
    appMatchers: ['dingtalk', '钉钉'],
    auxiliaryTitleSubstrings: ['图片查看', '钉钉文档'],
    trayKeywords: ['钉钉', 'dingtalk'],
    trayExcludeKeywords: [],
    layoutProfile: 'im_split_pane',
    defaultComposerRatio: { xRatio: 0.62, yRatio: 0.84 },
    searchShortcut: 'ctrl+f',
    minMainWindow: { width: 480, height: 340 },
    candidatePaths: [
      '%ProgramFiles(x86)%\\DingDing\\DingtalkLauncher.exe',
      '%ProgramFiles%\\DingDing\\DingtalkLauncher.exe',
      'D:\\Program Files (x86)\\DingDing\\DingtalkLauncher.exe',
    ],
    registryProbes: [],
  },
  {
    key: 'notepad',
    displayName: 'Notepad (记事本)',
    aliases: ['notepad', 'notepad.exe', '记事本'],
    exeNames: ['notepad.exe'],
    appMatchers: ['notepad', '记事本'],
    layoutProfile: 'document',
    minMainWindow: { width: 160, height: 100 },
    candidatePaths: ['%WINDIR%\\System32\\notepad.exe'],
    registryProbes: [],
  },
  {
    key: 'explorer',
    displayName: 'File Explorer (资源管理器)',
    aliases: ['explorer', 'explorer.exe', '资源管理器', '文件资源管理器'],
    exeNames: ['explorer.exe'],
    appMatchers: ['explorer', '文件资源管理器'],
    layoutProfile: 'standard',
    minMainWindow: { width: 200, height: 140 },
    candidatePaths: ['%WINDIR%\\explorer.exe'],
    registryProbes: [],
  },
  {
    key: 'calc',
    displayName: 'Calculator (计算器)',
    aliases: ['calc', 'calc.exe', 'calculator', 'calculatorapp.exe', '计算器'],
    exeNames: ['calc.exe', 'CalculatorApp.exe'],
    appMatchers: ['calc', 'calculator', '计算器'],
    layoutProfile: 'standard',
    minMainWindow: { width: 180, height: 200 },
    candidatePaths: ['%WINDIR%\\System32\\calc.exe'],
    registryProbes: [],
  },
  {
    key: 'mspaint',
    displayName: 'Paint (画图)',
    aliases: ['mspaint', 'mspaint.exe', 'paint', '画图'],
    exeNames: ['mspaint.exe'],
    appMatchers: ['mspaint', 'paint', '画图'],
    layoutProfile: 'standard',
    minMainWindow: { width: 200, height: 160 },
    candidatePaths: ['%WINDIR%\\System32\\mspaint.exe'],
    registryProbes: [],
  },
];

function expandWinEnvVars(template, env = process.env) {
  return String(template || '').replace(/%([^%]+)%/g, (_m, name) => env[name] || '');
}

function cleanRegistryPath(raw, appendExe) {
  if (!raw) return null;
  let cleaned = String(raw).trim().replace(/^"+|"+$/g, '');
  const commaIdx = cleaned.lastIndexOf(',');
  if (commaIdx > 0 && /^-\d+$|^\d+$/.test(cleaned.slice(commaIdx + 1).trim())) {
    cleaned = cleaned.slice(0, commaIdx).trim().replace(/^"+|"+$/g, '');
  }
  if (appendExe && !cleaned.toLowerCase().endsWith('.exe')) {
    cleaned = path.join(cleaned, appendExe);
  }
  return cleaned && fs.existsSync(cleaned) ? path.resolve(cleaned) : null;
}

function queryRegistryValue(regKey, valueName) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('reg.exe', ['query', regKey, '/v', valueName], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*\S+\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i.exec(line);
      if (m) return expandWinEnvVars(m[1].trim());
    }
  } catch {}
  return null;
}

function queryRunningProcessPath(exeNames, runningByExe = null) {
  if (process.platform !== 'win32' || !Array.isArray(exeNames) || !exeNames.length) return null;
  if (runningByExe && typeof runningByExe === 'object') {
    for (const exe of exeNames) {
      const hit = runningByExe[String(exe || '').toLowerCase()];
      if (hit?.exePath && fs.existsSync(hit.exePath)) return path.resolve(hit.exePath);
    }
    return null;
  }
  const fast = typeof winHelper.queryRunningProcessPathSync === 'function'
    ? winHelper.queryRunningProcessPathSync(exeNames)
    : null;
  if (fast) {
    return fast.exePath || null;
  }
  const stems = exeNames.map(n => `'${path.basename(n, '.exe').replace(/'/g, "''")}'`).join(',');
  const ps = `$ErrorActionPreference='SilentlyContinue'; Get-Process -Name ${stems} | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path`;
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    try {
      const out = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out && fs.existsSync(out)) return path.resolve(out);
      break;
    } catch {}
  }
  return null;
}

function findViaWhere(exeName) {
  if (process.platform !== 'win32' || !exeName) return null;
  try {
    const out = execFileSync('where.exe', [exeName], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first && fs.existsSync(first)) return path.resolve(first);
  } catch {}
  return null;
}

function findPreset(appInput) {
  if (typeof appInput !== 'string' || !appInput.trim()) return null;
  const norm = appInput.trim().toLowerCase();
  const base = path.basename(norm);
  for (const preset of APP_PRESETS) {
    if (preset.aliases.includes(norm) || preset.aliases.includes(base)) return preset;
  }
  return null;
}

function resolveAppSpec(appInput, options = {}) {
  const explicitExe = typeof options.exePath === 'string' && options.exePath.trim()
    ? path.resolve(options.exePath.trim())
    : null;
  if (explicitExe && !fs.existsSync(explicitExe)) {
    throw safeDesktopError('APP_EXECUTABLE_NOT_FOUND', 'Specified executable path does not exist');
  }

  const raw = typeof appInput === 'string' ? appInput.trim() : '';
  const isAbsInput = raw && path.isAbsolute(raw);
  if (isAbsInput && !explicitExe && !fs.existsSync(raw)) {
    throw safeDesktopError('APP_EXECUTABLE_NOT_FOUND', 'Target executable path does not exist');
  }

  const preset = findPreset(raw || explicitExe || '');
  if (preset) {
    let exePath = explicitExe || (isAbsInput ? path.resolve(raw) : null);
    if (!exePath) {
      exePath = queryRunningProcessPath(preset.exeNames, options.runningByExe);
    }
    if (!exePath) {
      for (const probe of preset.registryProbes) {
        const regVal = queryRegistryValue(probe.key, probe.value);
        const hit = cleanRegistryPath(regVal, probe.appendExe);
        if (hit) { exePath = hit; break; }
      }
    }
    if (!exePath) {
      for (const exeName of preset.exeNames) {
        const appPathsVal = queryRegistryValue(`HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`, '')
          || queryRegistryValue(`HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`, '');
        const hit = cleanRegistryPath(appPathsVal);
        if (hit) { exePath = hit; break; }
      }
    }
    if (!exePath) {
      for (const cand of preset.candidatePaths) {
        const expanded = expandWinEnvVars(cand);
        if (expanded && fs.existsSync(expanded)) {
          exePath = path.resolve(expanded);
          break;
        }
      }
    }
    if (!exePath) {
      for (const exeName of preset.exeNames) {
        const hit = findViaWhere(exeName);
        if (hit) { exePath = hit; break; }
      }
    }
    return {
      key: preset.key,
      displayName: preset.displayName,
      knownPreset: true,
      exePath: exePath || null,
      installed: Boolean(exePath),
      exeNames: preset.exeNames,
      strictExeMatch: Boolean(preset.strictExeMatch),
      appMatchers: preset.appMatchers,
      titleMatchers: preset.titleMatchers || [],
      excludeExeNames: preset.excludeExeNames || [],
      excludeTitleSubstrings: preset.excludeTitleSubstrings || [],
      auxiliaryTitleSubstrings: preset.auxiliaryTitleSubstrings || [],
      trayKeywords: preset.trayKeywords || [],
      trayExcludeKeywords: preset.trayExcludeKeywords || [],
      loginWindow: preset.loginWindow || null,
      layoutProfile: preset.layoutProfile,
      defaultComposerRatio: preset.defaultComposerRatio || { xRatio: 0.55, yRatio: 0.82 },
      chatTabRailOffset: preset.chatTabRailOffset || null,
      searchShortcut: preset.searchShortcut || 'ctrl+f',
      minMainWindow: preset.minMainWindow,
    };
  }

  const resolvedDirect = explicitExe || (isAbsInput ? path.resolve(raw) : null);
  const stem = resolvedDirect
    ? path.basename(resolvedDirect, path.extname(resolvedDirect))
    : path.basename(raw, path.extname(raw));
  const exeName = (resolvedDirect ? path.basename(resolvedDirect) : (raw.toLowerCase().endsWith('.exe') ? raw : `${raw}.exe`));
  const exePath = resolvedDirect
    || (raw ? (queryRunningProcessPath([exeName], options.runningByExe) || findViaWhere(exeName)) : null);

  return {
    key: stem ? stem.toLowerCase() : 'custom',
    displayName: raw || (resolvedDirect ? path.basename(resolvedDirect) : 'custom'),
    knownPreset: false,
    exePath: exePath || null,
    installed: Boolean(exePath),
    exeNames: stem ? [exeName] : [],
    appMatchers: [stem.toLowerCase(), raw.toLowerCase()].filter(Boolean),
    titleMatchers: [],
    excludeExeNames: [],
    excludeTitleSubstrings: [],
    auxiliaryTitleSubstrings: [],
    trayKeywords: stem ? [stem] : [],
    trayExcludeKeywords: [],
    loginWindow: null,
    layoutProfile: 'standard',
    defaultComposerRatio: { xRatio: 0.55, yRatio: 0.82 },
    chatTabRailOffset: null,
    searchShortcut: 'ctrl+f',
    minMainWindow: { width: 120, height: 80 },
  };
}

function windowArea(win) {
  const b = win?.bounds;
  if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return 0;
  return Math.max(0, b.width) * Math.max(0, b.height);
}

function isWindowMinimized(win) {
  const b = win?.bounds;
  return Boolean(win?.minimized || win?.is_minimized || (b && (b.width <= 0 || b.height <= 0)));
}

function isExactExeMatch(win, appSpec) {
  if (!win || !Array.isArray(appSpec?.exeNames) || appSpec.exeNames.length === 0) return false;
  const appStr = String(win.app || win.app_name || win.process_name || '').trim().toLowerCase();
  if (!appStr) return false;
  const appBase = path.basename(appStr, '.exe');
  return appSpec.exeNames.some(exe => {
    const eLow = String(exe || '').toLowerCase();
    const eBase = path.basename(eLow, '.exe');
    return Boolean(eLow) && (appStr === eLow || (appBase && appBase === eBase));
  });
}

function matchesAppSpec(win, appSpec) {
  if (!win || !appSpec) return true;
  const appStr = String(win.app || win.app_name || win.process_name || '').trim().toLowerCase();
  const appBase = path.basename(appStr, '.exe');
  const titleStr = String(win.title || '').trim().toLowerCase();

  if (Array.isArray(appSpec.excludeExeNames) && appSpec.excludeExeNames.length > 0) {
    for (const ex of appSpec.excludeExeNames) {
      const exLow = String(ex || '').toLowerCase();
      const exBase = path.basename(exLow, '.exe');
      if (exLow && (appStr === exLow || (appBase && appBase === exBase))) return false;
    }
  }
  if (Array.isArray(appSpec.excludeTitleSubstrings) && appSpec.excludeTitleSubstrings.length > 0) {
    for (const sub of appSpec.excludeTitleSubstrings) {
      const s = String(sub || '').trim().toLowerCase();
      if (s && titleStr.includes(s)) return false;
    }
  }

  if (Array.isArray(appSpec.exeNames) && appSpec.exeNames.length > 0) {
    for (const exe of appSpec.exeNames) {
      const eLow = String(exe || '').toLowerCase();
      const eBase = path.basename(eLow, '.exe');
      if (eLow && (appStr === eLow || (appBase && appBase === eBase))) return true;
    }
    // Enforce exact exe identity when strictExeMatch is set so helper/mini-program
    // containers (e.g. WeChatAppEx.exe, WXWorkWeb.exe) never match the main IM preset.
    if (appSpec.strictExeMatch && appStr) return false;
  }

  const appMatchers = Array.isArray(appSpec.appMatchers) ? appSpec.appMatchers : [];
  if (appMatchers.some(m => {
    const ml = String(m || '').toLowerCase();
    return ml && appStr.includes(ml);
  })) {
    return true;
  }

  const titleMatchers = Array.isArray(appSpec.titleMatchers) ? appSpec.titleMatchers : [];
  if (!appSpec.knownPreset || !appStr) {
    for (const tm of titleMatchers) {
      const tl = String(tm || '').trim().toLowerCase();
      if (!tl) continue;
      if (tl === '微信') {
        if (titleStr === '微信' || titleStr.startsWith('微信 ') || titleStr === 'wechat') return true;
      } else if (titleStr.includes(tl)) {
        return true;
      }
    }
  }

  if (!appSpec.knownPreset && appMatchers.some(m => {
    const ml = String(m || '').toLowerCase();
    return ml && titleStr.includes(ml);
  })) {
    return true;
  }
  return false;
}

function isAuxiliaryWindow(win, appSpec) {
  if (!win || !Array.isArray(appSpec?.auxiliaryTitleSubstrings) || !appSpec.auxiliaryTitleSubstrings.length) {
    return false;
  }
  const titleLow = String(win.title || '').trim().toLowerCase();
  if (!titleLow) return false;
  if (appSpec.key === 'wecom' && titleLow === '企业微信') return false;
  if (appSpec.key === 'wechat' && titleLow === '微信') return false;
  return appSpec.auxiliaryTitleSubstrings.some(sub => {
    const s = String(sub || '').trim().toLowerCase();
    return Boolean(s) && titleLow.includes(s);
  });
}

function matchWindowsList(allWindows, appSpec, criteria = {}) {
  const list = Array.isArray(allWindows) ? allWindows : (allWindows?.windows || []);
  let matched = list;

  if (criteria.windowId) {
    matched = matched.filter(w => w.id === criteria.windowId);
    if (criteria.enforceAppSpec !== false && appSpec && (appSpec.appMatchers?.length || appSpec.exeNames?.length || appSpec.titleMatchers?.length)) {
      matched = matched.filter(w => matchesAppSpec(w, appSpec));
    }
  } else if (appSpec && (appSpec.appMatchers?.length || appSpec.exeNames?.length || appSpec.titleMatchers?.length)) {
    matched = matched.filter(w => matchesAppSpec(w, appSpec));
  } else if (criteria.app) {
    const needle = String(criteria.app).toLowerCase();
    matched = matched.filter(w => {
      const appStr = String(w.app || w.app_name || w.process_name || '').toLowerCase();
      const titleStr = String(w.title || '').toLowerCase();
      return appStr.includes(needle) || titleStr.includes(needle);
    });
  }

  if (typeof criteria.titleIncludes === 'string' && criteria.titleIncludes.trim()) {
    const sub = criteria.titleIncludes.trim().toLowerCase();
    matched = matched.filter(w => String(w.title || '').toLowerCase().includes(sub));
  }

  const excludeAux = Boolean(criteria.preferMainWindow && !criteria.windowId && !criteria.titleIncludes);
  const candidateList = excludeAux ? matched.filter(w => !isAuxiliaryWindow(w, appSpec)) : matched;

  const minW = criteria.minWidth ?? appSpec?.minMainWindow?.width ?? 120;
  const minH = criteria.minHeight ?? appSpec?.minMainWindow?.height ?? 80;
  const sizable = candidateList.filter(w => isWindowMinimized(w) || (w.bounds && w.bounds.width >= minW && w.bounds.height >= minH));
  let pool = sizable;
  if (pool.length === 0 && appSpec?.loginWindow) {
    const lwMinW = appSpec.loginWindow.minWidth ?? 200;
    const lwMinH = appSpec.loginWindow.minHeight ?? 240;
    const loginCandidates = candidateList.filter(w => w.bounds && w.bounds.width >= lwMinW && w.bounds.height >= lwMinH);
    if (loginCandidates.length > 0) pool = loginCandidates;
  }
  if (pool.length === 0) pool = candidateList;

  return [...pool].sort((a, b) => {
    const exactA = isExactExeMatch(a, appSpec);
    const exactB = isExactExeMatch(b, appSpec);
    if (exactA !== exactB) return exactA ? -1 : 1;
    const auxA = isAuxiliaryWindow(a, appSpec);
    const auxB = isAuxiliaryWindow(b, appSpec);
    if (auxA !== auxB) return auxA ? 1 : -1;
    if (Boolean(a.is_focused) !== Boolean(b.is_focused)) return a.is_focused ? -1 : 1;
    if (isWindowMinimized(a) !== isWindowMinimized(b)) return isWindowMinimized(a) ? 1 : -1;
    return windowArea(b) - windowArea(a);
  });
}

async function findMatchingWindows(desktop, appInput, criteria = {}) {
  const appSpec = (appInput || criteria.exePath)
    ? resolveAppSpec(appInput, { exePath: criteria.exePath })
    : null;
  const allWindows = await desktop.adListWindows(undefined, {
    signal: criteria.signal,
    timeoutMs: criteria.timeoutMs,
  });
  const windows = matchWindowsList(allWindows, appSpec, { ...criteria, app: appInput });
  return { appSpec, windows };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || safeDesktopError('ABORTED', 'Wait aborted'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason || safeDesktopError('ABORTED', 'Wait aborted'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function pollMatchingWindows(desktop, appInput, matchCriteria, budgetMs, signal) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(160, signal);
    const polled = await findMatchingWindows(desktop, appInput, matchCriteria);
    if (polled.windows.length > 0) {
      return polled;
    }
  }
  return null;
}

async function wakeOrLaunchApp(desktop, appInput, options = {}) {
  const preferMainWindow = options.preferMainWindow ?? (!options.windowId && !options.titleIncludes);
  const matchCriteria = {
    ...options,
    preferMainWindow,
  };
  const initial = await findMatchingWindows(desktop, appInput, matchCriteria);
  if (initial.windows.length > 0) {
    return {
      appSpec: initial.appSpec,
      window: initial.windows[0],
      windows: initial.windows,
      launched: false,
    };
  }

  const pol = typeof desktop?.adPolicy === 'function' ? desktop.adPolicy() : null;
  if (pol) {
    if (pol.readOnly) {
      throw safeDesktopError('READ_ONLY_BLOCKED', 'Desktop mutations require readOnly:false (--write)');
    }
    if (pol.mode !== 'exclusive') {
      throw safeDesktopError('DESKTOP_FOREGROUND_REQUIRED', 'Launching or waking a desktop application requires exclusive mode');
    }
  }

  const appSpec = initial.appSpec || resolveAppSpec(appInput, { exePath: options.exePath });
  const customLaunchRunner = typeof options.launchRunner === 'function';
  let runningInfo = null;
  if (process.platform === 'win32' && !customLaunchRunner && appSpec?.exeNames?.length) {
    runningInfo = await winHelper.queryRunningProcessInfo(appSpec.exeNames, {
      signal: options.signal,
      timeoutMs: Math.min(options.timeoutMs || 5000, 4000),
    }).catch(() => null);
  }

  // If process is already running in background/system tray ("后台任务"), wake its tray icon first
  if (runningInfo?.running && process.platform === 'win32' && !customLaunchRunner && appSpec?.trayKeywords?.length) {
    const tray1 = await winHelper.activateSystemTrayIcon({
      keywords: appSpec.trayKeywords,
      excludeKeywords: appSpec.trayExcludeKeywords,
      doubleClick: false,
      signal: options.signal,
      timeoutMs: Math.min(options.timeoutMs || 8000, 7000),
    }).catch(() => null);
    if (tray1?.found) {
      const woken1 = await pollMatchingWindows(desktop, appInput, matchCriteria, 1800, options.signal);
      if (woken1) {
        await sleep(150, options.signal);
        return {
          appSpec: woken1.appSpec || appSpec,
          window: woken1.windows[0],
          windows: woken1.windows,
          launched: false,
          wokenBy: 'tray_click',
          traySurface: tray1.surface,
        };
      }
      const tray2 = await winHelper.activateSystemTrayIcon({
        keywords: appSpec.trayKeywords,
        excludeKeywords: appSpec.trayExcludeKeywords,
        doubleClick: true,
        signal: options.signal,
        timeoutMs: Math.min(options.timeoutMs || 8000, 7000),
      }).catch(() => null);
      if (tray2?.found) {
        const woken2 = await pollMatchingWindows(desktop, appInput, matchCriteria, 1400, options.signal);
        if (woken2) {
          await sleep(150, options.signal);
          return {
            appSpec: woken2.appSpec || appSpec,
            window: woken2.windows[0],
            windows: woken2.windows,
            launched: false,
            wokenBy: 'tray_double_click',
            traySurface: tray2.surface,
          };
        }
      }
    }
  }

  const effectiveExe = (!options.exePath && runningInfo?.exePath && fs.existsSync(runningInfo.exePath))
    ? path.resolve(runningInfo.exePath)
    : appSpec.exePath;
  if (!effectiveExe || !fs.existsSync(effectiveExe)) {
    throw safeDesktopError(
      'APP_EXECUTABLE_NOT_FOUND',
      `No open window found for "${appInput || 'target'}" and no local executable could be resolved; pass --exe <ABSOLUTE_PATH>`,
    );
  }

  const launchArgs = Array.isArray(options.launchArgs) ? options.launchArgs.map(String) : [];
  if (customLaunchRunner) {
    await options.launchRunner(effectiveExe, launchArgs, options);
  } else if (process.platform === 'win32') {
    await winHelper.launchDetachedViaShell(effectiveExe, launchArgs, {
      cwd: path.dirname(effectiveExe),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  } else {
    const child = spawn(effectiveExe, launchArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: path.dirname(effectiveExe),
    });
    child.unref();
  }

  const waitBudgetMs = Number.isInteger(options.launchTimeoutMs) && options.launchTimeoutMs > 0
    ? options.launchTimeoutMs
    : 8000;
  const launchedPolled = await pollMatchingWindows(desktop, appInput, matchCriteria, waitBudgetMs, options.signal);
  if (launchedPolled) {
    if (process.platform === 'win32') {
      await sleep(200, options.signal);
    }
    return {
      appSpec: launchedPolled.appSpec || appSpec,
      window: launchedPolled.windows[0],
      windows: launchedPolled.windows,
      launched: true,
      alreadyRunning: Boolean(runningInfo?.running),
      wokenBy: runningInfo?.running ? 'shell_reactivate' : 'shell_launch',
      exePath: effectiveExe,
    };
  }

  throw safeDesktopError(
    'WINDOW_NOT_FOUND',
    `Launched "${path.basename(effectiveExe)}", but no visible main window appeared within ${waitBudgetMs}ms (check if login/tray lock or desktop session isolation applies)`,
  );
}

function listKnownApps() {
  const allExes = [...new Set(APP_PRESETS.flatMap(p => p.exeNames || []))];
  const fast = typeof winHelper.queryRunningProcessPathSync === 'function'
    ? winHelper.queryRunningProcessPathSync(allExes)
    : null;
  const runningByExe = fast?.byExe || null;
  return APP_PRESETS.map(p => {
    const resolved = resolveAppSpec(p.key, { runningByExe });
    return {
      key: p.key,
      displayName: p.displayName,
      aliases: p.aliases,
      installed: resolved.installed,
      exePath: resolved.exePath,
      running: Boolean(p.exeNames?.some(ex => Boolean(runningByExe?.[String(ex).toLowerCase()]))),
      layoutProfile: p.layoutProfile,
    };
  });
}

module.exports = {
  APP_PRESETS,
  resolveAppSpec,
  matchesAppSpec,
  isAuxiliaryWindow,
  matchWindowsList,
  findMatchingWindows,
  wakeOrLaunchApp,
  listKnownApps,
  isWindowMinimized,
};
