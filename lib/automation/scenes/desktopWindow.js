const { fail } = require('../errors');
const appRegistry = require('../../desktop/appRegistry');
const winHelper = require('../../desktop/winHelper');

function isCollapsedBounds(bounds, minWidth, minHeight) {
  if (!bounds || typeof bounds !== 'object') return true;
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return true;
  return bounds.width < minWidth || bounds.height < minHeight;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || fail('ABORTED', 'Wait aborted'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason || fail('ABORTED', 'Wait aborted'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function inspectWechatLoginText(desktop, windowId, bounds, options) {
  if (!desktop || typeof desktop.adOcrWindow !== 'function') return null;
  try {
    const ocr = await desktop.adOcrWindow(undefined, {
      windowId,
      region: 'full',
      includeLines: true,
      includeWords: false,
      scale: 2,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    const text = winHelper.normalizeOcrText(ocr?.text || '');
    const canon = winHelper.canonicalOcrKey(text);
    const enterMatches = typeof winHelper.findOcrMatches === 'function'
      ? winHelper.findOcrMatches(ocr, '进入微信', bounds)
      : [];
    const hasEnterText = canon.includes('进入微信') || enterMatches.length > 0;
    const needsPhoneConfirm = /请在手机上确认|手机上确认|确认登录|扫一扫|扫码登录|二维码|登录已过期/i.test(text)
      || canon.includes('请在手机上确认')
      || canon.includes('扫码登录');
    return {
      text,
      hasEnterText,
      needsPhoneConfirm,
      enterPoint: enterMatches[0]?.screen?.center || null,
    };
  } catch {
    return null;
  }
}

async function tryEnterWechatLoginDialog(desktop, capabilities, appSpec, minWidth, minHeight, options, callBase, actions) {
  const b = capabilities.bounds;
  const loginSpec = appSpec?.loginWindow;
  if (!b || !loginSpec || b.width < loginSpec.minWidth || b.height < loginSpec.minHeight || b.width > loginSpec.maxWidth || (loginSpec.maxHeight && b.height > loginSpec.maxHeight)) {
    return null;
  }
  const pol = typeof desktop?.adPolicy === 'function' ? desktop.adPolicy() : null;
  if (pol && (pol.readOnly || pol.mode !== 'exclusive')) {
    return null;
  }
  if (options.autoEnterLogin === false) {
    return null;
  }

  let hasEnterBtn = (capabilities.buttonRefs || []).some(btn => String(btn?.name || '').trim() === '进入微信');
  if (!hasEnterBtn && typeof desktop.adFind === 'function') {
    try {
      const found = await desktop.adFind(undefined, {
        ...callBase,
        windowId: capabilities.windowId,
        role: 'button',
        name: '进入微信',
        first: true,
      });
      hasEnterBtn = Boolean(found?.match?.ref_id || found?.ref_id);
    } catch {}
  }

  let ocrEnterPoint = null;
  if (!hasEnterBtn) {
    const loginOcr = await inspectWechatLoginText(desktop, capabilities.windowId, capabilities.bounds, options);
    if (loginOcr?.hasEnterText) {
      hasEnterBtn = true;
      ocrEnterPoint = loginOcr.enterPoint;
    } else if (loginOcr?.needsPhoneConfirm) {
      throw fail(
        'WECHAT_LOGIN_REQUIRED',
        'WeChat login window requires QR scan or mobile phone confirmation before messaging can proceed',
        { delivery: 'not_delivered', retry: 'safe' },
      );
    }
  }

  if (!hasEnterBtn) {
    throw fail(
      'WECHAT_LOGIN_REQUIRED',
      'WeChat login window requires QR scan or phone confirmation ("进入微信" button not present)',
      { delivery: 'not_delivered', retry: 'safe' },
    );
  }

  if (process.platform === 'win32' && /^w-\d+$/.test(String(capabilities.windowId || ''))) {
    await winHelper.assistForegroundWindow(
      capabilities.windowId,
      capabilities.window?.pid || 0,
      { signal: options.signal, timeoutMs: options.timeoutMs },
    ).catch(() => null);
  }
  if (!capabilities.isFocused && typeof desktop.adFocusWindow === 'function') {
    await desktop.adFocusWindow(undefined, { ...callBase, windowId: capabilities.windowId }).catch(() => {});
  }
  await desktop.adPress('return', { ...callBase, windowId: capabilities.windowId });

  const waitBudgetMs = Math.min(15000, Number.isInteger(options.launchTimeoutMs) && options.launchTimeoutMs > 0 ? options.launchTimeoutMs : 15000);
  const startedAt = Date.now();
  const deadline = startedAt + waitBudgetMs;
  let clickedFallback = false;
  let checkedMidOcr = false;

  while (Date.now() < deadline) {
    await sleep(350, options.signal);
    if (typeof desktop.adListWindows !== 'function') break;
    const found = await appRegistry.findMatchingWindows(desktop, 'wechat', {
      minWidth,
      minHeight,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    const mainWin = found.windows.find(w => !appRegistry.isWindowMinimized(w) && !isCollapsedBounds(w.bounds, minWidth, minHeight));
    if (mainWin) {
      actions.push('enter_login');
      return desktop.adInspectCapabilities(undefined, { ...callBase, windowId: mainWin.id });
    }
    const elapsed = Date.now() - startedAt;
    if (!clickedFallback && elapsed >= 1800 && typeof desktop.adMouseClick === 'function') {
      const loginNow = found.windows.find(w => w.id === capabilities.windowId);
      if (
        loginNow?.bounds
        && loginNow.bounds.width >= loginSpec.minWidth
        && loginNow.bounds.height >= loginSpec.minHeight
        && loginNow.bounds.width <= loginSpec.maxWidth
        && (!loginSpec.maxHeight || loginNow.bounds.height <= loginSpec.maxHeight)
      ) {
        let enterStillVisible = false;
        if (typeof desktop.adFind === 'function') {
          try {
            const recheck = await desktop.adFind(undefined, {
              ...callBase,
              windowId: loginNow.id,
              role: 'button',
              name: '进入微信',
              first: true,
            });
            enterStillVisible = Boolean(recheck?.match?.ref_id || recheck?.ref_id);
          } catch {}
        }
        if (!enterStillVisible) {
          const midOcr = await inspectWechatLoginText(desktop, loginNow.id, loginNow.bounds, options);
          if (midOcr?.hasEnterText) {
            enterStillVisible = true;
            ocrEnterPoint = midOcr.enterPoint || ocrEnterPoint;
          } else if (midOcr?.needsPhoneConfirm) {
            throw fail(
              'WECHAT_LOGIN_REQUIRED',
              'WeChat login dialog is waiting for mobile phone confirmation or QR scan',
              { delivery: 'not_delivered', retry: 'safe' },
            );
          }
        }
        if (enterStillVisible) {
          if (process.platform === 'win32' && /^w-\d+$/.test(String(loginNow.id || ''))) {
            await winHelper.assistForegroundWindow(
              loginNow.id,
              loginNow.pid || 0,
              { signal: options.signal, timeoutMs: options.timeoutMs },
            ).catch(() => null);
          }
          if (typeof desktop.adFocusWindow === 'function') {
            await desktop.adFocusWindow(undefined, { ...callBase, windowId: loginNow.id }).catch(() => {});
          }
          const clickX = ocrEnterPoint?.x ?? Math.round(loginNow.bounds.x + loginNow.bounds.width * 0.5);
          const clickY = ocrEnterPoint?.y ?? Math.round(loginNow.bounds.y + loginNow.bounds.height * 0.76);
          await desktop.adMouseClick(clickX, clickY, { ...callBase, windowId: loginNow.id }).catch(() => {});
        }
        clickedFallback = true;
      }
    } else if (clickedFallback && !checkedMidOcr && elapsed >= 4500) {
      checkedMidOcr = true;
      const loginNow = found.windows.find(w => w.id === capabilities.windowId);
      if (loginNow?.bounds) {
        const postOcr = await inspectWechatLoginText(desktop, loginNow.id, loginNow.bounds, options);
        if (postOcr?.needsPhoneConfirm && !postOcr.hasEnterText) {
          throw fail(
            'WECHAT_LOGIN_REQUIRED',
            'WeChat login dialog submitted, now waiting for confirmation on mobile phone',
            { delivery: 'not_delivered', retry: 'safe' },
          );
        }
      }
    }
  }

  throw fail(
    'WECHAT_LOGIN_TIMEOUT',
    `Submitted WeChat login dialog, but no main window (>= ${minWidth}x${minHeight}) opened within ${waitBudgetMs}ms`,
    { delivery: 'not_delivered', retry: 'safe' },
  );
}

async function ensureWindowReady(desktop, target = {}, options = {}) {
  if (!desktop || typeof desktop.adInspectCapabilities !== 'function') {
    throw fail('INVALID_ARGS', 'ensureWindowReady requires a desktop client instance');
  }
  const hasTitle = typeof target?.titleIncludes === 'string' && target.titleIncludes.trim().length > 0;
  if (!target || typeof target !== 'object' || Array.isArray(target) || (!target.app && !target.windowId && !hasTitle && !target.exePath)) {
    throw fail('INVALID_ARGS', 'ensureWindowReady requires target.app, target.windowId, target.titleIncludes, or target.exePath');
  }
  const focus = options.focus ?? 'auto';
  const restoreIfMinimized = options.restoreIfMinimized ?? true;
  const launchIfMissing = Boolean(options.launchIfMissing);
  const appSpec = (target.app || target.exePath || options.exePath)
    ? appRegistry.resolveAppSpec(target.app || '', { exePath: target.exePath || options.exePath })
    : null;
  const defaultMinW = appSpec?.minMainWindow?.width || 120;
  const defaultMinH = appSpec?.minMainWindow?.height || 80;
  const minWidth = Number.isFinite(options.minWidth) && options.minWidth > 0 ? options.minWidth : defaultMinW;
  const minHeight = Number.isFinite(options.minHeight) && options.minHeight > 0 ? options.minHeight : defaultMinH;
  if ((focus !== 'auto' && typeof focus !== 'boolean') || typeof restoreIfMinimized !== 'boolean') {
    throw fail('INVALID_ARGS', 'ensureWindowReady focus must be boolean or "auto", and restoreIfMinimized must be boolean');
  }

  const callBase = {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    nativeTimeoutMs: options.nativeTimeoutMs,
  };
  const actions = [];
  let capabilities;
  const preferMainTarget = Boolean(launchIfMissing && !target.windowId && !target.titleIncludes && appSpec);
  try {
    capabilities = await desktop.adInspectCapabilities(target.app, {
      ...callBase,
      windowId: target.windowId,
      titleIncludes: target.titleIncludes,
      preferFocused: target.preferFocused ?? true,
    });
    if (
      preferMainTarget
      && capabilities?.window
      && typeof appRegistry.isAuxiliaryWindow === 'function'
      && appRegistry.isAuxiliaryWindow(capabilities.window, appSpec)
    ) {
      const woken = await appRegistry.wakeOrLaunchApp(desktop, target.app, {
        exePath: target.exePath || options.exePath,
        titleIncludes: target.titleIncludes,
        launchArgs: options.launchArgs,
        launchTimeoutMs: options.launchTimeoutMs,
        minWidth,
        minHeight,
        preferMainWindow: true,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      if (woken.launched) actions.push('launch');
      else if (woken.wokenBy) actions.push(woken.wokenBy);
      capabilities = await desktop.adInspectCapabilities(undefined, {
        ...callBase,
        windowId: woken.window.id,
      });
    }
  } catch (err) {
    if (!launchIfMissing || err?.code !== 'WINDOW_NOT_FOUND') throw err;
    const woken = await appRegistry.wakeOrLaunchApp(desktop, target.app, {
      exePath: target.exePath || options.exePath,
      titleIncludes: target.titleIncludes,
      launchArgs: options.launchArgs,
      launchTimeoutMs: options.launchTimeoutMs,
      minWidth,
      minHeight,
      preferMainWindow: preferMainTarget,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    if (woken.launched) actions.push('launch');
    else if (woken.wokenBy) actions.push(woken.wokenBy);
    capabilities = await desktop.adInspectCapabilities(undefined, {
      ...callBase,
      windowId: woken.window.id,
    });
  }

  if (capabilities.minimized) {
    if (!restoreIfMinimized) {
      throw fail(
        'DESKTOP_WINDOW_MINIMIZED',
        'Target window is minimized; enable restoreIfMinimized in an exclusive writable task',
        { delivery: 'not_delivered', retry: 'safe' },
      );
    }
    await desktop.adRestoreWindow(undefined, { ...callBase, windowId: capabilities.windowId });
    actions.push('restore');
    capabilities = await desktop.adInspectCapabilities(undefined, {
      ...callBase,
      windowId: capabilities.windowId,
    });
  }

  if (appSpec?.key === 'wechat' && isCollapsedBounds(capabilities.bounds, minWidth, minHeight)) {
    const enteredCaps = await tryEnterWechatLoginDialog(
      desktop,
      capabilities,
      appSpec,
      minWidth,
      minHeight,
      options,
      callBase,
      actions,
    );
    if (enteredCaps) {
      capabilities = enteredCaps;
    }
  }

  const shouldFocus = focus === true || (focus === 'auto' && capabilities.mode === 'custom_ui_visual');
  if (shouldFocus) {
    const pol = typeof desktop?.adPolicy === 'function' ? desktop.adPolicy() : null;
    if (pol) {
      if (pol.readOnly) {
        throw fail('READ_ONLY_BLOCKED', 'Desktop mutations require readOnly:false', { delivery: 'not_delivered', retry: 'safe' });
      }
      if (pol.mode !== 'exclusive') {
        throw fail('DESKTOP_FOREGROUND_REQUIRED', 'Focusing a desktop window requires exclusive mode', { delivery: 'not_delivered', retry: 'safe' });
      }
    }
    let assistInfo = null;
    if (process.platform === 'win32' && /^w-\d+$/.test(String(capabilities.windowId || ''))) {
      assistInfo = await winHelper.assistForegroundWindow(
        capabilities.windowId,
        capabilities.window?.pid || 0,
        { signal: options.signal, timeoutMs: options.timeoutMs },
      ).catch(() => null);
      if (assistInfo?.clampedToWorkArea) actions.push('move_onscreen');
    }
    if (!capabilities.isFocused) {
      try {
        await desktop.adFocusWindow(undefined, { ...callBase, windowId: capabilities.windowId });
      } catch (focusErr) {
        if (focusErr?.code === 'ACTION_FAILED' && assistInfo && assistInfo.isInteractiveDefaultDesktop === false) {
          const sandboxErr = fail(
            'DESKTOP_SANDBOX_ISOLATED',
            `Physical Win32 foreground focus and SendInput are unavailable in non-input desktop "${assistInfo.threadDesktop}"; run headed desktop commands from an interactive WinSta0\\Default session`,
            { delivery: 'not_delivered', retry: 'safe' },
          );
          sandboxErr.details = { threadDesktop: assistInfo.threadDesktop, windowId: capabilities.windowId };
          throw sandboxErr;
        }
        throw focusErr;
      }
      actions.push('focus');
    }
    if (!capabilities.isFocused || assistInfo?.clampedToWorkArea) {
      let windows = await desktop.adListWindows(target.app, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      let refreshed = (Array.isArray(windows) ? windows : []).find(w => w.id === capabilities.windowId);
      if (!refreshed && target.app) {
        windows = await desktop.adListWindows(undefined, {
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        });
        refreshed = (Array.isArray(windows) ? windows : []).find(w => w.id === capabilities.windowId);
      }
      if (refreshed && !refreshed.is_focused && shouldFocus) {
        if (process.platform === 'win32' && /^w-\d+$/.test(String(capabilities.windowId || ''))) {
          await winHelper.assistForegroundWindow(
            capabilities.windowId,
            refreshed.pid || capabilities.window?.pid || 0,
            { signal: options.signal, timeoutMs: options.timeoutMs },
          ).catch(() => null);
        }
        await desktop.adFocusWindow(undefined, { ...callBase, windowId: capabilities.windowId }).catch(() => {});
        const retryList = await desktop.adListWindows(undefined, { signal: options.signal, timeoutMs: options.timeoutMs }).catch(() => null);
        const retryWin = (Array.isArray(retryList) ? retryList : []).find(w => w.id === capabilities.windowId);
        if (retryWin) refreshed = retryWin;
      }
      if (!refreshed) {
        throw fail('WINDOW_NOT_FOUND', 'Target window disappeared after focus request', { delivery: 'not_delivered', retry: 'safe' });
      }
      capabilities = {
        ...capabilities,
        window: refreshed,
        isFocused: Boolean(refreshed.is_focused),
        bounds: refreshed.bounds || capabilities.bounds,
        minimized: Boolean(refreshed.minimized || refreshed.is_minimized),
      };
    }
  }

  if (capabilities.minimized) {
    throw fail('DESKTOP_WINDOW_MINIMIZED', 'Target window remained minimized after restore', { delivery: 'not_delivered', retry: 'safe' });
  }
  if (isCollapsedBounds(capabilities.bounds, minWidth, minHeight)) {
    throw fail(
      'DESKTOP_WINDOW_BOUNDS_INVALID',
      `Target window bounds are collapsed or smaller than ${minWidth}x${minHeight}`,
      { delivery: 'not_delivered', retry: 'safe' },
    );
  }
  if (shouldFocus && !capabilities.isFocused) {
    throw fail('DESKTOP_WINDOW_NOT_FOCUSED', 'Target window could not be verified as focused', { delivery: 'not_delivered', retry: 'safe' });
  }

  return {
    ...capabilities,
    ...(appSpec ? { appProfile: { key: appSpec.key, displayName: appSpec.displayName, layoutProfile: appSpec.layoutProfile } } : {}),
    ready: true,
    actions,
  };
}

module.exports = { ensureWindowReady };
