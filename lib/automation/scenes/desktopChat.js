const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fail } = require('../errors');
const appRegistry = require('../../desktop/appRegistry');
const winHelper = require('../../desktop/winHelper');
const { ensureWindowReady } = require('./desktopWindow');

function buildSceneError(code, message, disposition, details) {
  const err = fail(code, message, disposition);
  if (details) err.details = details;
  return err;
}

function sleepInProcess(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(fail('ABORTED', 'Desktop chat operation aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(fail('ABORTED', 'Desktop chat operation aborted'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sha256File(filePath) {
  const bytes = fs.readFileSync(filePath);
  return { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

async function prepareChatItems(rawItems, tempDir, options = {}) {
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 24) {
    throw fail('INVALID_ARGS', 'Chat delivery requires 1 to 24 items');
  }
  const normalized = [];
  for (let i = 0; i < rawItems.length; i += 1) {
    const raw = rawItems[i];
    if (typeof raw === 'string') {
      if (!raw.trim() || raw.includes('\0')) {
        throw fail('INVALID_ARGS', `Chat text item at index ${i} must be a non-empty string without NUL bytes`);
      }
      if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) {
        throw fail('INVALID_ARGS', `Chat text item at index ${i} exceeds 64 KiB`);
      }
      normalized.push({ index: i, kind: 'text', text: raw });
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw fail('INVALID_ARGS', `Chat item at index ${i} must be a string or object`);
    }
    const type = String(raw.type || (raw.text !== undefined ? 'text' : '')).trim().toLowerCase();
    if (type === 'text') {
      const txt = raw.text ?? raw.value;
      if (typeof txt !== 'string' || !txt.trim() || txt.includes('\0')) {
        throw fail('INVALID_ARGS', `Chat text item at index ${i} requires a non-empty text string`);
      }
      if (Buffer.byteLength(txt, 'utf8') > 64 * 1024) {
        throw fail('INVALID_ARGS', `Chat text item at index ${i} exceeds 64 KiB`);
      }
      normalized.push({ index: i, kind: 'text', text: txt });
      continue;
    }
    if (['image', 'sticker', 'emoji', 'gif', 'file'].includes(type)) {
      const rawPath = raw.path ?? raw.file ?? raw.image;
      if (typeof rawPath !== 'string' || !rawPath.trim()) {
        throw fail('INVALID_ARGS', `Chat ${type} item at index ${i} requires a file path`);
      }
      const absPath = path.resolve(rawPath.trim());
      let stat;
      try {
        stat = fs.statSync(absPath);
      } catch {
        throw fail('INVALID_ARGS', `Chat ${type} file at index ${i} does not exist on disk`);
      }
      if (!stat.isFile() || stat.size <= 0) {
        throw fail('INVALID_ARGS', `Chat ${type} file at index ${i} must be a non-empty regular file`);
      }
      const ext = path.extname(absPath).toLowerCase();
      const useFileDrop = type === 'file'
        || type === 'gif'
        || Boolean(raw.asFile)
        || (['sticker', 'emoji'].includes(type) && !['.png', '.jpg', '.jpeg', '.bmp'].includes(ext))
        || (['sticker', 'emoji'].includes(type) && ext === '.gif');

      if (useFileDrop) {
        normalized.push({
          index: i,
          kind: ['sticker', 'emoji', 'gif'].includes(type) ? 'sticker' : 'file',
          clipboardMode: 'file_url',
          filePath: absPath,
          fileName: path.basename(absPath),
        });
      } else {
        const ensured = await winHelper.ensurePngImageFile(absPath, tempDir, options);
        normalized.push({
          index: i,
          kind: ['sticker', 'emoji'].includes(type) ? 'sticker' : 'image',
          clipboardMode: 'image_png',
          pngPath: ensured.pngPath,
          converted: ensured.converted,
          fileName: path.basename(absPath),
        });
      }
      continue;
    }
    throw fail('INVALID_ARGS', `Unsupported chat item type "${raw.type}" at index ${i} (use text|image|sticker|file)`);
  }
  return normalized;
}

function resolveComposerPoint(spec, bounds, appSpec) {
  if (spec.composerPoint && typeof spec.composerPoint === 'object') {
    const { x, y } = spec.composerPoint;
    if (![x, y].every(Number.isFinite)) throw fail('INVALID_ARGS', 'composerPoint requires finite x and y');
    return { x: Math.round(x), y: Math.round(y) };
  }
  const ratio = spec.composerRatio || appSpec?.defaultComposerRatio || { xRatio: 0.62, yRatio: 0.84 };
  const xRatio = ratio.xRatio ?? ratio.x;
  const yRatio = ratio.yRatio ?? ratio.y;
  if (![xRatio, yRatio].every(Number.isFinite) || xRatio <= 0.02 || xRatio >= 0.98 || yRatio <= 0.02 || yRatio >= 0.98) {
    throw fail('INVALID_ARGS', 'composerRatio requires xRatio and yRatio between 0.02 and 0.98');
  }
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    throw fail('DESKTOP_WINDOW_BOUNDS_INVALID', 'Valid window bounds are required to compute composer click coordinates');
  }
  return {
    x: Math.round(bounds.x + bounds.width * xRatio),
    y: Math.round(bounds.y + bounds.height * yRatio),
  };
}

function isStrictHeaderLineMatch(lineText, sessionName) {
  const rawLines = String(lineText || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (rawLines.length > 1) {
    return rawLines.some(part => isStrictHeaderLineMatch(part, sessionName));
  }
  const normLine = winHelper.normalizeOcrText(rawLines[0] || lineText || '');
  const normNeedle = winHelper.normalizeOcrText(sessionName || '');
  const needleCompact = winHelper.compactSearchKey(normNeedle);
  const needleCanon = winHelper.canonicalOcrKey(normNeedle);
  if (!needleCompact) return false;
  if (normLine === normNeedle) return true;
  if (normLine.startsWith(normNeedle)) {
    const nextCh = normLine[normNeedle.length];
    if (!nextCh || /[\s(（\[【\-—|·•:：@0-9]/.test(nextCh)) return true;
  }
  const stem = normLine.replace(/\s*[(（\[【]\s*\d+\s*[)）\]】]\s*$/, '').trim();
  const stemCompact = winHelper.compactSearchKey(stem);
  const stemCanon = winHelper.canonicalOcrKey(stem);
  if (stemCompact === needleCompact || (needleCanon && stemCanon === needleCanon)) return true;
  if (needleCanon && stemCanon.startsWith(needleCanon)) {
    const nextCh = stemCanon[needleCanon.length];
    if (!nextCh || /[(\[【\-—|·•:：@0-9]/.test(nextCh)) return true;
  }
  const cmpLen = (needleCanon || needleCompact).length;
  const maxDist = cmpLen >= 4 && cmpLen <= 8 ? 1 : 0;
  if (
    maxDist > 0
    && stemCanon.length === needleCanon.length
    && stemCanon[0] === needleCanon[0]
    && winHelper.levenshteinDistance(stemCanon, needleCanon) <= maxDist
  ) {
    return true;
  }
  return false;
}

async function checkHeaderSession(shotPath, sessionName, bounds, spec, options, overrideHeaderRegion) {
  const ocr = await winHelper.ocrImage(shotPath, {
    region: spec.headerRegion || overrideHeaderRegion || 'header',
    find: sessionName,
    scale: spec.ocrScale ?? 2,
    bounds,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  const strictHit = (ocr.matches || []).find(m => isStrictHeaderLineMatch(m.lineText || m.matchedText || '', sessionName)) || null;
  return {
    matched: Boolean(strictHit),
    match: strictHit,
    headerText: ocr.text || '',
  };
}

async function tryDetectLayoutSafe(shotPath, options) {
  if (process.platform !== 'win32' || typeof winHelper.detectChatLayout !== 'function' || !fs.existsSync(shotPath)) {
    return null;
  }
  try {
    const layout = await winHelper.detectChatLayout(shotPath, { signal: options.signal, timeoutMs: options.timeoutMs });
    return layout?.detected ? layout : null;
  } catch {
    return null;
  }
}

async function clickPointInChat(desktop, windowId, x, y, waitMs, shotPath, cursorCallOpts, options) {
  if (typeof desktop.adMouseClick === 'function') {
    const clickOpts = {
      windowId,
      ...cursorCallOpts,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    };
    try {
      await desktop.adMouseClick(x, y, clickOpts);
    } catch (err) {
      if (err?.code !== 'DESKTOP_TARGET_UNVERIFIED') throw err;
      if (process.platform === 'win32' && /^w-\d+$/.test(String(windowId || ''))) {
        await winHelper.assistForegroundWindow(windowId, 0, {
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        }).catch(() => null);
      }
      if (typeof desktop.adFocusWindow === 'function') {
        await desktop.adFocusWindow(undefined, {
          windowId,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        }).catch(() => {});
      }
      await desktop.adMouseClick(x, y, clickOpts);
    }
    if (!shotPath) {
      await sleepInProcess(waitMs, options.signal);
      return { ok: true, results: [] };
    }
    const followSteps = [
      ...(waitMs > 0 ? [{ command: 'wait', ms: waitMs }] : []),
      { command: 'screenshot', windowId, outputPath: shotPath },
    ];
    return desktop.adBatch(followSteps, {
      windowId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }
  const steps = [
    { command: 'mouse-click', x, y, windowId },
    ...(waitMs > 0 ? [{ command: 'wait', ms: waitMs }] : []),
    ...(shotPath ? [{ command: 'screenshot', windowId, outputPath: shotPath }] : []),
  ];
  return desktop.adBatch(steps, {
    windowId,
    ...cursorCallOpts,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

async function navigateAndVerifySession(desktop, readyWindow, sessionName, appSpec, spec, tempDir, options) {
  const windowId = readyWindow.windowId;
  const bounds = readyWindow.bounds;
  const cursorCallOpts = {
    ...(spec.restoreCursor !== undefined ? { restoreCursor: spec.restoreCursor } : {}),
    ...(spec.ripple !== undefined ? { ripple: spec.ripple } : {}),
    ...(spec.clickMode !== undefined ? { clickMode: spec.clickMode } : {}),
    ...(spec.humanGuardMs !== undefined ? { humanGuardMs: spec.humanGuardMs } : {}),
  };
  const shot0 = path.join(tempDir, 'session-initial.png');
  await desktop.adScreenshot(undefined, shot0, { windowId, signal: options.signal, timeoutMs: options.timeoutMs });

  let layout = spec.autoDetectLayout === false ? null : await tryDetectLayoutSafe(shot0, options);
  const sidebarRegion = () => spec.sidebarRegion || layout?.regions?.sidebar || 'sidebar';
  const headerRegion = () => spec.headerRegion || layout?.regions?.header || 'header';

  const initialHeader = await checkHeaderSession(shot0, sessionName, bounds, spec, options, headerRegion());
  if (initialHeader.matched) {
    if (spec.navigateOnly === true) {
      const navOutShot = spec.navOutShot || path.join(os.tmpdir(), `abb-chat-nav-${process.pid}-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(navOutShot), { recursive: true });
      fs.copyFileSync(shot0, navOutShot);
      return {
        navigateOnly: true,
        verified: false,
        requiresVisualCheck: true,
        navigationMethod: 'already_active',
        afterShotPath: navOutShot,
        headerText: initialHeader.headerText,
        headerOcrText: initialHeader.headerText,
        headerOcrMatched: true,
        detectedLayout: layout,
      };
    }
    return {
      verified: true,
      navigationMethod: 'already_active',
      headerText: initialHeader.headerText,
      headerMatch: initialHeader.match,
      detectedLayout: layout,
    };
  }

  let observedAfterSearchText = null;
  let ranSearch = false;
  let currentShot = shot0;
  let lastSidebarLineCount = -1;
  let lastSidebarText = '';
  let recoveredChatTab = false;

  const isLikelyNonChatOrVeiledView = (headerText, sidebarLineCount, sidebarText) => {
    const trimmedHeader = String(headerText || '').trim();
    const sb = String(sidebarText || '');
    if (!trimmedHeader && sidebarLineCount === 0) return true;
    if (/(?:^|\n)\s*发现\s*(?:\n|$)/.test(sb) && /(?:朋友圈|视频号|搜一搜|小程序|看一看)/.test(sb)) return true;
    if (/(?:^|\n)\s*通讯录\s*(?:\n|$)/.test(sb) && /(?:新的朋友|群聊|公众号|企业微信联系人)/.test(sb)) return true;
    if (/(?:^|\n)\s*全部收藏\s*(?:\n|$)/.test(sb)) return true;
    return false;
  };

  const trySidebarVisible = async (shotPath = currentShot) => {
    const sidebarOcr = await winHelper.ocrImage(shotPath, {
      region: sidebarRegion(),
      find: sessionName,
      scale: spec.ocrScale ?? 2,
      bounds,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    lastSidebarLineCount = Array.isArray(sidebarOcr.lines) ? sidebarOcr.lines.length : 0;
    lastSidebarText = sidebarOcr.text || '';
    const minSidebarRowY = Math.min(54, Math.round(sidebarOcr.imageHeight * 0.08));
    const sidebarHit = (sidebarOcr.matches || []).find(m => m.imageRect.y >= minSidebarRowY);
    if (!sidebarHit) return null;

    const shot1 = path.join(tempDir, 'session-after-sidebar.png');
    await clickPointInChat(
      desktop,
      windowId,
      sidebarHit.screen.center.x,
      sidebarHit.screen.center.y,
      spec.navigationSettleMs ?? 200,
      shot1,
      cursorCallOpts,
      options,
    );
    if (fs.existsSync(shot1)) {
      if (spec.autoDetectLayout !== false) layout = (await tryDetectLayoutSafe(shot1, options)) || layout;
      const afterSideHeader = await checkHeaderSession(shot1, sessionName, bounds, spec, options, headerRegion());
      if (afterSideHeader.matched) {
        return {
          verified: true,
          navigationMethod: 'sidebar_click',
          clickedPoint: sidebarHit.screen.center,
          headerText: afterSideHeader.headerText,
          headerMatch: afterSideHeader.match,
          detectedLayout: layout,
        };
      }
      observedAfterSearchText = afterSideHeader.headerText;
    }
    return null;
  };

  const tryRecoverChatTabView = async () => {
    if (recoveredChatTab || spec.navigationMode === 'keyboard_first' || spec.recoverChatTab === false) {
      return null;
    }
    const railOffset = spec.chatTabRailOffset || appSpec?.chatTabRailOffset || null;
    if (
      !railOffset
      || !bounds
      || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      || typeof desktop.adMouseClick !== 'function'
    ) {
      return null;
    }
    recoveredChatTab = true;
    const railX = bounds.x + Math.min(Math.max(16, Math.round(railOffset.x)), Math.max(16, Math.round(bounds.width * 0.12)));
    const railY = bounds.y + Math.min(Math.max(48, Math.round(railOffset.y)), Math.max(48, Math.round(bounds.height * 0.45)));

    // First click outside centered overlays dismisses lightbox veils without Escape-to-tray risk; second activates left-rail Chats tab.
    await clickPointInChat(desktop, windowId, railX, railY, 180, null, cursorCallOpts, options);
    const shotRail1 = path.join(tempDir, 'session-after-rail-recover.png');
    await clickPointInChat(
      desktop,
      windowId,
      railX,
      railY,
      spec.navigationSettleMs ?? 260,
      shotRail1,
      cursorCallOpts,
      options,
    );

    if (fs.existsSync(shotRail1)) {
      currentShot = shotRail1;
      if (spec.autoDetectLayout !== false) {
        layout = await tryDetectLayoutSafe(shotRail1, options);
      }
      const railHeader1 = await checkHeaderSession(shotRail1, sessionName, bounds, spec, options, headerRegion());
      if (railHeader1.matched) {
        return {
          verified: true,
          navigationMethod: 'chat_tab_recover',
          clickedPoint: { x: railX, y: railY },
          headerText: railHeader1.headerText,
          headerMatch: railHeader1.match,
          detectedLayout: layout,
        };
      }
      observedAfterSearchText = railHeader1.headerText;
      const sideAfterRail1 = await trySidebarVisible(shotRail1);
      if (sideAfterRail1) return sideAfterRail1;

      if (!String(railHeader1.headerText || '').trim() && lastSidebarLineCount === 0) {
        const fullProbe = await winHelper.ocrImage(shotRail1, {
          region: 'full',
          scale: 1,
          bounds,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        }).catch(() => null);
        const shotRail2 = path.join(tempDir, 'session-after-modal-recover.png');
        if ((fullProbe?.lines || []).length > 0) {
          // Pure keyboard batch (no coordinate step) closes centered modal veil that ignores outside clicks.
          await desktop.adBatch(
            [
              { command: 'press', combo: 'escape', windowId },
              { command: 'wait', ms: 220 },
            ],
            { windowId, ...cursorCallOpts, signal: options.signal, timeoutMs: options.timeoutMs },
          ).catch(() => {});
          await clickPointInChat(
            desktop,
            windowId,
            railX,
            railY,
            spec.navigationSettleMs ?? 260,
            shotRail2,
            cursorCallOpts,
            options,
          );
        } else {
          // Window still painting (0 lines anywhere): never send Escape; wait and click left-rail Chats icon safely.
          await sleepInProcess(550, options.signal);
          await clickPointInChat(
            desktop,
            windowId,
            railX,
            railY,
            spec.navigationSettleMs ?? 260,
            shotRail2,
            cursorCallOpts,
            options,
          );
        }

        if (fs.existsSync(shotRail2)) {
          currentShot = shotRail2;
          if (spec.autoDetectLayout !== false) {
            layout = await tryDetectLayoutSafe(shotRail2, options);
          }
          const railHeader2 = await checkHeaderSession(shotRail2, sessionName, bounds, spec, options, headerRegion());
          if (railHeader2.matched) {
            return {
              verified: true,
              navigationMethod: 'chat_tab_recover',
              clickedPoint: { x: railX, y: railY },
              headerText: railHeader2.headerText,
              headerMatch: railHeader2.match,
              detectedLayout: layout,
            };
          }
          observedAfterSearchText = railHeader2.headerText;
          const sideAfterRail2 = await trySidebarVisible(shotRail2);
          if (sideAfterRail2) return sideAfterRail2;
        }
      }
    }
    return null;
  };

  const tryKeyboardSearch = async () => {
    if (spec.allowSearch === false) return null;
    ranSearch = true;
    const searchShortcut = spec.searchShortcut || appSpec?.searchShortcut || 'ctrl+f';
    const searchShot = path.join(tempDir, 'session-search-results.png');
    // Never send Escape on Windows WeChat/QQ here: when no popup is open, Esc hides the main window to system tray.
    const searchSteps = [
      { command: 'press', combo: searchShortcut, windowId },
      { command: 'wait', ms: 180 },
      { command: 'clipboard-set', text: sessionName },
      { command: 'press', combo: 'ctrl+v', windowId },
      { command: 'wait', ms: spec.searchWaitMs ?? 400 },
      { command: 'screenshot', windowId, outputPath: searchShot },
      { command: 'clipboard-clear' },
    ];
    let searchBatchRes;
    try {
      searchBatchRes = await desktop.adBatch(
        searchSteps,
        { windowId, signal: options.signal, timeoutMs: options.timeoutMs },
      );
    } catch (err) {
      await desktop.adClipboardClear({ signal: options.signal }).catch(() => {});
      throw err;
    }
    const searchEntries = Array.isArray(searchBatchRes?.results) ? searchBatchRes.results : [];
    if (!searchEntries[searchSteps.length - 1]?.ok) {
      await desktop.adClipboardClear({ signal: options.signal }).catch(() => {});
    }

    if (fs.existsSync(searchShot)) {
      const searchOcrRegion = spec.sidebarRegion || layout?.regions?.sidebar || '0,0,0.52,0.88';
      const dropdownOcr = await winHelper.ocrImage(searchShot, {
        region: searchOcrRegion,
        find: sessionName,
        scale: spec.ocrScale ?? 2,
        bounds,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      const resultRowMinY = Math.min(76, Math.round(dropdownOcr.imageHeight * 0.11));
      const dropdownHit = (dropdownOcr.matches || []).find(m => m.imageRect.y >= resultRowMinY) || null;

      const tryClickDropdownHit = async (hit, outShot) => {
        await clickPointInChat(
          desktop,
          windowId,
          hit.screen.center.x,
          hit.screen.center.y,
          spec.navigationSettleMs ?? 240,
          outShot,
          cursorCallOpts,
          options,
        );
        if (!fs.existsSync(outShot)) return null;
        if (spec.autoDetectLayout !== false) layout = (await tryDetectLayoutSafe(outShot, options)) || layout;
        const afterHitHeader = await checkHeaderSession(outShot, sessionName, bounds, spec, options, headerRegion());
        if (afterHitHeader.matched) {
          return {
            verified: true,
            navigationMethod: 'search_dropdown_click',
            clickedPoint: hit.screen.center,
            headerText: afterHitHeader.headerText,
            headerMatch: afterHitHeader.match,
            detectedLayout: layout,
          };
        }
        observedAfterSearchText = afterHitHeader.headerText;
        return null;
      };

      const tryPressSearchEnter = async (outShot) => {
        await desktop.adBatch(
          [
            { command: 'press', combo: 'return', windowId },
            { command: 'wait', ms: spec.navigationSettleMs ?? 260 },
            { command: 'screenshot', windowId, outputPath: outShot },
          ],
          { windowId, ...cursorCallOpts, signal: options.signal, timeoutMs: options.timeoutMs },
        );
        if (!fs.existsSync(outShot)) return null;
        if (spec.autoDetectLayout !== false) layout = (await tryDetectLayoutSafe(outShot, options)) || layout;
        const afterEnterHeader = await checkHeaderSession(outShot, sessionName, bounds, spec, options, headerRegion());
        if (afterEnterHeader.matched) {
          return {
            verified: true,
            navigationMethod: 'search_enter',
            headerText: afterEnterHeader.headerText,
            headerMatch: afterEnterHeader.match,
            detectedLayout: layout,
          };
        }
        observedAfterSearchText = afterEnterHeader.headerText;
        return null;
      };

      const shot2 = path.join(tempDir, 'session-after-search.png');
      if (spec.navigationMode === 'keyboard_first') {
        const enterRes = await tryPressSearchEnter(shot2);
        if (enterRes) return enterRes;
      } else {
        if (dropdownHit) {
          const hitRes = await tryClickDropdownHit(dropdownHit, shot2);
          if (hitRes) return hitRes;
        }
        const shot2Enter = dropdownHit ? path.join(tempDir, 'session-after-search-enter.png') : shot2;
        const enterRes = await tryPressSearchEnter(shot2Enter);
        if (enterRes) return enterRes;
      }
    }
    return null;
  };

  const trySidebarScroll = async () => {
    const maxScrollPages = Number.isInteger(spec.sidebarScrollPages)
      ? Math.max(0, Math.min(12, spec.sidebarScrollPages))
      : 3;
    if (!(maxScrollPages > 0 && bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite))) {
      return null;
    }
    if (ranSearch && spec.navigationMode !== 'keyboard_first' && bounds) {
      const safeDismissPt = resolveComposerPoint(spec, bounds, appSpec);
      await clickPointInChat(
        desktop,
        windowId,
        safeDismissPt.x,
        safeDismissPt.y,
        50,
        null,
        cursorCallOpts,
        options,
      ).catch(() => {});
    }
    const sbRightRatio = (layout?.sidebarRightX && layout?.width)
      ? (layout.sidebarRightX / layout.width)
      : 0.30;
    const scrollX = bounds.x + Math.max(24, Math.min(bounds.width - 24, Math.round(bounds.width * Math.min(0.28, sbRightRatio * 0.62))));
    const scrollY = bounds.y + Math.max(80, Math.min(bounds.height - 40, Math.round(bounds.height * 0.55)));
    let prevSidebarHash = null;

    for (let page = 1; page <= maxScrollPages; page += 1) {
      const scrollShot = path.join(tempDir, `session-sidebar-scroll-${page}.png`);
      const scrollSteps = [
        { command: 'mouse-wheel', x: scrollX, y: scrollY, dy: spec.sidebarScrollDy ?? -5, windowId },
        { command: 'wait', ms: spec.sidebarScrollSettleMs ?? 180 },
        { command: 'screenshot', windowId, outputPath: scrollShot },
      ];
      try {
        await desktop.adBatch(scrollSteps, { windowId, signal: options.signal, timeoutMs: options.timeoutMs });
      } catch (err) {
        if (err?.code !== 'DESKTOP_TARGET_UNVERIFIED') throw err;
        if (process.platform === 'win32' && /^w-\d+$/.test(String(windowId || ''))) {
          await winHelper.assistForegroundWindow(windowId, 0, {
            signal: options.signal,
            timeoutMs: options.timeoutMs,
          }).catch(() => null);
        }
        if (typeof desktop.adFocusWindow === 'function') {
          await desktop.adFocusWindow(undefined, {
            windowId,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
          }).catch(() => {});
        }
        await desktop.adBatch(scrollSteps, { windowId, signal: options.signal, timeoutMs: options.timeoutMs });
      }
      if (!fs.existsSync(scrollShot)) break;

      if (process.platform === 'win32' && typeof winHelper.hashImageRegion === 'function') {
        try {
          const sbHash = await winHelper.hashImageRegion(scrollShot, {
            region: sidebarRegion(),
            signal: options.signal,
            timeoutMs: options.timeoutMs,
          });
          if (sbHash?.sha256 && prevSidebarHash && sbHash.sha256 === prevSidebarHash) break;
          prevSidebarHash = sbHash?.sha256 || null;
        } catch {}
      }

      const scrolledOcr = await winHelper.ocrImage(scrollShot, {
        region: sidebarRegion(),
        find: sessionName,
        scale: spec.ocrScale ?? 2,
        bounds,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      const minSidebarRowY = Math.min(54, Math.round(scrolledOcr.imageHeight * 0.08));
      const scrollHit = (scrolledOcr.matches || []).find(m => m.imageRect.y >= minSidebarRowY);
      if (scrollHit) {
        const afterScrollClickShot = path.join(tempDir, `session-after-scroll-click-${page}.png`);
        await clickPointInChat(
          desktop,
          windowId,
          scrollHit.screen.center.x,
          scrollHit.screen.center.y,
          spec.navigationSettleMs ?? 200,
          afterScrollClickShot,
          cursorCallOpts,
          options,
        );
        if (fs.existsSync(afterScrollClickShot)) {
          if (spec.autoDetectLayout !== false) layout = (await tryDetectLayoutSafe(afterScrollClickShot, options)) || layout;
          const afterScrollHeader = await checkHeaderSession(afterScrollClickShot, sessionName, bounds, spec, options, headerRegion());
          if (afterScrollHeader.matched) {
            return {
              verified: true,
              navigationMethod: 'sidebar_scroll_click',
              scrollPages: page,
              clickedPoint: scrollHit.screen.center,
              headerText: afterScrollHeader.headerText,
              headerMatch: afterScrollHeader.match,
              detectedLayout: layout,
            };
          }
          observedAfterSearchText = afterScrollHeader.headerText;
        }
      }
    }
    return null;
  };

  if (spec.navigateOnly === true) {
    const sbCheck = await winHelper.ocrImage(currentShot, {
      region: sidebarRegion(),
      scale: spec.ocrScale ?? 2,
      bounds,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    }).catch(() => ({ lines: [], text: '' }));
    lastSidebarLineCount = Array.isArray(sbCheck.lines) ? sbCheck.lines.length : 0;
    lastSidebarText = sbCheck.text || '';
    if (spec.recoverChatTab === true || isLikelyNonChatOrVeiledView(initialHeader.headerText, lastSidebarLineCount, lastSidebarText)) {
      await tryRecoverChatTabView();
    }
    const searchShortcut = (typeof spec.searchShortcut === 'string' && spec.searchShortcut.trim())
      || appSpec?.searchShortcut
      || 'ctrl+f';
    const navOutShot = spec.navOutShot || path.join(os.tmpdir(), `abb-chat-nav-${process.pid}-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(navOutShot), { recursive: true });
    const navSteps = [
      { command: 'press', combo: searchShortcut, windowId },
      { command: 'wait', ms: 180 },
      { command: 'clipboard-set', text: sessionName },
      { command: 'press', combo: 'ctrl+v', windowId },
      { command: 'wait', ms: spec.searchWaitMs ?? 420 },
      { command: 'press', combo: 'return', windowId },
      { command: 'wait', ms: spec.navigationSettleMs ?? 320 },
      { command: 'screenshot', windowId, outputPath: navOutShot },
      { command: 'clipboard-clear' },
    ];
    let navBatchRes;
    try {
      navBatchRes = await desktop.adBatch(navSteps, { windowId, signal: options.signal, timeoutMs: options.timeoutMs });
    } catch (err) {
      await desktop.adClipboardClear({ signal: options.signal }).catch(() => {});
      throw err;
    }
    const navEntries = Array.isArray(navBatchRes?.results) ? navBatchRes.results : [];
    if (!navEntries[navSteps.length - 1]?.ok) {
      await desktop.adClipboardClear({ signal: options.signal }).catch(() => {});
    }
    let headerOcrText = '';
    let headerOcrMatched = false;
    if (fs.existsSync(navOutShot)) {
      try {
        if (spec.autoDetectLayout !== false) layout = (await tryDetectLayoutSafe(navOutShot, options)) || layout;
        const h = await checkHeaderSession(navOutShot, sessionName, bounds, spec, options, headerRegion());
        headerOcrText = h.headerText || '';
        headerOcrMatched = Boolean(h.matched);
      } catch {}
    }
    return {
      navigateOnly: true,
      verified: false,
      requiresVisualCheck: true,
      navigationMethod: 'navigate_only_search',
      afterShotPath: navOutShot,
      headerText: headerOcrText,
      headerOcrText,
      headerOcrMatched,
      detectedLayout: layout,
    };
  }

  if (spec.navigationMode === 'keyboard_first') {
    const kbdHit = await tryKeyboardSearch();
    if (kbdHit) return kbdHit;
    const sideHit = await trySidebarVisible(currentShot);
    if (sideHit) return sideHit;
    const scrollHit = await trySidebarScroll();
    if (scrollHit) return scrollHit;
  } else {
    const sideHit = await trySidebarVisible(currentShot);
    if (sideHit) return sideHit;
    if (isLikelyNonChatOrVeiledView(initialHeader.headerText, lastSidebarLineCount, lastSidebarText)) {
      const recoveredHit = await tryRecoverChatTabView();
      if (recoveredHit) return recoveredHit;
    }
    const kbdHit = await tryKeyboardSearch();
    if (kbdHit) return kbdHit;
    const scrollHit = await trySidebarScroll();
    if (scrollHit) return scrollHit;
    if (!recoveredChatTab && !String(observedAfterSearchText || initialHeader.headerText || '').trim()) {
      const lateRecoverHit = await tryRecoverChatTabView();
      if (lateRecoverHit) return lateRecoverHit;
      if (recoveredChatTab) {
        const retryKbd = await tryKeyboardSearch();
        if (retryKbd) return retryKbd;
      }
    }
  }

  throw buildSceneError(
    'CHAT_TARGET_UNVERIFIED',
    observedAfterSearchText !== null
      ? `Could not verify target chat session "${sessionName}" in active chat header after sidebar/search/scroll navigation; zero items were sent`
      : `Active chat header did not match "${sessionName}"; refusing to paste or send any items`,
    { delivery: 'not_delivered', retry: 'safe' },
    {
      expectedSession: sessionName,
      observedHeaderText: observedAfterSearchText !== null ? observedAfterSearchText : initialHeader.headerText,
    },
  );
}

async function deliverChatSessionVerified(desktop, spec = {}, options = {}) {
  if (!desktop || typeof desktop.adBatch !== 'function') {
    throw fail('INVALID_ARGS', 'deliverChatSessionVerified requires a desktop client supporting adBatch');
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw fail('INVALID_ARGS', 'deliverChatSessionVerified requires a specification object');
  }
  if (spec.clickMode !== undefined && !['physical_restore', 'message'].includes(spec.clickMode)) {
    throw fail('INVALID_ARGS', 'clickMode must be physical_restore or message');
  }
  const hasTarget = Boolean(spec.app || spec.windowId || spec.titleIncludes || spec.exePath);
  if (!hasTarget) {
    throw fail('INVALID_ARGS', 'Chat delivery requires app (e.g. "wecom" / "wechat"), windowId, titleIncludes, or exePath');
  }
  const rawSession = spec.session ?? spec.sessionName ?? spec.targetSession;
  const sessionName = typeof rawSession === 'string' ? rawSession.trim() : '';
  const navigateOnly = spec.navigateOnly === true;
  if (navigateOnly && !sessionName) {
    throw fail('INVALID_ARGS', 'navigateOnly requires spec.session / spec.sessionName (e.g. "张佳乐")');
  }
  if (!sessionName && spec.allowCurrentSession !== true) {
    throw fail('INVALID_ARGS', 'Chat delivery requires spec.session / spec.sessionName (e.g. "文件传输助手") unless allowCurrentSession:true is set');
  }

  const rawItems = spec.items ?? spec.messages;
  const rawSaveAfterShot = spec.saveAfterShot ?? spec.afterShotPath;
  if (rawSaveAfterShot !== undefined && (typeof rawSaveAfterShot !== 'string' || !rawSaveAfterShot.trim())) {
    throw fail('INVALID_ARGS', 'saveAfterShot must be a non-empty file path string');
  }
  const resolvedSaveAfterShot = rawSaveAfterShot ? path.resolve(rawSaveAfterShot.trim()) : null;
  const keepShots = typeof spec.screenshotDir === 'string' && spec.screenshotDir.trim().length > 0;
  const workDir = keepShots
    ? path.resolve(spec.screenshotDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'abb-chat-send-'));
  if (keepShots) fs.mkdirSync(workDir, { recursive: true });
  const mediaTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-chat-media-'));

  const startedAt = Date.now();
  try {
    const items = navigateOnly ? [] : await prepareChatItems(rawItems, mediaTempDir, options);
    const appSpec = (spec.app || spec.exePath)
      ? appRegistry.resolveAppSpec(spec.app || '', { exePath: spec.exePath })
      : null;

    const ready = await ensureWindowReady(
      desktop,
      {
        app: spec.app,
        windowId: spec.windowId,
        titleIncludes: spec.titleIncludes,
        exePath: spec.exePath,
        preferFocused: true,
      },
      {
        focus: true,
        restoreIfMinimized: spec.restoreIfMinimized !== false,
        launchIfMissing: spec.launchIfMissing !== false,
        launchArgs: spec.launchArgs,
        launchTimeoutMs: spec.launchTimeoutMs,
        minWidth: spec.minWidth,
        minHeight: spec.minHeight,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
    );

    let sessionStatus = {
      verified: false,
      navigationMethod: 'current_session_unverified',
      headerText: '',
    };
    if (sessionName) {
      const navSpec = navigateOnly
        ? { ...spec, navOutShot: resolvedSaveAfterShot || path.join(os.tmpdir(), `abb-chat-nav-${process.pid}-${Date.now()}.png`) }
        : spec;
      sessionStatus = await navigateAndVerifySession(desktop, ready, sessionName, appSpec, navSpec, workDir, options);
      if (navigateOnly) {
        return {
          ok: true,
          navigateOnly: true,
          verified: false,
          requiresVisualCheck: true,
          windowId: ready.windowId,
          app: ready.window?.app || spec.app || null,
          windowActions: ready.actions,
          bounds: ready.bounds,
          session: sessionName,
          navigationMethod: sessionStatus.navigationMethod,
          afterShotPath: sessionStatus.afterShotPath,
          headerOcrText: sessionStatus.headerOcrText || '',
          headerOcrMatched: Boolean(sessionStatus.headerOcrMatched),
          totalElapsedMs: Date.now() - startedAt,
        };
      }
    }

    const windowId = ready.windowId;
    const bounds = ready.bounds;
    let detectedLayout = sessionStatus.detectedLayout || null;
    if (!detectedLayout && !sessionName && spec.autoDetectLayout !== false && !spec.composerPoint && !spec.composerRatio) {
      const layoutProbeShot = path.join(workDir, 'layout-probe.png');
      try {
        await desktop.adScreenshot(undefined, layoutProbeShot, { windowId, signal: options.signal, timeoutMs: options.timeoutMs });
        detectedLayout = await tryDetectLayoutSafe(layoutProbeShot, options);
      } catch {}
    }
    const effectiveSpec = (!spec.composerPoint && !spec.composerRatio && detectedLayout?.composerRatio)
      ? { ...spec, composerRatio: detectedLayout.composerRatio }
      : spec;
    const composerPoint = resolveComposerPoint(effectiveSpec, bounds, appSpec);
    if (
      composerPoint.x < bounds.x
      || composerPoint.y < bounds.y
      || composerPoint.x >= bounds.x + bounds.width
      || composerPoint.y >= bounds.y + bounds.height
    ) {
      throw fail('DESKTOP_TARGET_UNVERIFIED', 'Composer click point lies outside target window bounds');
    }

    const pasteCombo = spec.pasteCombo || 'ctrl+v';
    const submitKey = spec.submitKey || 'return';
    const textPasteSettleMs = spec.textPasteSettleMs ?? 45;
    const textSendSettleMs = spec.textSendSettleMs ?? 85;
    const mediaPasteSettleMs = spec.mediaPasteSettleMs ?? 150;
    const mediaSendSettleMs = spec.mediaSendSettleMs ?? 165;

    const beforeShot = path.join(workDir, 'before-delivery.png');
    const afterShot = path.join(workDir, 'after-delivery.png');
    const cursorCallOpts = {
      ...(spec.restoreCursor !== undefined ? { restoreCursor: spec.restoreCursor } : {}),
      ...(spec.ripple !== undefined ? { ripple: spec.ripple } : {}),
      ...(spec.clickMode !== undefined ? { clickMode: spec.clickMode } : {}),
      ...(spec.humanGuardMs !== undefined ? { humanGuardMs: spec.humanGuardMs } : {}),
    };
    const skipComposerClick = spec.composerClick === false
      || (spec.navigationMode === 'keyboard_first' && sessionStatus.navigationMethod === 'search_enter' && spec.composerClick !== true);
    let clickedComposerStandalone = false;
    if (!skipComposerClick && typeof desktop.adMouseClick === 'function') {
      await clickPointInChat(
        desktop,
        windowId,
        composerPoint.x,
        composerPoint.y,
        35,
        null,
        cursorCallOpts,
        options,
      );
      clickedComposerStandalone = true;
    }

    const hasBatchComposerClick = !skipComposerClick && !clickedComposerStandalone;
    const steps = [
      { command: 'screenshot', windowId, outputPath: beforeShot },
      ...(hasBatchComposerClick ? [
        { command: 'mouse-click', x: composerPoint.x, y: composerPoint.y, windowId },
        { command: 'wait', ms: 35 },
      ] : []),
    ];
    const itemMeta = [];

    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      const clipIndex = steps.length;
      if (it.kind === 'text') {
        steps.push({ command: 'clipboard-set', text: it.text });
      } else if (it.clipboardMode === 'image_png') {
        steps.push({ command: 'clipboard-set', image: it.pngPath });
      } else {
        steps.push({ command: 'clipboard-set', fileUrls: [it.filePath] });
      }
      const pasteIndex = steps.length;
      steps.push({ command: 'press', combo: pasteCombo, windowId });
      steps.push({ command: 'wait', ms: it.kind === 'text' ? textPasteSettleMs : mediaPasteSettleMs });
      const submitIndex = steps.length;
      steps.push({ command: 'press', combo: submitKey, windowId });
      steps.push({ command: 'wait', ms: it.kind === 'text' ? textSendSettleMs : mediaSendSettleMs });
      itemMeta.push({ itemIndex: i, kind: it.kind, clipIndex, pasteIndex, submitIndex });
    }

    const afterShotIndex = steps.length;
    steps.push({ command: 'screenshot', windowId, outputPath: afterShot });
    const clearClipIndex = steps.length;
    steps.push({ command: 'clipboard-clear' });

    if (steps.length > 64) {
      throw fail('INVALID_ARGS', `Chat batch requires ${steps.length} native entries (max 64); split into smaller batches`);
    }

    let batchRes;
    try {
      batchRes = await desktop.adBatch(steps, {
        windowId,
        ...(spec.restoreCursor !== undefined ? { restoreCursor: spec.restoreCursor } : {}),
        ...(spec.ripple !== undefined ? { ripple: spec.ripple } : {}),
        ...(spec.clickMode !== undefined ? { clickMode: spec.clickMode } : {}),
        ...(spec.humanGuardMs !== undefined ? { humanGuardMs: spec.humanGuardMs } : {}),
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
    } catch (err) {
      await desktop.adClipboardClear({ signal: options.signal }).catch(() => {});
      throw err;
    }

    const entries = Array.isArray(batchRes?.results) ? batchRes.results : [];
    if (!entries[clearClipIndex]?.ok) {
      await desktop.adClipboardClear({ signal: options.signal }).catch(() => {});
    }

    const preflightIndices = hasBatchComposerClick ? [0, 1, 2] : [0];
    if (preflightIndices.some(idx => !entries[idx]?.ok)) {
      const failedPreflight = entries[preflightIndices.find(idx => !entries[idx]?.ok)];
      throw buildSceneError(
        failedPreflight?.error?.code || 'CHAT_PREFLIGHT_FAILED',
        'Chat composer preflight screenshot or focus click failed before pasting any item',
        { delivery: 'not_delivered', retry: 'safe' },
        { windowId, stopped: batchRes?.stopped || null },
      );
    }

    let submittedCount = 0;
    for (const meta of itemMeta) {
      const clipEntry = entries[meta.clipIndex];
      const pasteEntry = entries[meta.pasteIndex];
      const submitEntry = entries[meta.submitIndex];
      if (!clipEntry?.ok || !pasteEntry?.ok || !submitEntry?.ok) {
        const anyDispatched = meta.itemIndex > 0 || Boolean(pasteEntry && pasteEntry.execution === 'completed');
        throw buildSceneError(
          submitEntry?.error?.code || pasteEntry?.error?.code || clipEntry?.error?.code || 'CHAT_DELIVERY_FAILED',
          `Chat delivery failed at item index ${meta.itemIndex} (${meta.kind}); inspect target chat before retrying`,
          anyDispatched ? { delivery: 'unknown', retry: 'unsafe' } : { delivery: 'not_delivered', retry: 'safe' },
          { windowId, submittedCount, failedItemIndex: meta.itemIndex, stopped: batchRes?.stopped || null },
        );
      }
      submittedCount += 1;
    }

    if (!entries[afterShotIndex]?.ok || !fs.existsSync(beforeShot) || !fs.existsSync(afterShot)) {
      throw buildSceneError(
        'VISUAL_SCREENSHOT_MISSING',
        'Post-delivery screenshot could not be captured; inspect chat history before retrying',
        { delivery: 'delivered_unverified', retry: 'unsafe' },
        { windowId, submittedCount },
      );
    }

    const beforeHash = sha256File(beforeShot);
    const afterHash = sha256File(afterShot);
    if (beforeHash.size < 64 || afterHash.size < 64 || beforeHash.sha256 === afterHash.sha256) {
      throw buildSceneError(
        'VISUAL_STATE_UNCHANGED',
        'Chat window visual state did not change after submitting items; inspect target chat before retrying',
        { delivery: 'delivered_unverified', retry: 'unsafe' },
        { windowId, submittedCount, beforeSha256: beforeHash.sha256, afterSha256: afterHash.sha256 },
      );
    }

    const effectiveMessagesRegion = spec.messagesRegion || detectedLayout?.regions?.messages || 'messages';
    const effectiveComposerRegion = spec.composerRegion || detectedLayout?.regions?.composer || 'composer';
    const effectiveHeaderRegion = spec.headerRegion || detectedLayout?.regions?.header || 'header';

    let beforeMessagesSha = null;
    let afterMessagesSha = null;
    if (process.platform === 'win32' && /^w-\d+$/.test(String(windowId))) {
      try {
        const [bReg, aReg] = await Promise.all([
          winHelper.hashImageRegion(beforeShot, { region: effectiveMessagesRegion, signal: options.signal, timeoutMs: options.timeoutMs }),
          winHelper.hashImageRegion(afterShot, { region: effectiveMessagesRegion, signal: options.signal, timeoutMs: options.timeoutMs }),
        ]);
        beforeMessagesSha = bReg?.sha256 || null;
        afterMessagesSha = aReg?.sha256 || null;
        if (beforeMessagesSha && afterMessagesSha && beforeMessagesSha === afterMessagesSha) {
          let composerChanged = false;
          try {
            const [bComp, aComp] = await Promise.all([
              winHelper.hashImageRegion(beforeShot, { region: effectiveComposerRegion, signal: options.signal, timeoutMs: options.timeoutMs }),
              winHelper.hashImageRegion(afterShot, { region: effectiveComposerRegion, signal: options.signal, timeoutMs: options.timeoutMs }),
            ]);
            composerChanged = Boolean(bComp?.sha256 && aComp?.sha256 && bComp.sha256 !== aComp.sha256);
          } catch {}
          const suggestedSubmitKey = submitKey === 'return' ? 'ctrl+return' : 'return';
          throw buildSceneError(
            'VISUAL_STATE_UNCHANGED',
            composerChanged
              ? `Chat message transcript area did not change while composer input changed (items may still be unsent in composer; check if target app uses submitKey:"${suggestedSubmitKey}"); inspect target chat before retrying`
              : 'Chat message transcript area did not visually change after submitting items; inspect target chat before retrying',
            { delivery: 'delivered_unverified', retry: 'unsafe' },
            {
              windowId,
              submittedCount,
              beforeMessagesSha256: beforeMessagesSha,
              afterMessagesSha256: afterMessagesSha,
              composerChanged,
              ...(composerChanged ? { suggestedSubmitKey } : {}),
            },
          );
        }
      } catch (hashErr) {
        if (hashErr?.code === 'VISUAL_STATE_UNCHANGED') throw hashErr;
      }
    }

    // Post-delivery OCR verification of header + message transcript
    let postHeaderVerified = !sessionName;
    let postHeaderText = '';
    if (sessionName) {
      const postHeader = await checkHeaderSession(afterShot, sessionName, bounds, spec, options, effectiveHeaderRegion);
      postHeaderVerified = postHeader.matched;
      postHeaderText = postHeader.headerText;
      if (!postHeaderVerified) {
        throw buildSceneError(
          'CHAT_TARGET_UNVERIFIED',
          `Active chat header after delivery ("${postHeaderText}") no longer matched "${sessionName}"; inspect chat window before taking further action`,
          { delivery: 'delivered_unverified', retry: 'unsafe' },
          { windowId, submittedCount, expectedSession: sessionName, observedHeaderText: postHeaderText },
        );
      }
    }
    const textItems = items.filter(it => it.kind === 'text');
    let ocrVerifiedTextCount = 0;
    if (textItems.length > 0) {
      const msgOcr = await winHelper.ocrImage(afterShot, {
        region: effectiveMessagesRegion,
        scale: spec.ocrScale ?? 3,
        bounds,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      const fullCompact = winHelper.compactSearchKey(msgOcr.text || '');
      const lineCompacts = (msgOcr.lines || []).map(l => winHelper.compactSearchKey(l.text || '')).filter(Boolean);
      const hasOrderedOverlap = (needle, hay) => {
        if (needle.length < 6 || hay.length < 4) return false;
        let ni = 0;
        let matchedChars = 0;
        for (let hi = 0; hi < hay.length && ni < needle.length; hi += 1) {
          const pos = needle.indexOf(hay[hi], ni);
          if (pos !== -1 && pos - ni <= 2) {
            matchedChars += 1;
            ni = pos + 1;
          }
        }
        return matchedChars / needle.length >= 0.6;
      };
      for (const tItem of textItems) {
        const cleanBody = tItem.text.trim();
        const probe = cleanBody.slice(0, 14);
        const hits = winHelper.findOcrMatches(msgOcr, probe, bounds);
        if (hits.length > 0) {
          ocrVerifiedTextCount += 1;
          continue;
        }
        const stripped = cleanBody.replace(/^\[[^\]]+\]\s*/, '');
        const compactItem = winHelper.compactSearchKey(stripped || cleanBody);
        let anchorMatched = false;
        if (compactItem.length >= 4) {
          const winLen = Math.min(6, compactItem.length);
          for (let start = 0; start + winLen <= Math.min(compactItem.length, 18); start += 2) {
            if (fullCompact.includes(compactItem.slice(start, start + winLen))) {
              anchorMatched = true;
              break;
            }
          }
        }
        if (!anchorMatched && compactItem.length >= 6) {
          const probePrefix = compactItem.slice(0, 14);
          anchorMatched = lineCompacts.some(lc => hasOrderedOverlap(probePrefix, lc));
        }
        if (anchorMatched) {
          ocrVerifiedTextCount += 1;
        }
      }
    }

    const sessionVerified = sessionName ? Boolean(sessionStatus.verified && postHeaderVerified) : false;
    if (resolvedSaveAfterShot) {
      fs.mkdirSync(path.dirname(resolvedSaveAfterShot), { recursive: true });
      fs.copyFileSync(afterShot, resolvedSaveAfterShot);
    }
    return {
      ok: true,
      verified: sessionName ? sessionVerified : true,
      windowId,
      app: ready.window?.app || spec.app || null,
      windowActions: ready.actions,
      session: sessionName || null,
      sessionVerified,
      navigationMethod: sessionStatus.navigationMethod,
      headerText: sessionStatus.headerText,
      composerPoint,
      ...(resolvedSaveAfterShot ? { afterShotPath: resolvedSaveAfterShot } : {}),
      ...(detectedLayout ? {
        detectedLayout: {
          sidebarRightX: detectedLayout.sidebarRightX,
          rightDrawerLeftX: detectedLayout.rightDrawerLeftX,
          composerTopY: detectedLayout.composerTopY,
        },
      } : {}),
      totalItems: items.length,
      deliveredCount: items.length,
      itemBreakdown: {
        text: textItems.length,
        image: items.filter(i => i.kind === 'image').length,
        sticker: items.filter(i => i.kind === 'sticker').length,
        file: items.filter(i => i.kind === 'file').length,
      },
      ocrVerifiedTextCount,
      transport: batchRes.transport,
      batchSteps: steps.length,
      batchElapsedMs: batchRes.elapsed_ms,
      totalElapsedMs: Date.now() - startedAt,
      visualEvidence: {
        beforeSha256: beforeHash.sha256,
        afterSha256: afterHash.sha256,
        ...(resolvedSaveAfterShot ? { afterShot: resolvedSaveAfterShot } : {}),
        ...(keepShots ? { beforeShot, afterShot } : {}),
      },
    };
  } finally {
    try { fs.rmSync(mediaTempDir, { recursive: true, force: true }); } catch {}
    if (!keepShots) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }
}

async function clickTextVerified(desktop, spec = {}, options = {}) {
  if (!desktop || typeof desktop.adOcrWindow !== 'function') {
    throw fail('INVALID_ARGS', 'clickTextVerified requires a desktop client supporting adOcrWindow');
  }
  const targetText = typeof spec.text === 'string' ? spec.text.trim() : '';
  if (!targetText) {
    throw fail('INVALID_ARGS', 'clickTextVerified requires a non-empty target text');
  }
  if (spec.clickMode !== undefined && !['physical_restore', 'message'].includes(spec.clickMode)) {
    throw fail('INVALID_ARGS', 'clickMode must be physical_restore or message');
  }
  const ready = await ensureWindowReady(
    desktop,
    {
      app: spec.app,
      windowId: spec.windowId,
      titleIncludes: spec.titleIncludes,
      exePath: spec.exePath,
      preferFocused: true,
    },
    {
      focus: true,
      restoreIfMinimized: spec.restoreIfMinimized !== false,
      launchIfMissing: Boolean(spec.launchIfMissing),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    },
  );
  const runOcrSearch = () => desktop.adOcrWindow(undefined, {
    windowId: ready.windowId,
    region: spec.region,
    find: targetText,
    scale: spec.scale ?? 2,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });

  let ocr = await runOcrSearch();
  let matches = Array.isArray(ocr.matches) ? ocr.matches : [];
  const index = Number.isInteger(spec.index) && spec.index >= 0 ? spec.index : 0;
  const maxScrollRetries = Number.isInteger(spec.scrollRetries) ? Math.max(0, Math.min(10, spec.scrollRetries)) : 0;
  let scrolledAttempts = 0;

  if (matches.length <= index && maxScrollRetries > 0 && typeof desktop.adMouseWheel === 'function' && ready.bounds) {
    const b = ready.bounds;
    let scrollX = b.x + Math.round(b.width * 0.5);
    let scrollY = b.y + Math.round(b.height * 0.5);
    if (spec.region && spec.region !== 'full' && spec.region !== 'all') {
      try {
        const crop = winHelper.resolveRegionCrop(spec.region, b.width, b.height);
        if (crop) {
          const mapped = winHelper.mapRectToScreen(crop, b.width, b.height, b);
          scrollX = mapped.center.x;
          scrollY = mapped.center.y;
        }
      } catch {}
    }
    for (let attempt = 1; attempt <= maxScrollRetries; attempt += 1) {
      await desktop.adMouseWheel(scrollX, scrollY, {
        dy: spec.scrollDy ?? -5,
        windowId: ready.windowId,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      if (typeof desktop.adWait === 'function') {
        await desktop.adWait(spec.scrollSettleMs ?? 160, { signal: options.signal, timeoutMs: options.timeoutMs });
      } else {
        await new Promise(resolve => setTimeout(resolve, spec.scrollSettleMs ?? 160));
      }
      scrolledAttempts = attempt;
      ocr = await runOcrSearch();
      matches = Array.isArray(ocr.matches) ? ocr.matches : [];
      if (matches.length > index) break;
    }
  }

  if (matches.length <= index) {
    throw buildSceneError(
      'OCR_TEXT_NOT_FOUND',
      `Target text "${targetText}" was not found via OCR on window ${ready.windowId}`,
      { delivery: 'not_delivered', retry: 'safe' },
      { windowId: ready.windowId, region: spec.region || 'full', matchCount: matches.length, scrolledAttempts },
    );
  }
  const chosen = matches[index];
  await desktop.adMouseClick(chosen.screen.center.x, chosen.screen.center.y, {
    windowId: ready.windowId,
    button: spec.button || 'left',
    count: spec.doubleClick ? 2 : 1,
    ...(spec.restoreCursor !== undefined ? { restoreCursor: spec.restoreCursor } : {}),
    ...(spec.ripple !== undefined ? { ripple: spec.ripple } : {}),
    ...(spec.clickMode !== undefined ? { clickMode: spec.clickMode } : {}),
    ...(spec.humanGuardMs !== undefined ? { humanGuardMs: spec.humanGuardMs } : {}),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  return {
    ok: true,
    windowId: ready.windowId,
    clicked: chosen.screen.center,
    matchedText: chosen.matchedText,
    lineText: chosen.lineText,
    confidence: chosen.confidence,
    matchCount: matches.length,
    ...(scrolledAttempts > 0 ? { scrolledAttempts } : {}),
  };
}

module.exports = {
  deliverChatSessionVerified,
  clickTextVerified,
  prepareChatItems,
  isStrictHeaderLineMatch,
};
