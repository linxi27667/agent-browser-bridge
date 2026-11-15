function formatSelectorLabel(selector) {
  if (typeof selector !== 'string') return '';
  const textMatch = selector.match(/text="([^"]+)"|text:\s*"?([^"\s]+)/);
  if (textMatch) return textMatch[1] || textMatch[2];
  const roleMatch = selector.match(/role:[^[]*\[name="([^"]+)"\]/);
  if (roleMatch) return roleMatch[1];
  if (selector.startsWith('@')) return selector;
  if (selector.includes('FLIST-c')) return '表格行';
  return selector;
}

const { sleep } = require('./client');
const { isClickableRect } = require('./window');
const { emitHudNonBlocking } = require('./hud');
const {
  isPlainCssSelector,
  buildFindElementsExpression,
  diagnoseSelectorMatches,
  ElementResolutionError,
} = require('./locator');

async function withOptionalUiLock(cdp, fn) {
  if (cdp && cdp.autoUiLock) {
    const { withUiLock, activateTarget } = require('./concurrency');
    return withUiLock(async () => {
      if (cdp.targetId) {
        try {
          await activateTarget(cdp.targetId, cdp.browser ? { browser: cdp.browser } : {});
        } catch {}
      }
      return fn();
    }, { port: cdp.port });
  }
  return fn();
}

function requireSelectorAndGuard(selector, guardExpression, action) {
  if (typeof selector !== 'string' || !selector.trim() || typeof guardExpression !== 'string' || !guardExpression.trim()) {
    throw new Error(action + ' requires selector and context guard');
  }
}

const MODAL_CONTAINER_SEL = '.k-window,[role="dialog"],[role="alertdialog"],dialog[open],.el-dialog,.t-dialog,.ant-modal';
const POPUP_TRIGGER_SEL = '.k-i-arrow-s,.k-i-arrow-60-down,.k-select,.k-dropdown-wrap,.kdmenuitem-splitbutton,.dropdown-toggle,[aria-haspopup],[aria-expanded]';

function selectorQuerySource(cdp, selector) {
  if (isPlainCssSelector(selector)) {
    return '(()=>{const raw=[...document.querySelectorAll(' + JSON.stringify(selector) + ')];if(raw.length<=1)return raw;const isVis=e=>{if(!e||!e.isConnected)return false;if(e.closest&&e.closest("[hidden],[inert],[aria-hidden=\\"true\\"]"))return false;const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;const s=window.getComputedStyle?window.getComputedStyle(e):null;if(!s)return true;if(s.display==="none"||s.visibility==="hidden")return false;if(Number(s.opacity)===0){const t=e.tagName==="INPUT"?String(e.type||"").toLowerCase():"";if(!((t==="checkbox"||t==="radio")&&s.pointerEvents!=="none"&&r.width>=8&&r.height>=8))return false}return true};const vis=raw.filter(isVis);if(vis.length===1)return vis;if(vis.length>1){const modals=vis.map(e=>e.closest&&e.closest(' + JSON.stringify(MODAL_CONTAINER_SEL) + ')).filter(m=>m&&isVis(m));if(modals.length){const uniq=[...new Set(modals)];let top=uniq[0],topZ=-1e9;for(const m of uniq){const z=parseFloat(window.getComputedStyle?window.getComputedStyle(m).zIndex:"0");const zv=Number.isFinite(z)?z:0;if(zv>=topZ){topZ=zv;top=m}}const inTop=vis.filter(e=>top.contains(e));if(inTop.length===1)return inTop}}return raw})()';
  }
  return buildFindElementsExpression(cdp, selector);
}

async function waitFor(cdp, expression, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000, intervalMs = options.intervalMs ?? 100;
  if (timeoutMs < 1 || timeoutMs > 300000 || intervalMs < 1) throw new Error('Invalid wait bounds');
  const deadline = Date.now() + timeoutMs;
  do { const value = await cdp.evalChecked(expression); if (value) return value; await sleep(intervalMs); } while (Date.now() < deadline);
  throw new Error('Page condition timed out');
}

async function waitForSelector(cdp, selector, guardExpression, options = {}) {
  requireSelectorAndGuard(selector, guardExpression, 'Selector wait');
  const querySrc = selectorQuerySource(cdp, selector);
  return waitFor(cdp, '(()=>{if(!(' + guardExpression + '))throw Error("Context guard failed");const es=' + querySrc + ';if(es.length!==1)return false;const r=es[0].getBoundingClientRect();return r.width>=8&&r.height>=8;})()', options);
}

async function fillNative(cdp, selector, text, guardExpression, options = {}) {
  return withOptionalUiLock(cdp, async () => {
    if (typeof selector !== 'string' || typeof text !== 'string' || typeof guardExpression !== 'string' || !guardExpression.trim()) throw new Error('Native input requires selector, string text and context guard');
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before input');
    const querySrc = selectorQuerySource(cdp, selector);
    const autoScroll = isPlainCssSelector(selector) ? '' : 'try{e.scrollIntoViewIfNeeded?e.scrollIntoViewIfNeeded():e.scrollIntoView({block:"center",inline:"nearest"})}catch{}';
    const focusInfo = await cdp.evalChecked('(()=>{const es=' + querySrc + ';if(es.length!==1)throw Error("Input must be unique");const e=es[0];' + autoScroll + 'const r=e.getBoundingClientRect();if(!r.width||e.disabled||e.readOnly)throw Error("Input unavailable");const inModal=Boolean(e.closest&&e.closest(' + JSON.stringify(MODAL_CONTAINER_SEL) + '));e.focus();if("value" in e){try{const d=window.HTMLInputElement&&Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value");if(d&&d.set&&e.tagName==="INPUT")d.set.call(e,"");else e.value=""}catch{e.value=""}if(e.select)e.select()}else if(e.isContentEditable){const rg=document.createRange();rg.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(rg)}else throw Error("Unsupported input");return {ok:true,inModal,x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()');
    const isModalObj = Boolean(focusInfo && typeof focusInfo === 'object' && focusInfo.inModal);
    const allowPhysicalFocus = options.physicalFocus === true
      || (isModalObj && focusInfo.w >= 8 && focusInfo.h >= 8 && options.physicalFocus !== false && !(cdp && cdp._backgroundCooperative));
    if (allowPhysicalFocus) {
      await ensureTargetActiveForCompositor(cdp);
      const px = focusInfo && typeof focusInfo === 'object' ? focusInfo.x : null;
      const py = focusInfo && typeof focusInfo === 'object' ? focusInfo.y : null;
      if (Number.isFinite(px) && Number.isFinite(py)) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
        await cdp.evalChecked('(()=>{const es=' + querySrc + ';if(es.length===1){const e=es[0];e.focus();if("value" in e&&e.value!==""){e.value="";if(e.select)e.select()}}return true})()');
      }
    }
    // focus/select 可能同步触发导航或候选切换，插入前再验一次
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed while focusing input');
    await cdp.evalChecked('(()=>{if(!(' + guardExpression + '))throw Error("Context changed before insertion");const es=' + querySrc + ';if(es.length!==1)throw Error("Input must be unique");const e=es[0],r=e.getBoundingClientRect();if(document.activeElement!==e||!r.width||!r.height||e.disabled||e.readOnly)throw Error("Input focus changed before insertion");return true})()');
    await cdp.send('Input.insertText', { text });
    emitHudNonBlocking(cdp, { badge: cdp.ownerTag || '输入', tone: 'info', text: `正在输入: ${selector}` });
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during input; stop before submission');
    const shouldBlur = Boolean(options.blur || options.commitBlur || (isModalObj && options.blur !== false));
    const value = await cdp.evalChecked('(()=>{const es=' + querySrc + ';if(es.length!==1)throw Error("Input changed before readback");const e=es[0];try{if(typeof Event==="function"){e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))}if(typeof KeyboardEvent==="function")e.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true,keyCode:65,which:65}));if(' + JSON.stringify(shouldBlur) + '){if(typeof FocusEvent==="function"){e.dispatchEvent(new FocusEvent("blur",{bubbles:false}));e.dispatchEvent(new FocusEvent("focusout",{bubbles:true}))}else if(typeof Event==="function"){e.dispatchEvent(new Event("blur",{bubbles:false}));e.dispatchEvent(new Event("focusout",{bubbles:true}))}}}catch{}return "value" in e?e.value:e.innerText})()');
    if (value !== text) throw new Error('Native input readback mismatch');
    return { inputVerified: true, submitted: false, blurred: shouldBlur };
  });
}

// 逐字符安全输入（严禁在 keyDown 上携带 text 或再发 char，彻底杜绝 Kendo/MVVM 输入框双倍重复字符）
async function typeKeysSafe(cdp, selector, text, guardExpression, options = {}) {
  return withOptionalUiLock(cdp, async () => {
    if (typeof selector !== 'string' || typeof text !== 'string' || typeof guardExpression !== 'string' || !guardExpression.trim()) {
      throw new Error('Safe key typing requires selector, string text and context guard');
    }
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before typing');
    const querySrc = selectorQuerySource(cdp, selector);
    const focusInfo = await cdp.evalChecked('(()=>{const es=' + querySrc + ';if(es.length!==1)throw Error("Input must be unique");const e=es[0];try{e.scrollIntoViewIfNeeded?e.scrollIntoViewIfNeeded():e.scrollIntoView({block:"center",inline:"nearest"})}catch{}const r=e.getBoundingClientRect();if(!r.width||e.disabled||e.readOnly)throw Error("Input unavailable");const inModal=Boolean(e.closest&&e.closest(' + JSON.stringify(MODAL_CONTAINER_SEL) + '));e.focus();if("value" in e){e.value="";if(e.select)e.select()}else if(e.isContentEditable){e.innerText=""}else throw Error("Unsupported input");return {ok:true,inModal,x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()');
    const isModalObj = Boolean(focusInfo && typeof focusInfo === 'object' && focusInfo.inModal);
    const allowPhysicalFocus = options.physicalFocus === true
      || (options.physicalFocus !== false && !(cdp && cdp._backgroundCooperative) && focusInfo && typeof focusInfo === 'object' && focusInfo.w >= 8 && focusInfo.h >= 8);
    if (allowPhysicalFocus) {
      await ensureTargetActiveForCompositor(cdp);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: focusInfo.x, y: focusInfo.y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: focusInfo.x, y: focusInfo.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: focusInfo.x, y: focusInfo.y, button: 'left', clickCount: 1 });
      await cdp.evalChecked('(()=>{const es=' + querySrc + ';if(es.length===1){es[0].focus();if("value" in es[0])es[0].value=""}return true})()');
    }
    const chars = Array.from(text);
    for (const ch of chars) {
      const vk = ch.toUpperCase().charCodeAt(0) || 0;
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await cdp.send('Input.insertText', { text: ch });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    }
    emitHudNonBlocking(cdp, { badge: cdp.ownerTag || '输入', tone: 'info', text: `正在键入: ${selector}` });
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during typing; stop before submission');
    const shouldBlur = Boolean(options.blur || options.commitBlur || (isModalObj && options.blur !== false));
    const value = await cdp.evalChecked('(()=>{const es=' + querySrc + ';if(es.length!==1)throw Error("Input changed before readback");const e=es[0];try{if(typeof Event==="function"){e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))}if(' + JSON.stringify(shouldBlur) + '&&typeof Event==="function"){e.dispatchEvent(new Event("blur",{bubbles:false}));e.dispatchEvent(new Event("focusout",{bubbles:true}))}}catch{}return "value" in e?e.value:e.innerText})()');
    if (value !== text) throw new Error('Safe key typing readback mismatch');
    return { inputVerified: true, typedLength: chars.length, submitted: false, blurred: shouldBlur };
  });
}

