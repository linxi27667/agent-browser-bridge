const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fail } = require('../errors');
const winHelper = require('../../desktop/winHelper');
const { ensureWindowReady } = require('./desktopWindow');

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 32) {
    throw fail('INVALID_ARGS', 'deliverMessagesVerified requires an array of 1 to 32 messages');
  }
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (typeof msg !== 'string' || !msg.trim() || msg.includes('\0')) {
      throw fail('INVALID_ARGS', `Message at index ${i} must be a non-empty string without NUL bytes`);
    }
    if (Buffer.byteLength(msg, 'utf8') > 64 * 1024) {
      throw fail('INVALID_ARGS', `Message at index ${i} exceeds the 64 KiB composer limit`);
    }
  }
}

function buildDeliveryFailure(code, message, disposition, details) {
  const error = fail(code, message, disposition);
  error.details = details;
  return error;
}

function extractEntryValue(entry) {
  if (!entry || entry.ok !== true) return undefined;
  if (typeof entry.data === 'string') return entry.data;
  if (entry.data && typeof entry.data.value === 'string') return entry.data.value;
  if (entry.data && typeof entry.data.text === 'string') return entry.data.text;
  return '';
}

async function deliverUiaMessages(desktop, spec, messages, options) {
  if (typeof spec.editRef !== 'string' || !/^@[A-Za-z0-9_-]+:e[1-9]\d*$/.test(spec.editRef)) {
    throw fail('INVALID_ARGS', 'UIA composer delivery requires a snapshot-qualified spec.editRef');
  }
  const hasSendRef = typeof spec.sendRef === 'string' && spec.sendRef.length > 0;
  const hasSubmitKey = typeof spec.submitKey === 'string' && spec.submitKey.length > 0;
  if (hasSendRef === hasSubmitKey) {
    throw fail('INVALID_ARGS', 'UIA composer delivery requires exactly one of spec.sendRef or spec.submitKey');
  }
  if (hasSendRef && !/^@[A-Za-z0-9_-]+:e[1-9]\d*$/.test(spec.sendRef)) {
    throw fail('INVALID_ARGS', 'spec.sendRef must be a snapshot-qualified ref');
  }
  if (hasSubmitKey && !spec.windowId && !spec.app) {
    throw fail('INVALID_ARGS', 'spec.submitKey requires spec.windowId or spec.app');
  }

  const inputMethod = spec.inputMethod ?? 'set-value';
  if (!['set-value', 'type'].includes(inputMethod)) {
    throw fail('INVALID_ARGS', 'spec.inputMethod must be "set-value" or "type"');
  }
  const verifyReadback = spec.verifyReadback !== false;
  const verifyCleared = Boolean(spec.verifyCleared);
  const interMessageWaitMs = spec.interMessageWaitMs ?? 0;
  if (!Number.isInteger(interMessageWaitMs) || interMessageWaitMs < 0 || interMessageWaitMs > 5000) {
    throw fail('INVALID_ARGS', 'spec.interMessageWaitMs must be an integer from 0 to 5000');
  }

  const steps = [];
  const planMeta = [];

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const inputIndex = steps.length;
    if (inputMethod === 'set-value') {
      steps.push({ command: 'set-value', ref: spec.editRef, value: msg });
    } else {
      steps.push({ command: 'type', ref: spec.editRef, text: msg });
    }
    let readbackIndex = -1;
    if (verifyReadback) {
      readbackIndex = steps.length;
      steps.push({ command: 'get', ref: spec.editRef, property: 'value' });
    }
    const submitIndex = steps.length;
    if (hasSendRef) {
      steps.push({ command: 'click', ref: spec.sendRef });
    } else {
      steps.push({
        command: 'press',
        combo: spec.submitKey,
        ...(spec.windowId ? { windowId: spec.windowId } : { app: spec.app }),
      });
    }
    if (interMessageWaitMs > 0) {
      steps.push({ command: 'wait', ms: interMessageWaitMs });
    }
    let clearedIndex = -1;
    if (verifyCleared) {
      clearedIndex = steps.length;
      steps.push({ command: 'get', ref: spec.editRef, property: 'value' });
    }
    planMeta.push({ messageIndex: i, inputIndex, readbackIndex, submitIndex, clearedIndex });
  }

  let targetVerifyIndex = -1;
  if (spec.verifyTargetRef) {
    targetVerifyIndex = steps.length;
    steps.push({
      command: 'get',
      ref: spec.verifyTargetRef,
      property: spec.verifyTargetProperty || 'text',
    });
  }

  if (steps.length > 64) {
    throw fail('INVALID_ARGS', 'Composer batch exceeds 64 native batch entries; reduce message count per batch');
  }

  const batchRes = await desktop.adBatch(steps, {
    windowId: spec.windowId,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  const entries = Array.isArray(batchRes?.results) ? batchRes.results : [];
  let verifiedCount = 0;

  for (const meta of planMeta) {
    const { messageIndex, inputIndex, readbackIndex, submitIndex, clearedIndex } = meta;
    const inputEntry = entries[inputIndex];
    if (!inputEntry || inputEntry.ok !== true) {
      const disposition = messageIndex === 0 && inputEntry?.error?.disposition?.delivery === 'not_delivered'
        ? { delivery: 'not_delivered', retry: 'safe' }
        : { delivery: 'unknown', retry: 'unsafe' };
      throw buildDeliveryFailure(
        inputEntry?.error?.code || 'COMPOSER_INPUT_FAILED',
        `Composer input failed at message index ${messageIndex}; no automatic retry was performed`,
        disposition,
        { mode: 'uia_semantic', verifiedCount, failedMessageIndex: messageIndex, failedPhase: 'input', stopped: batchRes?.stopped || null },
      );
    }

    const submitEntry = entries[submitIndex];
    const submitAttempted = Boolean(submitEntry && submitEntry.execution === 'completed');

    if (readbackIndex >= 0) {
      const rbEntry = entries[readbackIndex];
      const actual = extractEntryValue(rbEntry);
      const expected = messages[messageIndex];
      const matches = spec.readbackMatch === 'includes'
        ? (typeof actual === 'string' && actual.includes(expected))
        : actual === expected;
      if (!rbEntry || rbEntry.ok !== true || !matches) {
        const disposition = (!submitAttempted && messageIndex === 0)
          ? { delivery: 'not_delivered', retry: 'safe' }
          : { delivery: submitAttempted ? 'delivered_unverified' : 'unknown', retry: 'unsafe' };
        throw buildDeliveryFailure(
          'COMPOSER_READBACK_MISMATCH',
          `Composer pre-submit readback mismatch at message index ${messageIndex}; inspect window before retrying`,
          disposition,
          { mode: 'uia_semantic', verifiedCount, failedMessageIndex: messageIndex, failedPhase: 'readback', submitAttempted },
        );
      }
    }

    if (!submitEntry || submitEntry.ok !== true) {
      throw buildDeliveryFailure(
        submitEntry?.error?.code || 'COMPOSER_SUBMIT_FAILED',
        `Composer submit failed at message index ${messageIndex}; inspect target conversation before retrying`,
        submitEntry?.error?.disposition || { delivery: 'unknown', retry: 'unsafe' },
        { mode: 'uia_semantic', verifiedCount, failedMessageIndex: messageIndex, failedPhase: 'submit', stopped: batchRes?.stopped || null },
      );
    }

    if (clearedIndex >= 0) {
      const clrEntry = entries[clearedIndex];
      const afterVal = extractEntryValue(clrEntry);
      if (!clrEntry || clrEntry.ok !== true || afterVal !== '') {
        throw buildDeliveryFailure(
          'COMPOSER_CLEAR_UNVERIFIED',
          `Composer field did not clear after submitting message index ${messageIndex}; inspect target conversation before retrying`,
          { delivery: 'delivered_unverified', retry: 'unsafe' },
          { mode: 'uia_semantic', verifiedCount, failedMessageIndex: messageIndex, failedPhase: 'post_clear' },
        );
      }
    }

    verifiedCount += 1;
  }

  if (targetVerifyIndex >= 0) {
    const targetEntry = entries[targetVerifyIndex];
    const targetText = extractEntryValue(targetEntry);
    const allPresent = typeof targetText === 'string' && messages.every(m => targetText.includes(m));
    if (!targetEntry || targetEntry.ok !== true || !allPresent) {
      throw buildDeliveryFailure(
        'COMPOSER_HISTORY_UNVERIFIED',
        'Target container readback did not confirm all submitted messages; inspect target conversation before retrying',
        { delivery: 'delivered_unverified', retry: 'unsafe' },
        { mode: 'uia_semantic', verifiedCount: 0, submittedCount: messages.length, failedPhase: 'target_readback' },
      );
    }
  }

  return {
    ok: true,
    mode: 'uia_semantic',
    windowId: spec.windowId || null,
    totalMessages: messages.length,
    deliveredCount: messages.length,
    verifiedCount: messages.length,
    transport: batchRes.transport,
    elapsedMs: batchRes.elapsed_ms,
    batchSteps: steps.length,
  };
}

function resolveVisualPoint(spec, bounds) {
  if (spec.composerPoint && typeof spec.composerPoint === 'object') {
    const { x, y } = spec.composerPoint;
    if (![x, y].every(Number.isFinite)) {
      throw fail('INVALID_ARGS', 'spec.composerPoint requires finite x and y coordinates');
    }
    return { x: Math.round(x), y: Math.round(y) };
  }
  if (spec.composerRatio && typeof spec.composerRatio === 'object') {
    const { xRatio, yRatio } = spec.composerRatio;
    if (![xRatio, yRatio].every(Number.isFinite) || xRatio <= 0.02 || xRatio >= 0.98 || yRatio <= 0.02 || yRatio >= 0.98) {
      throw fail('INVALID_ARGS', 'spec.composerRatio requires xRatio and yRatio strictly between 0.02 and 0.98');
    }
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 120 || bounds.height < 80) {
      throw fail('DESKTOP_WINDOW_BOUNDS_INVALID', 'Valid window bounds are required to resolve composerRatio');
    }
    return {
      x: Math.round(bounds.x + bounds.width * xRatio),
      y: Math.round(bounds.y + bounds.height * yRatio),
    };
  }
  throw fail('INVALID_ARGS', 'Visual composer delivery requires spec.composerPoint or spec.composerRatio');
}

