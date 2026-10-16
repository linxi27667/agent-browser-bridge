const { sleep } = require('./client');
async function waitFor(cdp, expression, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000, intervalMs = options.intervalMs ?? 100;
  if (timeoutMs < 1 || timeoutMs > 60000 || intervalMs < 1) throw new Error('Invalid wait bounds');
  const deadline = Date.now() + timeoutMs;
  do { const value = await cdp.evalChecked(expression); if (value) return value; await sleep(intervalMs); } while (Date.now() < deadline);
  throw new Error('Page condition timed out');
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
function requireTarget(targets, criteria) {
  if (!criteria || !Object.keys(criteria).some(k => ['id', 'exactUrl'].includes(k))) throw new Error('Explicit target ID or exact URL required');
  const found = targets.filter(t => t.type === 'page' && (!criteria.id || t.id === criteria.id) && (!criteria.exactUrl || t.url === criteria.exactUrl));
  if (found.length !== 1) throw new Error('Target missing or ambiguous');
  return found[0];
}
module.exports = { waitFor, fillNative, requireTarget };