// 只读模式：page.readOnly = true（或 { denyText: [...] }）时，拒绝点击会改业务数据的按钮。
// 只按元素自身文字或所在按钮/菜单项文字“完全相等”判断，避免误伤“保存方案”之类的文字。
// 注意：只拦本库发出的点击；页面脚本自己触发的提交不在此列。
const READ_ONLY_DENY_TEXT = [
  '保存', '暂存', '提交', '审核', '反审核', '撤销', '删除', '作废', '反作废', '下推', '新增', '复制',
  '业务关闭', '反关闭', '行关闭', '整单关闭', '结案', '反结案', '强制结案', '挂起', '反挂起',
  '执行至计划确认', '执行至下达', '执行至开工', '执行至完工', '执行至结案', '生成凭证', '批改',
  'Save', 'Submit', 'Delete', 'Approve',
];

async function assertClickAllowed(cdp, querySrc, selector) {
  const policy = cdp && cdp.readOnly;
  if (!policy) return;
  const deny = (policy && Array.isArray(policy.denyText)) ? policy.denyText : READ_ONLY_DENY_TEXT;
  const label = await cdp.evalChecked('/*abb-readonly*/(()=>{const es=' + querySrc + ';if(es.length!==1)return null;const e=es[0];const own=String(e.innerText||e.value||e.getAttribute("title")||"");const item=e.closest("a,button,li,[role=button],[role=menuitem]");return {own:own.slice(0,80),item:item?String(item.innerText||"").slice(0,80):""}})()');
  if (!label) return; // 唯一性问题交给后续点击报错
  const texts = [label.own, label.item].map((s) => String(s || '').replace(/\s+/g, ''));
  const hit = deny.find((d) => texts.includes(String(d).replace(/\s+/g, '')));
  if (hit) {
    const error = new Error('Read-only mode refused click on "' + hit + '" (' + selector + ')');
    error.code = 'READ_ONLY_BLOCKED';
    error.denied = hit;
    throw error;
  }
}

