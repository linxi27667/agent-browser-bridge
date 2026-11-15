const { fail } = require('../errors');

function isCollapsedBounds(bounds, minWidth, minHeight) {
  if (!bounds || typeof bounds !== 'object') return true;
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return true;
  return bounds.width < minWidth || bounds.height < minHeight;
}

async function ensureWindowReady(desktop, target = {}, options = {}) {
  if (!desktop || typeof desktop.adInspectCapabilities !== 'function') {
    throw fail('INVALID_ARGS', 'ensureWindowReady requires a desktop client instance');
  }
  const hasTitle = typeof target?.titleIncludes === 'string' && target.titleIncludes.trim().length > 0;
  if (!target || typeof target !== 'object' || Array.isArray(target) || (!target.app && !target.windowId && !hasTitle)) {
    throw fail('INVALID_ARGS', 'ensureWindowReady requires target.app, target.windowId, or target.titleIncludes');
  }
  const focus = options.focus ?? 'auto';
  const restoreIfMinimized = options.restoreIfMinimized ?? true;
  const minWidth = Number.isFinite(options.minWidth) && options.minWidth > 0 ? options.minWidth : 120;
  const minHeight = Number.isFinite(options.minHeight) && options.minHeight > 0 ? options.minHeight : 80;
  if ((focus !== 'auto' && typeof focus !== 'boolean') || typeof restoreIfMinimized !== 'boolean') {
    throw fail('INVALID_ARGS', 'ensureWindowReady focus must be boolean or "auto", and restoreIfMinimized must be boolean');
  }

  const callBase = {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    nativeTimeoutMs: options.nativeTimeoutMs,
  };
  const actions = [];
  let capabilities = await desktop.adInspectCapabilities(target.app, {
    ...callBase,
    windowId: target.windowId,
    titleIncludes: target.titleIncludes,
    preferFocused: target.preferFocused ?? true,
  });

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
    capabilities = await desktop.adInspectCapabilities(target.app, {
      ...callBase,
      windowId: capabilities.windowId,
    });
  }

  const shouldFocus = focus === true || (focus === 'auto' && capabilities.mode === 'custom_ui_visual');
  if (shouldFocus && !capabilities.isFocused) {
    await desktop.adFocusWindow(undefined, { ...callBase, windowId: capabilities.windowId });
    actions.push('focus');
    const windows = await desktop.adListWindows(target.app, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    const refreshed = (Array.isArray(windows) ? windows : []).find(w => w.id === capabilities.windowId);
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
    ready: true,
    actions,
  };
}

module.exports = { ensureWindowReady };
