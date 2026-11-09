// AgentBrowserBridge - 现代极简页面内状态胶囊 HUD 与同心圆水波纹视觉层 (lib/cdp/hud.js)
// 设计规范对齐 Ego / Raycast / Apple 动态岛质感：
// 1. 无冗余调试字段，仅呈现有意义的业务行为与进度（如：正在打开工序计划单 OP110032 [1/20]）
// 2. 现代无衬线高质感排版：Inter / Segoe UI Variable / 微软雅黑，450 细微字重，毛玻璃微光暗夜胶囊
// 3. 真实物理同心圆水波纹（Concentric Water Ripple）+ 微触光斑 + 目标矩形微光框
// 4. 全部挂载在 #__abb_hud_host 的 Shadow DOM 内，全域 pointer-events: none，0ms 阻塞，不干扰业务与快照

const HUD_BOOT_JS = `
  function __abbEnsureHud() {
    if (typeof document === 'undefined' || !document.documentElement) return null;
    let host = document.getElementById('__abb_hud_host');
    if (!host) {
      host = document.createElement('div');
      host.id = '__abb_hud_host';
      host.setAttribute('data-abb-ignore', 'true');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;';
      (document.body || document.documentElement).appendChild(host);
    }
    const root = host.shadowRoot || (host.attachShadow ? host.attachShadow({ mode: 'open' }) : host);
    
    let style = root.querySelector('style');
    if (!style) {
      style = document.createElement('style');
      root.appendChild(style);
    }
    style.textContent = \`
      :host, * { pointer-events: none !important; user-select: none !important; box-sizing: border-box; }
      
      /* 现代极简 Ego 胶囊 */
      .ego-bar {
        position: fixed;
        left: 50%;
        bottom: 24px;
        transform: translateX(-50%) translateY(0);
        display: inline-flex;
        align-items: center;
        gap: 9px;
        max-width: min(88vw, 680px);
        padding: 7px 16px 7px 14px;
        border-radius: 9999px;
        background: rgba(18, 18, 22, 0.88);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.2);
        color: #f4f4f5;
        font: 450 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, "Microsoft YaHei", sans-serif;
        letter-spacing: -0.01em;
        transition: opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1), transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
        opacity: 0;
        z-index: 2147483647;
      }
      .ego-bar.visible {
        opacity: 1;
        transform: translateX(-50%) translateY(-4px);
      }
      .ego-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex: 0 0 7px;
        background: #10b981;
        box-shadow: 0 0 8px rgba(16, 185, 129, 0.75);
        animation: ego-dot-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
      }
      .ego-dot.busy { background: #3b82f6; box-shadow: 0 0 8px rgba(59, 130, 246, 0.75); }
      .ego-dot.warn { background: #f59e0b; box-shadow: 0 0 8px rgba(245, 158, 11, 0.75); }
      .ego-dot.info { background: #06b6d4; box-shadow: 0 0 8px rgba(6, 182, 212, 0.75); }
      @keyframes ego-dot-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.55; transform: scale(1.25); }
      }
      .ego-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: #f4f4f5;
        font-weight: 450;
      }
      .ego-meta {
        margin-left: 2px;
        padding: 2px 7px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.08);
        color: #a1a1aa;
        font-size: 11.5px;
        font-family: ui-monospace, SFMono-Regular, "Segoe UI Mono", Menlo, Consolas, monospace;
        white-space: nowrap;
      }

      /* 真实同心圆水波纹 (Concentric Water Ripple) */
      @keyframes ego-wave-expand {
        0% {
          transform: translate(-50%, -50%) scale(0.15);
          opacity: 0.95;
          border-width: 2.5px;
        }
        40% {
          opacity: 0.75;
        }
        100% {
          transform: translate(-50%, -50%) scale(2.6);
          opacity: 0;
          border-width: 1px;
        }
      }
      @keyframes ego-wave-second {
        0% {
          transform: translate(-50%, -50%) scale(0.1);
          opacity: 0;
        }
        20% {
          opacity: 0.8;
          transform: translate(-50%, -50%) scale(0.45);
        }
        100% {
          transform: translate(-50%, -50%) scale(1.85);
          opacity: 0;
        }
      }
      .ego-ripple-wave {
        position: fixed;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        border: 2px solid #10b981;
        background: radial-gradient(circle, rgba(16, 185, 129, 0.28) 0%, rgba(16, 185, 129, 0.06) 50%, transparent 75%);
        box-shadow: 0 0 16px rgba(16, 185, 129, 0.45);
        animation: ego-wave-expand 0.75s cubic-bezier(0, 0.15, 0.2, 1) forwards;
        pointer-events: none !important;
        z-index: 2147483646;
      }
      .ego-ripple-wave::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 1.5px solid rgba(56, 189, 248, 0.75);
        animation: ego-wave-second 0.85s cubic-bezier(0, 0.15, 0.2, 1) forwards;
      }
      .ego-click-dot {
        position: fixed;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #ffffff;
        box-shadow: 0 0 6px #10b981, 0 0 12px #10b981;
        transform: translate(-50%, -50%);
        animation: ego-dot-fade 0.45s ease-out forwards;
        pointer-events: none !important;
        z-index: 2147483647;
      }
      @keyframes ego-dot-fade {
        0% { opacity: 1; transform: translate(-50%, -50%) scale(1.4); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.2); }
      }

      /* 目标元素轻量外框微光高亮 */
      .ego-target-box {
        position: fixed;
        border-radius: 4px;
        border: 1.5px solid rgba(16, 185, 129, 0.75);
        background: rgba(16, 185, 129, 0.08);
        box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.2);
        animation: ego-target-fade 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        pointer-events: none !important;
        z-index: 2147483645;
      }
      @keyframes ego-target-fade {
        0% { opacity: 0.95; transform: scale(0.995); }
        25% { opacity: 1; transform: scale(1); }
        100% { opacity: 0; transform: scale(1.005); }
      }
    \`;

    let layer = root.querySelector('#__abb_hud_layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = '__abb_hud_layer';
      root.appendChild(layer);
    }
    
    // 清除可能存在的旧 bar
    root.querySelectorAll('.abb-bar').forEach(b => b.remove());
    let bar = root.querySelector('.ego-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'ego-bar';
      bar.innerHTML = '<span class="ego-dot"></span><span class="ego-text"></span><span class="ego-meta" style="display:none;"></span>';
      root.appendChild(bar);
    }

    return {
      host,
      layer,
      bar,
      dot: bar.querySelector('.ego-dot'),
      text: bar.querySelector('.ego-text'),
      meta: bar.querySelector('.ego-meta')
    };
  }

  function __abbHudUpdate({ text = '', meta = '', tone = 'ok', durationMs = 3500, ripple = null, rect = null, ringColor = '#10b981' } = {}) {
    try {
      const ui = __abbEnsureHud();
      if (!ui) return;
      if (text) {
        ui.text.textContent = text;
        if (meta) {
          ui.meta.textContent = meta;
          ui.meta.style.display = 'inline-block';
        } else {
          ui.meta.style.display = 'none';
        }
        ui.dot.className = 'ego-dot' + (tone === 'busy' ? ' busy' : tone === 'warn' ? ' warn' : tone === 'info' ? ' info' : '');
        ui.bar.classList.add('visible');
        clearTimeout(window.__egoTimer);
        if (durationMs > 0) {
          window.__egoTimer = setTimeout(() => {
            try { ui.bar.classList.remove('visible'); } catch {}
          }, durationMs);
        }
      }

      // 同心圆水波纹
      if (ripple && Number.isFinite(ripple.x) && Number.isFinite(ripple.y)) {
        const wave = document.createElement('div');
        wave.className = 'ego-ripple-wave';
        wave.style.left = ripple.x + 'px';
        wave.style.top = ripple.y + 'px';
        if (ripple.color) wave.style.borderColor = ripple.color;
        ui.layer.appendChild(wave);

        const dot = document.createElement('div');
        dot.className = 'ego-click-dot';
        dot.style.left = ripple.x + 'px';
        dot.style.top = ripple.y + 'px';
        ui.layer.appendChild(dot);

        setTimeout(() => { try { wave.remove(); dot.remove(); } catch {} }, 860);
      }

      // 目标元素轻量高亮框
      if (rect && rect.width > 0 && rect.height > 0) {
        const box = document.createElement('div');
        box.className = 'ego-target-box';
        box.style.left = rect.x + 'px';
        box.style.top = rect.y + 'px';
        box.style.width = rect.width + 'px';
        box.style.height = rect.height + 'px';
        if (ringColor) box.style.borderColor = ringColor;
        ui.layer.appendChild(box);
        setTimeout(() => { try { box.remove(); } catch {} }, 720);
      }
    } catch {}
  }
`;