async function clickNative(cdp, selector, guardExpression) {
  return withOptionalUiLock(cdp, async () => {
    requireSelectorAndGuard(selector, guardExpression, 'Native click');
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before click');
    const querySrc = selectorQuerySource(cdp, selector);
    await assertClickAllowed(cdp, querySrc, selector);
    const autoScroll = isPlainCssSelector(selector) ? '' : 'try{e.scrollIntoViewIfNeeded?e.scrollIntoViewIfNeeded():e.scrollIntoView({block:"center",inline:"nearest"})}catch{}';
    const pt = await cdp.evalChecked('(()=>{const es=' + querySrc + ';if(es.length!==1)throw Error("Click target must be unique");const e=es[0];' + autoScroll + 'const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error("Click target unavailable");e.click();return {x:r.x+r.width/2,y:r.y+r.height/2,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})()');
    emitHudNonBlocking(cdp, { text: '正在点击: ' + formatSelectorLabel(selector), tone: 'ok', ripple: { x: pt.x, y: pt.y }, rect: pt.rect });
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during click; stop before next write');
    return { clicked: true };
  });
}

async function uniqueRect(cdp, selector, label, options = {}) {
  const querySrc = selectorQuerySource(cdp, selector);
  const plain = isPlainCssSelector(selector) && !options.checkIntercept;
  const popupExpr = 'Boolean((e.matches&&e.matches(' + JSON.stringify(POPUP_TRIGGER_SEL) + '))||(e.closest&&e.closest(' + JSON.stringify(POPUP_TRIGGER_SEL) + ')))';
  let rect;
  if (plain) {
    rect = await cdp.evalChecked('(()=>{const es=' + querySrc + ';if(es.length!==1)throw Error(' + JSON.stringify(label + ' must be unique') + ');const e=es[0];try{e.scrollIntoViewIfNeeded?e.scrollIntoViewIfNeeded():e.scrollIntoView({block:"center",inline:"nearest"})}catch{}const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,isPopupTrigger:' + popupExpr + '}})()');
  } else {
    const checkHit = Boolean(options.checkIntercept);
    rect = await cdp.evalChecked('(()=>{const es=' + querySrc + ';if(es.length!==1)throw Error(' + JSON.stringify(label + ' must be unique') + ');const e=es[0];try{e.scrollIntoViewIfNeeded?e.scrollIntoViewIfNeeded():e.scrollIntoView({block:"center",inline:"nearest"})}catch{}const r=e.getBoundingClientRect();if(' + JSON.stringify(checkHit) + '&&r.width>0&&r.height>0){const cx=r.x+r.width/2,cy=r.y+r.height/2;const hit=document.elementFromPoint(cx,cy);if(hit&&hit!==e&&!e.contains(hit)&&!hit.contains(e)){const lbl=e.closest&&e.closest("label");if(!lbl||!lbl.contains(hit))throw Error(' + JSON.stringify(label + ' is intercepted by another element') + ')}}return {x:r.x,y:r.y,width:r.width,height:r.height,isPopupTrigger:' + popupExpr + '}})()');
  }
  if (!isClickableRect(rect)) throw new Error(label + ' rect is not clickable');
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, rect };
}

