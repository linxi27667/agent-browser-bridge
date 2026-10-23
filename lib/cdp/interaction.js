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

async function clickByBox(cdp, selector, guardExpression) {
  requireSelectorAndGuard(selector, guardExpression, 'Box click');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before click');
  const rect = await cdp.evalChecked('(()=>{const es=document.querySelectorAll(' + JSON.stringify(selector) + ');if(es.length!==1)throw Error("Click target must be unique");const r=es[0].getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
  if (!isClickableRect(rect)) throw new Error('Click target rect is not clickable');
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context changed during click; stop before next write');
  return { clicked: true, x, y };
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
module.exports = { waitFor, waitForSelector, fillNative, clickNative, clickByBox, readUnique, requireTarget };