function sha256File(filePath) {
  const bytes = fs.readFileSync(filePath);
  return { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

async function deliverVisualMessages(desktop, spec, messages, options) {
  if (typeof spec.windowId !== 'string' || !/^w-[A-Za-z0-9_-]+$/.test(spec.windowId)) {
    throw fail('INVALID_ARGS', 'Visual composer delivery requires an explicit spec.windowId');
  }
  const pasteCombo = spec.pasteCombo || 'ctrl+v';
  const submitKey = spec.submitKey || 'return';
  const settleMs = spec.settleMs ?? 80;
  if (!Number.isInteger(settleMs) || settleMs < 10 || settleMs > 5000) {
    throw fail('INVALID_ARGS', 'spec.settleMs must be an integer from 10 to 5000');
  }

  let bounds = spec.bounds || null;
  const shouldAutoFocus = spec.autoFocus === true || (spec.autoFocus !== false && !bounds);
  if (shouldAutoFocus && typeof desktop.adInspectCapabilities === 'function') {
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
    if (!bounds) bounds = ready.bounds || null;
  }
  if (!bounds) {
    const windows = await desktop.adListWindows(spec.app, { signal: options.signal, timeoutMs: options.timeoutMs });
    const win = (Array.isArray(windows) ? windows : []).find(w => w.id === spec.windowId);
    if (!win) throw fail('WINDOW_NOT_FOUND', 'Target window for visual composer delivery was not found');
    bounds = win.bounds || null;
  }
  const point = resolveVisualPoint(spec, bounds);
  if (bounds && (point.x < bounds.x || point.y < bounds.y || point.x >= bounds.x + bounds.width || point.y >= bounds.y + bounds.height)) {
    throw fail('DESKTOP_TARGET_UNVERIFIED', 'Composer click point lies outside the target window bounds');
  }

  const createdTempDir = !spec.screenshotDir;
  const shotDir = spec.screenshotDir
    ? path.resolve(spec.screenshotDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'abb-visual-composer-'));
  if (!createdTempDir) fs.mkdirSync(shotDir, { recursive: true });

  const beforeShot = path.join(shotDir, 'before-delivery.png');
  const afterShot = path.join(shotDir, 'after-delivery.png');

  try {
    const useStandaloneClick = typeof desktop.adMouseClick === 'function'
      && (spec.standaloneClick === true || spec.autoFocus === true || spec.restoreCursor === true || !spec.bounds);
    let clickedStandalone = false;
    if (useStandaloneClick) {
      const clickOpts = {
        windowId: spec.windowId,
        ...(spec.restoreCursor !== undefined ? { restoreCursor: spec.restoreCursor } : {}),
        ...(spec.ripple !== undefined ? { ripple: spec.ripple } : {}),
        ...(spec.humanGuardMs !== undefined ? { humanGuardMs: spec.humanGuardMs } : {}),
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      };
      try {
        await desktop.adMouseClick(point.x, point.y, clickOpts);
      } catch (clickErr) {
        if (clickErr?.code !== 'DESKTOP_TARGET_UNVERIFIED') throw clickErr;
        if (process.platform === 'win32' && /^w-\d+$/.test(String(spec.windowId || ''))) {
          await winHelper.assistForegroundWindow(spec.windowId, 0, {
            signal: options.signal,
            timeoutMs: options.timeoutMs,
          }).catch(() => null);
        }
        if (typeof desktop.adFocusWindow === 'function') {
          await desktop.adFocusWindow(undefined, {
            windowId: spec.windowId,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
          }).catch(() => {});
        }
        await desktop.adMouseClick(point.x, point.y, clickOpts);
      }
      clickedStandalone = true;
    }

    const steps = [
      { command: 'screenshot', windowId: spec.windowId, outputPath: beforeShot },
      ...(clickedStandalone ? [] : [{ command: 'mouse-click', x: point.x, y: point.y, windowId: spec.windowId }]),
    ];
    const messageStepMeta = [];
    for (let i = 0; i < messages.length; i += 1) {
      const clipIndex = steps.length;
      steps.push({ command: 'clipboard-set', text: messages[i] });
      const pasteIndex = steps.length;
      steps.push({ command: 'press', combo: pasteCombo, windowId: spec.windowId });
      const submitIndex = steps.length;
      steps.push({ command: 'press', combo: submitKey, windowId: spec.windowId });
      steps.push({ command: 'wait', ms: settleMs });
      messageStepMeta.push({ messageIndex: i, clipIndex, pasteIndex, submitIndex });
    }
    const afterShotIndex = steps.length;
    steps.push({ command: 'screenshot', windowId: spec.windowId, outputPath: afterShot });
    const clearClipIndex = steps.length;
    steps.push({ command: 'clipboard-clear' });

    if (steps.length > 64) {
      throw fail('INVALID_ARGS', 'Visual composer batch exceeds 64 native batch entries; reduce message count per batch');
    }

    let batchRes;
    try {
      batchRes = await desktop.adBatch(steps, {
        windowId: spec.windowId,
        ...(spec.restoreCursor !== undefined ? { restoreCursor: spec.restoreCursor } : {}),
        ...(spec.ripple !== undefined ? { ripple: spec.ripple } : {}),
        ...(spec.humanGuardMs !== undefined ? { humanGuardMs: spec.humanGuardMs } : {}),
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
    } catch (err) {
      await desktop.adClipboardClear({ signal: options.signal }).catch(() => {});
      throw err;
    }
    const entries = Array.isArray(batchRes?.results) ? batchRes.results : [];
    if (!entries[clearClipIndex] || entries[clearClipIndex].ok !== true) {
      await desktop.adClipboardClear({ signal: options.signal }).catch(() => {});
    }

    const preflightFailed = !entries[0] || entries[0].ok !== true || (!clickedStandalone && (!entries[1] || entries[1].ok !== true));
    if (preflightFailed) {
      throw buildDeliveryFailure(
        (!clickedStandalone && entries[1]?.error?.code) || entries[0]?.error?.code || 'VISUAL_PREFLIGHT_FAILED',
        'Visual composer preflight screenshot or focus click failed before pasting messages',
        { delivery: 'not_delivered', retry: 'safe' },
        { mode: 'custom_ui_visual', verifiedCount: 0, stopped: batchRes?.stopped || null },
      );
    }

    let submittedCount = 0;
    for (const meta of messageStepMeta) {
      const clipEntry = entries[meta.clipIndex];
      const pasteEntry = entries[meta.pasteIndex];
      const submitEntry = entries[meta.submitIndex];
      if (!clipEntry?.ok || !pasteEntry?.ok || !submitEntry?.ok) {
        const anyDispatched = meta.messageIndex > 0 || Boolean(pasteEntry && pasteEntry.execution === 'completed');
        throw buildDeliveryFailure(
          submitEntry?.error?.code || pasteEntry?.error?.code || clipEntry?.error?.code || 'VISUAL_DELIVERY_FAILED',
          `Visual composer failed at message index ${meta.messageIndex}; inspect target window before retrying`,
          anyDispatched ? { delivery: 'unknown', retry: 'unsafe' } : { delivery: 'not_delivered', retry: 'safe' },
          { mode: 'custom_ui_visual', submittedCount, failedMessageIndex: meta.messageIndex, stopped: batchRes?.stopped || null },
        );
      }
      submittedCount += 1;
    }

    const afterEntry = entries[afterShotIndex];
    if (!afterEntry || afterEntry.ok !== true || !fs.existsSync(beforeShot) || !fs.existsSync(afterShot)) {
      throw buildDeliveryFailure(
        'VISUAL_SCREENSHOT_MISSING',
        'Post-delivery screenshot could not be captured; inspect target window before retrying',
        { delivery: 'delivered_unverified', retry: 'unsafe' },
        { mode: 'custom_ui_visual', submittedCount },
      );
    }

    const beforeHash = sha256File(beforeShot);
    const afterHash = sha256File(afterShot);
    if (beforeHash.size < 64 || afterHash.size < 64 || beforeHash.sha256 === afterHash.sha256) {
      throw buildDeliveryFailure(
        'VISUAL_STATE_UNCHANGED',
        'Window visual state did not change after submitting messages; inspect target window before retrying',
        { delivery: 'delivered_unverified', retry: 'unsafe' },
        { mode: 'custom_ui_visual', submittedCount, beforeSha256: beforeHash.sha256, afterSha256: afterHash.sha256 },
      );
    }

    return {
      ok: true,
      mode: 'custom_ui_visual',
      windowId: spec.windowId,
      composerPoint: point,
      totalMessages: messages.length,
      deliveredCount: messages.length,
      verifiedCount: messages.length,
      transport: batchRes.transport,
      elapsedMs: batchRes.elapsed_ms,
      batchSteps: steps.length,
      visualEvidence: {
        beforeSha256: beforeHash.sha256,
        afterSha256: afterHash.sha256,
        ...(createdTempDir ? {} : { beforeShot, afterShot }),
      },
    };
  } finally {
    if (createdTempDir) {
      try { fs.rmSync(shotDir, { recursive: true, force: true }); } catch {}
    }
  }
}

async function deliverMessagesVerified(desktop, spec = {}, messages = [], options = {}) {
  if (!desktop || typeof desktop.adBatch !== 'function') {
    throw fail('INVALID_ARGS', 'deliverMessagesVerified requires a desktop client supporting adBatch');
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw fail('INVALID_ARGS', 'deliverMessagesVerified requires a composer specification object');
  }
  validateMessages(messages);
  const mode = spec.mode || (spec.editRef ? 'uia_semantic' : 'custom_ui_visual');
  if (mode === 'uia_semantic') return deliverUiaMessages(desktop, spec, messages, options);
  if (mode === 'custom_ui_visual') return deliverVisualMessages(desktop, spec, messages, options);
  throw fail('INVALID_ARGS', `Unsupported composer mode "${mode}"`);
}

module.exports = { deliverMessagesVerified };