async function ensureTargetActiveForCompositor(cdp) {
  if (cdp && !cdp.autoUiLock && !cdp._backgroundCooperative && cdp.targetId) {
    try {
      if (cdp.browser && typeof cdp.browser.send === 'function') {
        await cdp.browser.send('Target.activateTarget', { targetId: cdp.targetId });
      } else {
        await require('./concurrency').activateTarget(cdp.targetId, { port: cdp.port });
      }
    } catch {}
  }
}

async function clickByBox(cdp, selector, guardExpression, options = {}) {
  return withOptionalUiLock(cdp, async () => {
    requireSelectorAndGuard(selector, guardExpression, 'Box click');
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before click');
    await assertClickAllowed(cdp, selectorQuerySource(cdp, selector), selector);
    await ensureTargetActiveForCompositor(cdp);
    const point = await uniqueRect(cdp, selector, 'Click target', options);
    emitHudNonBlocking(cdp, {
      text: '正在点击: ' + formatSelectorLabel(selector),
      tone: 'ok',
      ripple: { x: point.x, y: point.y },
      rect: point.rect,
    });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    const skipPark = Boolean(options.keepHover || (point.rect && point.rect.isPopupTrigger && !options.forceParkPointer));
    if (options.parkPointer && !skipPark) {
      const park = typeof options.parkPointer === 'object' ? options.parkPointer : { x: 2, y: 2 };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Number(park.x) || 2, y: Number(park.y) || 2 });
    }
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during click; stop before next write');
    return { clicked: true, x: point.x, y: point.y, parked: Boolean(options.parkPointer && !skipPark) };
  });
}

