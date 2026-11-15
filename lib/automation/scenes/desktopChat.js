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
  const { xRatio, yRatio } = ratio;
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
  const normLine = winHelper.normalizeOcrText(lineText || '');
  const normNeedle = winHelper.normalizeOcrText(sessionName || '');
  const needleCompact = winHelper.compactSearchKey(normNeedle);
  if (!needleCompact) return false;
  if (normLine === normNeedle) return true;
  if (normLine.startsWith(normNeedle)) {
    const nextCh = normLine[normNeedle.length];
    if (!nextCh || /[\s(（\[【\-—|·•:：@0-9]/.test(nextCh)) return true;
  }
  const stem = normLine.replace(/\s*[(（\[【]\s*\d+\s*[)）\]】]\s*$/, '').trim();
  const stemCompact = winHelper.compactSearchKey(stem);
  if (stemCompact === needleCompact) return true;
  const maxDist = needleCompact.length >= 4 && needleCompact.length <= 8 ? 1 : 0;
  if (maxDist > 0 && Math.abs(stemCompact.length - needleCompact.length) <= maxDist) {
    const singleLineOcr = {
      imageWidth: 400,
      imageHeight: 60,
      lines: [{ text: stem, rawText: stem, x: 0, y: 0, width: 100, height: 20, words: [] }],
    };
    return winHelper.findOcrMatches(singleLineOcr, sessionName, null).length > 0;
  }
  return false;
}

async function checkHeaderSession(shotPath, sessionName, bounds, spec, options) {
  const ocr = await winHelper.ocrImage(shotPath, {
    region: spec.headerRegion || 'header',
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

async function navigateAndVerifySession(desktop, readyWindow, sessionName, appSpec, spec, tempDir, options) {
  const windowId = readyWindow.windowId;
  const bounds = readyWindow.bounds;
  const shot0 = path.join(tempDir, 'session-initial.png');
  await desktop.adScreenshot(undefined, shot0, { windowId, signal: options.signal, timeoutMs: options.timeoutMs });

  const initialHeader = await checkHeaderSession(shot0, sessionName, bounds, spec, options);
  if (initialHeader.matched) {
    return {
      verified: true,
      navigationMethod: 'already_active',
      headerText: initialHeader.headerText,
      headerMatch: initialHeader.match,
    };
  }

  // Try clicking visible conversation entry in sidebar first (reusing the same screenshot!)
  const sidebarOcr = await winHelper.ocrImage(shot0, {
    region: spec.sidebarRegion || 'sidebar',
    find: sessionName,
    scale: spec.ocrScale ?? 2,
    bounds,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  const minSidebarRowY = Math.min(54, Math.round(sidebarOcr.imageHeight * 0.08));
  const sidebarHit = (sidebarOcr.matches || []).find(m => m.imageRect.y >= minSidebarRowY);

  if (sidebarHit) {
    const shot1 = path.join(tempDir, 'session-after-sidebar.png');
    await desktop.adBatch(
      [
        { command: 'mouse-click', x: sidebarHit.screen.center.x, y: sidebarHit.screen.center.y, windowId },
        { command: 'wait', ms: spec.navigationSettleMs ?? 200 },
        { command: 'screenshot', windowId, outputPath: shot1 },
      ],
      { windowId, signal: options.signal, timeoutMs: options.timeoutMs },
    );
    if (fs.existsSync(shot1)) {
      const afterSideHeader = await checkHeaderSession(shot1, sessionName, bounds, spec, options);
      if (afterSideHeader.matched) {
        return {
          verified: true,
          navigationMethod: 'sidebar_click',
          clickedPoint: sidebarHit.screen.center,
          headerText: afterSideHeader.headerText,
          headerMatch: afterSideHeader.match,
        };
      }
    }
  }

  // Fallback: Ctrl+F search navigation
  if (spec.allowSearch !== false) {
    const searchShortcut = spec.searchShortcut || appSpec?.searchShortcut || 'ctrl+f';
    const searchShot = path.join(tempDir, 'session-search-results.png');
    try {
      await desktop.adBatch(
        [
          { command: 'press', combo: 'escape', windowId },
          { command: 'wait', ms: 60 },
          { command: 'press', combo: searchShortcut, windowId },
          { command: 'wait', ms: 160 },
          { command: 'clipboard-set', text: sessionName },
          { command: 'press', combo: 'ctrl+v', windowId },
          { command: 'wait', ms: spec.searchWaitMs ?? 340 },
          { command: 'screenshot', windowId, outputPath: searchShot },
          { command: 'clipboard-clear' },
        ],
        { windowId, signal: options.signal, timeoutMs: options.timeoutMs },
      );
    } catch (err) {
      await desktop.adClipboardClear({ signal: options.signal }).catch(() => {});
      throw err;
    }

    if (fs.existsSync(searchShot)) {
      const dropdownOcr = await winHelper.ocrImage(searchShot, {
        region: spec.sidebarRegion || 'sidebar',
        find: sessionName,
        scale: spec.ocrScale ?? 2,
        bounds,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      // Skip the search input row itself (usually y < 74px from top of window)
      const resultRowMinY = Math.min(76, Math.round(dropdownOcr.imageHeight * 0.11));
      const dropdownHit = (dropdownOcr.matches || []).find(m => m.imageRect.y >= resultRowMinY);
      const shot2 = path.join(tempDir, 'session-after-search.png');
      const selectSteps = dropdownHit
        ? [
          { command: 'mouse-click', x: dropdownHit.screen.center.x, y: dropdownHit.screen.center.y, windowId },
          { command: 'wait', ms: spec.navigationSettleMs ?? 240 },
          { command: 'screenshot', windowId, outputPath: shot2 },
        ]
        : [
          { command: 'press', combo: 'return', windowId },
          { command: 'wait', ms: spec.navigationSettleMs ?? 240 },
          { command: 'screenshot', windowId, outputPath: shot2 },
        ];
      await desktop.adBatch(selectSteps, { windowId, signal: options.signal, timeoutMs: options.timeoutMs });

      if (fs.existsSync(shot2)) {
        const afterSearchHeader = await checkHeaderSession(shot2, sessionName, bounds, spec, options);
        if (afterSearchHeader.matched) {
          return {
            verified: true,
            navigationMethod: dropdownHit ? 'search_dropdown_click' : 'search_enter',
            ...(dropdownHit ? { clickedPoint: dropdownHit.screen.center } : {}),
            headerText: afterSearchHeader.headerText,
            headerMatch: afterSearchHeader.match,
          };
        }
        throw buildSceneError(
          'CHAT_TARGET_UNVERIFIED',
          `Could not verify target chat session "${sessionName}" in active chat header after sidebar/search navigation; zero items were sent`,
          { delivery: 'not_delivered', retry: 'safe' },
          {
            expectedSession: sessionName,
            observedHeaderText: afterSearchHeader.headerText,
          },
        );
      }
    }
  }

  throw buildSceneError(
    'CHAT_TARGET_UNVERIFIED',
    `Active chat header did not match "${sessionName}"; refusing to paste or send any items`,
    { delivery: 'not_delivered', retry: 'safe' },
    {
      expectedSession: sessionName,
      observedHeaderText: initialHeader.headerText,
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
  const hasTarget = Boolean(spec.app || spec.windowId || spec.titleIncludes || spec.exePath);
  if (!hasTarget) {
    throw fail('INVALID_ARGS', 'Chat delivery requires app (e.g. "wecom" / "wechat"), windowId, titleIncludes, or exePath');
  }
  const rawSession = spec.session ?? spec.sessionName ?? spec.targetSession;
  const sessionName = typeof rawSession === 'string' ? rawSession.trim() : '';
  if (!sessionName && spec.allowCurrentSession !== true) {
    throw fail('INVALID_ARGS', 'Chat delivery requires spec.session / spec.sessionName (e.g. "文件传输助手") unless allowCurrentSession:true is set');
  }

  const rawItems = spec.items ?? spec.messages;
  const keepShots = typeof spec.screenshotDir === 'string' && spec.screenshotDir.trim().length > 0;
  const workDir = keepShots
    ? path.resolve(spec.screenshotDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'abb-chat-send-'));
  if (keepShots) fs.mkdirSync(workDir, { recursive: true });
  const mediaTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-chat-media-'));

  const startedAt = Date.now();
  try {
    const items = await prepareChatItems(rawItems, mediaTempDir, options);
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
      sessionStatus = await navigateAndVerifySession(desktop, ready, sessionName, appSpec, spec, workDir, options);
    }

    const windowId = ready.windowId;
    const bounds = ready.bounds;
    const composerPoint = resolveComposerPoint(spec, bounds, appSpec);
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

    const steps = [
      { command: 'screenshot', windowId, outputPath: beforeShot },
      { command: 'mouse-click', x: composerPoint.x, y: composerPoint.y, windowId },
      { command: 'wait', ms: 35 },
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

    if (!entries[0]?.ok || !entries[1]?.ok) {
      throw buildSceneError(
        entries[1]?.error?.code || entries[0]?.error?.code || 'CHAT_PREFLIGHT_FAILED',
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

    // Post-delivery OCR verification of header + message transcript
    let postHeaderVerified = !sessionName;
    let postHeaderText = '';
    if (sessionName) {
      const postHeader = await checkHeaderSession(afterShot, sessionName, bounds, spec, options);
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
        region: spec.messagesRegion || 'messages',
        scale: spec.ocrScale ?? 2,
        bounds,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      for (const tItem of textItems) {
        const probe = tItem.text.trim().slice(0, 14);
        const hits = winHelper.findOcrMatches(msgOcr, probe, bounds);
        if (hits.length > 0) ocrVerifiedTextCount += 1;
      }
    }

    const sessionVerified = sessionName ? Boolean(sessionStatus.verified && postHeaderVerified) : false;
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
  const ocr = await desktop.adOcrWindow(undefined, {
    windowId: ready.windowId,
    region: spec.region,
    find: targetText,
    scale: spec.scale ?? 2,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  const matches = Array.isArray(ocr.matches) ? ocr.matches : [];
  const index = Number.isInteger(spec.index) && spec.index >= 0 ? spec.index : 0;
  if (matches.length <= index) {
    throw buildSceneError(
      'OCR_TEXT_NOT_FOUND',
      `Target text "${targetText}" was not found via OCR on window ${ready.windowId}`,
      { delivery: 'not_delivered', retry: 'safe' },
      { windowId: ready.windowId, region: spec.region || 'full', matchCount: matches.length },
    );
  }
  const chosen = matches[index];
  await desktop.adMouseClick(chosen.screen.center.x, chosen.screen.center.y, {
    windowId: ready.windowId,
    button: spec.button || 'left',
    count: spec.doubleClick ? 2 : 1,
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
  };
}

module.exports = {
  deliverChatSessionVerified,
  clickTextVerified,
  prepareChatItems,
  isStrictHeaderLineMatch,
};
