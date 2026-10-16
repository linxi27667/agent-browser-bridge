// AgentBrowserBridge - CDP 窗口几何辅助
// 窄窗口会导致 Element UI 日期/下拉菜单 getBoundingClientRect 宽高为 0，
// 坐标点击落到错误控件。L2 会话操作前应确保可视区域足够。

const { sleep } = require('./client');

/**
 * 将当前 target 所在浏览器窗口调整为可用尺寸。
 * @param {ReturnType<import('./client').createCdp>} cdp
 * @param {{ width?: number, height?: number, left?: number, top?: number }} [opts]
 */
async function ensureWindowBounds(cdp, opts = {}) {
  const width = opts.width || 1400;
  const height = opts.height || 950;
  const left = opts.left ?? 40;
  const top = opts.top ?? 40;

  const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget');
  // 先退出 maximized/fullscreen，再设像素尺寸，否则部分环境下 innerWidth 仍异常偏小
  if (bounds.windowState && bounds.windowState !== 'normal') {
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal' },
    });
    await sleep(200);
  }
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left, top, width, height, windowState: 'normal' },
  });
  await sleep(300);

  const after = await cdp.send('Browser.getWindowForTarget');
  const size = await cdp.eval('({ iw: innerWidth, ih: innerHeight })');
  const { iw, ih } = size.result.value;
  const ok = iw >= 1000 && ih >= 700;
  return {
    windowId,
    iw,
    ih,
    ok,
    bounds: after.bounds,
    // 内容区仍偏小时调用方应改走 JS element.click()，勿盲依赖坐标
    advice: ok
      ? null
      : 'inner viewport still small; prefer JS clicks over Input.dispatchMouseEvent coordinates',
  };
}

/**
 * 判断元素矩形是否可点（宽高过小或坐标为负通常表示被裁切/隐藏/动画中）。
 */
function isClickableRect(r, min = 8) {
  if (!r) return false;
  return r.width >= min && r.height >= min && r.x >= 0 && r.y >= 0;
}

module.exports = { ensureWindowBounds, isClickableRect };