async function dragByBox(cdp, fromSelector, toSelector, guardExpression, options = {}) {
  return withOptionalUiLock(cdp, async () => {
    requireSelectorAndGuard(fromSelector, guardExpression, 'Drag');
    if (typeof toSelector !== 'string' || !toSelector.trim()) throw new Error('Drag requires selector and context guard');
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before drag');
    await ensureTargetActiveForCompositor(cdp);
    const from = await uniqueRect(cdp, fromSelector, 'Drag source', options);
    const to = await uniqueRect(cdp, toSelector, 'Drag target', options);
    emitHudNonBlocking(cdp, {
      badge: cdp.ownerTag || '拖拽',
      tone: 'info',
      text: `正在拖拽: ${fromSelector} → ${toSelector}`,
      ripple: { x: to.x, y: to.y },
    });
    const steps = Math.min(20, Math.max(3, Number(options.steps) || 8));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + (to.x - from.x) * (i / steps);
      const y = from.y + (to.y - from.y) * (i / steps);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during drag; stop before next write');
    return { dragged: true, from, to };
  });
}

async function hover(cdp, selector, guardExpression) {
  return withOptionalUiLock(cdp, async () => {
    requireSelectorAndGuard(selector, guardExpression, 'Hover');
    const querySrc = selectorQuerySource(cdp, selector);
    const point = await cdp.evalChecked('(()=>{if(!(' + guardExpression + '))throw Error("Context guard failed before hover");const es=' + querySrc + ';if(es.length!==1)throw Error("Hover target must be unique; matched "+es.length);const e=es[0];try{e.scrollIntoViewIfNeeded?e.scrollIntoViewIfNeeded():e.scrollIntoView({block:"center",inline:"nearest"})}catch{}const r=e.getBoundingClientRect();if(r.width<1||r.height<1)throw Error("Hover target unavailable");return {x:r.x+r.width/2,y:r.y+r.height/2,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})()');
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Hover target did not resolve a finite point');
    if (cdp && cdp.targetId && !cdp.autoUiLock && !cdp._focusEmulated) {
      try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); cdp._focusEmulated = true; } catch {}
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    emitHudNonBlocking(cdp, { text: '正在悬停: ' + formatSelectorLabel(selector), tone: 'info', rect: point.rect });
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during hover; stop before next write');
    return { hovered: true, x: point.x, y: point.y };
  });
}

