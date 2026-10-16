// Scroll only an explicit container; do not read page content or click anything.
async function scrollContainer(page, selector, deltaY, guardExpression) {
  if (!page?.evalChecked || typeof selector !== 'string' || !selector.trim() ||
      !Number.isFinite(deltaY) || Math.abs(deltaY) > 10000 ||
      typeof guardExpression !== 'string' || !guardExpression.trim()) {
    throw new Error('Explicit container, bounded delta and context guard required');
  }
  return page.evalChecked(`(() => {
    if (!(${guardExpression})) throw Error('Scroll context guard failed');
    const matches = document.querySelectorAll(${JSON.stringify(selector)});
    if (matches.length !== 1) throw Error('Scroll container must be unique');
    const el = matches[0], r = el.getBoundingClientRect();
    if (!r.width || !r.height || !el.clientHeight) throw Error('Scroll container unavailable');
    const before = el.scrollTop, max = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.max(0, Math.min(max, before + ${deltaY}));
    el.dispatchEvent(new Event('scroll', {bubbles: false}));
    return {before, after: el.scrollTop, maxScrollTop: max,
      didMove: el.scrollTop !== before, atEnd: el.scrollTop >= max - 1,
      contentComplete: false, businessWrites: 0};
  })()`);
}
module.exports = {scrollContainer};