function isHudEnabled(cdp) {
  if (process.env.BROWSER_BRIDGE_HUD === '0' || process.env.BROWSER_BRIDGE_HUD === 'false') {
    return false;
  }
  if (!cdp || cdp.hud === false) return false;
  return Boolean(cdp.targetId || cdp.hud === true);
}

/**
 * 非阻塞发送底部进度提示与水波纹（0ms 等待，绝不拖慢主流程）。
 */
function emitHudNonBlocking(cdp, payload) {
  if (!isHudEnabled(cdp) || typeof cdp.eval !== 'function') return;
  // 清理内部标签，保留干净有意义的业务文本
  const cleanPayload = {
    text: payload.text || '',
    meta: payload.meta || (payload.badge && !/^(ABB|点击|打开单据)$/i.test(payload.badge) ? payload.badge : ''),
    tone: payload.tone || 'ok',
    durationMs: payload.durationMs ?? 3500,
    ripple: payload.ripple || null,
    rect: payload.rect || null,
    ringColor: payload.ringColor || '#10b981'
  };
  const expr = `(() => { ${HUD_BOOT_JS} __abbHudUpdate(${JSON.stringify(cleanPayload)}); return true; })()`;
  Promise.resolve(cdp.eval(expr)).catch(() => {});
}

/**
 * 显式更新底部进度胶囊状态。
 */
async function showHudStatus(cdp, text, options = {}) {
  if (!cdp || typeof cdp.evalChecked !== 'function') return { shown: false };
  const payload = {
    text: String(text || ''),
    meta: options.meta || (options.badge && !/^(ABB|点击|打开单据)$/i.test(options.badge) ? options.badge : ''),
    tone: options.tone || 'info',
    durationMs: options.durationMs ?? 4000,
    ripple: options.ripple || null,
    rect: options.rect || null,
    ringColor: options.ringColor || '#10b981',
  };
  await cdp.evalChecked(`(() => { ${HUD_BOOT_JS} __abbHudUpdate(${JSON.stringify(payload)}); return true; })()`);
  return { shown: true };
}

/**
 * 隐藏/清理页面内的 HUD 浮层。
 */
async function hideHud(cdp) {
  if (!cdp || typeof cdp.evalChecked !== 'function') return { hidden: false };
  await cdp.evalChecked(`(() => {
    const host = document.getElementById('__abb_hud_host');
    if (host) host.remove();
    return true;
  })()`);
  return { hidden: true };
}

module.exports = {
  isHudEnabled,
  emitHudNonBlocking,
  showHudStatus,
  hideHud,
  HUD_BOOT_JS,
};