async function resolveHoverElementObject(cdp, hoverQuery, guardExpression) {
  if (!cdp || typeof cdp.send !== 'function') return null;
  const expr = '(()=>{if(!(' + guardExpression + '))throw Error("Context guard failed before hover");const es=' + hoverQuery + ';if(es.length!==1)throw Error("Hover target must be unique; matched "+es.length);const e=es[0];try{e.scrollIntoViewIfNeeded?e.scrollIntoViewIfNeeded():e.scrollIntoView({block:"center",inline:"nearest"})}catch{}const r=e.getBoundingClientRect();if(r.width<1||r.height<1)throw Error("Hover target unavailable");return e})()';
  let evalRes;
  try {
    evalRes = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: false });
  } catch {
    return null;
  }
  if (!evalRes) return null;
  if (evalRes.exceptionDetails) {
    const raw = (evalRes.exceptionDetails.exception && (evalRes.exceptionDetails.exception.description || evalRes.exceptionDetails.exception.value)) || evalRes.exceptionDetails.text || '';
    const reason = String(raw).split('\n')[0].replace(/^Uncaught\s+/, '').replace(/^Error:\s*/, '').slice(0, 300);
    const err = new Error('Page evaluation failed; do not count action as successful' + (reason ? ': ' + reason : ''));
    err.code = 'PAGE_EVAL_FAILED';
    err.pageReason = reason;
    throw err;
  }
  return (evalRes.result && evalRes.result.objectId) || null;
}

async function ensureCssHoverDomain(cdp) {
  if (cdp._cssHoverReady) return;
  await Promise.all([
    cdp.send('DOM.enable'),
    cdp.send('CSS.enable'),
  ]);
  await cdp.send('DOM.getDocument', { depth: 0 });
  cdp._cssHoverReady = true;
}

async function dispatchSyntheticHoverEvents(cdp, objectId, leaving = false) {
  const fn = leaving
    ? `function() {
        const r = this.getBoundingClientRect();
        const base = { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, view: window };
        try {
          if (typeof PointerEvent === 'function') {
            this.dispatchEvent(new PointerEvent('pointerout', { ...base, bubbles: true, pointerType: 'mouse', isPrimary: true }));
            this.dispatchEvent(new PointerEvent('pointerleave', { ...base, bubbles: false, pointerType: 'mouse', isPrimary: true }));
          }
          this.dispatchEvent(new MouseEvent('mouseout', { ...base, bubbles: true }));
          this.dispatchEvent(new MouseEvent('mouseleave', { ...base, bubbles: false }));
        } catch {}
        return true;
      }`
    : `function() {
        const r = this.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const base = { clientX: cx, clientY: cy, view: window };
        try {
          if (typeof PointerEvent === 'function') {
            this.dispatchEvent(new PointerEvent('pointerover', { ...base, bubbles: true, pointerType: 'mouse', isPrimary: true }));
            this.dispatchEvent(new PointerEvent('pointerenter', { ...base, bubbles: false, pointerType: 'mouse', isPrimary: true }));
          }
          this.dispatchEvent(new MouseEvent('mouseover', { ...base, bubbles: true }));
          this.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
        } catch {}
        return { x: cx, y: cy };
      }`;
  const res = await cdp.send('Runtime.callFunctionOn', { objectId, returnByValue: true, functionDeclaration: fn }).catch(() => null);
  return res?.result?.value || null;
}

