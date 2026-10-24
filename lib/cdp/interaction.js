const { sleep } = require('./client');
const { isClickableRect } = require('./window');

function requireSelectorAndGuard(selector, guardExpression, action) {
  if (typeof selector !== 'string' || !selector.trim() || typeof guardExpression !== 'string' || !guardExpression.trim()) {
    throw new Error(action + ' requires selector and context guard');
  }
}

async function waitFor(cdp, expression, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000, intervalMs = options.intervalMs ?? 100;
  if (timeoutMs < 1 || timeoutMs > 60000 || intervalMs < 1) throw new Error('Invalid wait bounds');
  const deadline = Date.now() + timeoutMs;
  do { const value = await cdp.evalChecked(expression); if (value) return value; await sleep(intervalMs); } while (Date.now() < deadline);
  throw new Error('Page condition timed out');
}

async function waitForSelector(cdp, selector, guardExpression, options = {}) {
  requireSelectorAndGuard(selector, guardExpression, 'Selector wait');
  return waitFor(cdp, '(()=>{if(!(' + guardExpression + '))throw Error("Context guard failed");const es=document.querySelectorAll(' + JSON.stringify(selector) + ');if(es.length!==1)return false;const r=es[0].getBoundingClientRect();return r.width>=8&&r.height>=8;})()', options);
}

async function fillNative(cdp, selector, text, guardExpression) {
  if (typeof selector !== 'string' || typeof text !== 'string' || typeof guardExpression !== 'string' || !guardExpression.trim()) throw new Error('Native input requires selector, string text and context guard');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before input');
  await cdp.evalChecked('(()=>{const es=document.querySelectorAll(' + JSON.stringify(selector) + ');if(es.length!==1)throw Error("Input must be unique");const e=es[0];if(!e.getBoundingClientRect().width||e.disabled||e.readOnly)throw Error("Input unavailable");e.focus();if("value" in e){e.select()}else if(e.isContentEditable){const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r)}else throw Error("Unsupported input");return true})()');
  await cdp.send('Input.insertText', { text });
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during input; stop before submission');
  const value = await cdp.evalChecked('(()=>{const e=document.querySelector(' + JSON.stringify(selector) + ');return "value" in e?e.value:e.innerText})()');
  if (value !== text) throw new Error('Native input readback mismatch');
  return { inputVerified: true, submitted: false };
}

async function clickNative(cdp, selector, guardExpression) {
  requireSelectorAndGuard(selector, guardExpression, 'Native click');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before click');
  await cdp.evalChecked('(()=>{const es=document.querySelectorAll(' + JSON.stringify(selector) + ');if(es.length!==1)throw Error("Click target must be unique");const e=es[0];const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error("Click target unavailable");e.click();return true})()');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during click; stop before next write');
  return { clicked: true };
}

async function uniqueRect(cdp, selector, label) {
  const rect = await cdp.evalChecked('(()=>{const es=document.querySelectorAll(' + JSON.stringify(selector) + ');if(es.length!==1)throw Error(' + JSON.stringify(label + ' must be unique') + ');const r=es[0].getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
  if (!isClickableRect(rect)) throw new Error(label + ' rect is not clickable');
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function clickByBox(cdp, selector, guardExpression) {
  requireSelectorAndGuard(selector, guardExpression, 'Box click');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before click');
  const point = await uniqueRect(cdp, selector, 'Click target');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during click; stop before next write');
  return { clicked: true, x: point.x, y: point.y };
}

async function dragByBox(cdp, fromSelector, toSelector, guardExpression, options = {}) {
  requireSelectorAndGuard(fromSelector, guardExpression, 'Drag');
  if (typeof toSelector !== 'string' || !toSelector.trim()) throw new Error('Drag requires selector and context guard');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before drag');
  const from = await uniqueRect(cdp, fromSelector, 'Drag source');
  const to = await uniqueRect(cdp, toSelector, 'Drag target');
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
}

const ALLOWED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
};

async function pressKey(cdp, key, guardExpression) {
  if (typeof key !== 'string' || !ALLOWED_KEYS[key]) throw new Error('pressKey only allows Enter, Tab, or Escape');
  if (typeof guardExpression !== 'string' || !guardExpression.trim()) throw new Error('pressKey requires context guard');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before key');
  const spec = ALLOWED_KEYS[key];
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec });
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during key; stop before next write');
  return { pressed: true, key };
}

async function selectOption(cdp, selector, value, guardExpression) {
  requireSelectorAndGuard(selector, guardExpression, 'Select');
  if (typeof value !== 'string' || !value) throw new Error('Select requires a string value');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before select');
  const selected = await cdp.evalChecked('(()=>{const es=document.querySelectorAll(' + JSON.stringify(selector) + ');if(es.length!==1)throw Error("Select must be unique");const e=es[0];if(e.tagName!=="SELECT"||e.disabled)throw Error("Select unavailable");const want=' + JSON.stringify(value) + ';const match=[...e.options].find(o=>o.value===want||o.text===want);if(!match)throw Error("Select option not found");e.value=match.value;e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));const now=e.options[e.selectedIndex];if(!now||now.value!==match.value)throw Error("Select readback mismatch");return {value:now.value,text:now.text}})()');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during select; stop before next write');
  return { selected: true, value: selected.value, text: selected.text };
}

async function readUnique(cdp, selector, guardExpression) {
  requireSelectorAndGuard(selector, guardExpression, 'Unique read');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before read');
  return cdp.evalChecked('(()=>{const es=document.querySelectorAll(' + JSON.stringify(selector) + ');if(es.length!==1)throw Error("Read target must be unique");const e=es[0];return ("value" in e?e.value:e.innerText||"").trim()})()');
}

function requireTarget(targets, criteria) {
  if (!criteria || !Object.keys(criteria).some(k => ['id', 'exactUrl'].includes(k))) throw new Error('Explicit target ID or exact URL required');
  const found = targets.filter(t => t.type === 'page' && (!criteria.id || t.id === criteria.id) && (!criteria.exactUrl || t.url === criteria.exactUrl));
  if (found.length !== 1) throw new Error('Target missing or ambiguous');
  return found[0];
}
module.exports = { waitFor, waitForSelector, fillNative, clickNative, clickByBox, dragByBox, pressKey, selectOption, readUnique, requireTarget };