async function hoverAndClick(cdp, hoverSelector, clickSelector, guardExpression, options = {}) {
  return withOptionalUiLock(cdp, async () => {
    requireSelectorAndGuard(hoverSelector, guardExpression, 'Hover-and-click');
    requireSelectorAndGuard(clickSelector, guardExpression, 'Hover-and-click');
    const hoverQuery = selectorQuerySource(cdp, hoverSelector);

    let semanticObjectId = null;
    let semanticNodeId = null;
    let usedCssPseudoHover = false;

    if (!options.box) {
      semanticObjectId = await resolveHoverElementObject(cdp, hoverQuery, guardExpression);
      if (semanticObjectId) {
        try {
          let nodeRes;
          try {
            await ensureCssHoverDomain(cdp);
            nodeRes = await cdp.send('DOM.requestNode', { objectId: semanticObjectId });
          } catch {
            cdp._cssHoverReady = false;
            await ensureCssHoverDomain(cdp);
            nodeRes = await cdp.send('DOM.requestNode', { objectId: semanticObjectId });
          }
          if (nodeRes && Number.isInteger(nodeRes.nodeId) && nodeRes.nodeId > 0) {
            semanticNodeId = nodeRes.nodeId;
            await cdp.send('CSS.forcePseudoState', { nodeId: semanticNodeId, forcedPseudoClasses: ['hover'] });
            await dispatchSyntheticHoverEvents(cdp, semanticObjectId, false);
            usedCssPseudoHover = true;
          }
        } catch {
          if (semanticNodeId) {
            await cdp.send('CSS.forcePseudoState', { nodeId: semanticNodeId, forcedPseudoClasses: [] }).catch(() => {});
            semanticNodeId = null;
          }
        }
      }
    }

    try {
      if (!usedCssPseudoHover) {
        const hoverPt = await cdp.evalChecked('(()=>{if(!(' + guardExpression + '))throw Error("Context guard failed before hover");const es=' + hoverQuery + ';if(es.length!==1)throw Error("Hover target must be unique; matched "+es.length);const e=es[0];try{e.scrollIntoViewIfNeeded?e.scrollIntoViewIfNeeded():e.scrollIntoView({block:"center",inline:"nearest"})}catch{}const r=e.getBoundingClientRect();if(r.width<1||r.height<1)throw Error("Hover target unavailable");return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
        if (!hoverPt || !Number.isFinite(hoverPt.x) || !Number.isFinite(hoverPt.y)) throw new Error('Hover target did not resolve a finite point');
        if (options.box) await ensureTargetActiveForCompositor(cdp);
        else if (cdp && cdp.targetId && !cdp.autoUiLock && !cdp._focusEmulated) {
          try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); cdp._focusEmulated = true; } catch {}
        }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverPt.x, y: hoverPt.y, button: 'none' });
      }
      if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed after hover; stop before click');
      const clickQuery = selectorQuerySource(cdp, clickSelector);
      await assertClickAllowed(cdp, clickQuery, clickSelector);
      let clickPt;
      if (options.box) {
        clickPt = await uniqueRect(cdp, clickSelector, 'Click target', options);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickPt.x, y: clickPt.y });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickPt.x, y: clickPt.y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickPt.x, y: clickPt.y, button: 'left', clickCount: 1 });
      } else {
        const autoScroll = isPlainCssSelector(clickSelector) ? '' : 'try{e.scrollIntoViewIfNeeded?e.scrollIntoViewIfNeeded():e.scrollIntoView({block:"center",inline:"nearest"})}catch{}';
        clickPt = await cdp.evalChecked('(()=>{const es=' + clickQuery + ';if(es.length!==1)throw Error("Click target must be unique; matched "+es.length);const e=es[0];' + autoScroll + 'const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error("Click target unavailable");e.click();return {x:r.x+r.width/2,y:r.y+r.height/2,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})()');
      }
      emitHudNonBlocking(cdp, { text: '悬停点击: ' + formatSelectorLabel(clickSelector), tone: 'ok', ripple: { x: clickPt.x, y: clickPt.y }, rect: clickPt.rect });
      if (options.parkPointer && !options.keepHover) {
        if (usedCssPseudoHover && semanticObjectId) {
          await dispatchSyntheticHoverEvents(cdp, semanticObjectId, true);
        } else {
          const park = typeof options.parkPointer === 'object' ? options.parkPointer : { x: 2, y: 2 };
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Number(park.x) || 2, y: Number(park.y) || 2, button: 'none' });
        }
      }
      if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during click; stop before next write');
      return { hovered: true, clicked: true, x: clickPt.x, y: clickPt.y };
    } finally {
      if (semanticNodeId) {
        await cdp.send('CSS.forcePseudoState', { nodeId: semanticNodeId, forcedPseudoClasses: [] }).catch(() => {});
      }
      if (semanticObjectId) {
        await cdp.send('Runtime.releaseObject', { objectId: semanticObjectId }).catch(() => {});
      }
    }
  });
}

const ALLOWED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', downText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
};

async function pressKey(cdp, key, guardExpression) {
  return withOptionalUiLock(cdp, async () => {
    if (typeof key !== 'string' || !ALLOWED_KEYS[key]) throw new Error('pressKey only allows Enter, Tab, or Escape');
    if (typeof guardExpression !== 'string' || !guardExpression.trim()) throw new Error('pressKey requires context guard');
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before key');
    if (cdp && cdp.targetId && !cdp.autoUiLock && !cdp._focusEmulated) {
      try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); cdp._focusEmulated = true; } catch {}
    }
    const { downText, ...spec } = ALLOWED_KEYS[key];
    await cdp.send('Input.dispatchKeyEvent', downText ? { type: 'keyDown', ...spec, text: downText, unmodifiedText: downText } : { type: 'keyDown', ...spec });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec });
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during key; stop before next write');
    return { pressed: true, key };
  });
}

async function selectOption(cdp, selector, value, guardExpression) {
  requireSelectorAndGuard(selector, guardExpression, 'Select');
  if (typeof value !== 'string' || !value) throw new Error('Select requires a string value');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before select');
  const querySrc = selectorQuerySource(cdp, selector);
  const selected = await cdp.evalChecked('(()=>{const es=' + querySrc + ';if(es.length!==1)throw Error("Select must be unique");const e=es[0];if(e.tagName!=="SELECT"||e.disabled)throw Error("Select unavailable");const want=' + JSON.stringify(value) + ';const match=[...e.options].find(o=>o.value===want||o.text===want);if(!match)throw Error("Select option not found");e.value=match.value;e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));const now=e.options[e.selectedIndex];if(!now||now.value!==match.value)throw Error("Select readback mismatch");return {value:now.value,text:now.text}})()');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during select; stop before next write');
  return { selected: true, value: selected.value, text: selected.text };
}

async function readUnique(cdp, selector, guardExpression) {
  requireSelectorAndGuard(selector, guardExpression, 'Unique read');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before read');
  const querySrc = selectorQuerySource(cdp, selector);
  return cdp.evalChecked('(()=>{const es=' + querySrc + ';if(es.length!==1)throw Error("Read target must be unique");const e=es[0];return ("value" in e?e.value:e.innerText||"").trim()})()');
}

function requireTarget(targets, criteria) {
  if (!criteria || !Object.keys(criteria).some(k => ['id', 'exactUrl'].includes(k))) throw new Error('Explicit target ID or exact URL required');
  for (const key of ['id', 'exactUrl']) {
    if (Object.hasOwn(criteria, key) && (typeof criteria[key] !== 'string' || !criteria[key].trim())) throw new Error('Explicit nonempty target ID or exact URL required');
  }
  const found = targets.filter(t => t.type === 'page' && (!criteria.id || t.id === criteria.id) && (!criteria.exactUrl || t.url === criteria.exactUrl));
  if (found.length !== 1) throw new Error('Target missing or ambiguous');
  return found[0];
}

module.exports = {
  waitFor,
  waitForSelector,
  fillNative,
  typeKeysSafe,
  clickNative,
  clickByBox,
  hover,
  hoverAndClick,
  dragByBox,
  pressKey,
  selectOption,
  readUnique,
  requireTarget,
  diagnoseSelectorMatches,
  ElementResolutionError,
};
