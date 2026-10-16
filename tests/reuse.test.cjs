const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { scrollContainer } = require('../lib/cdp/scroll');

test('explicit bounded scrolling rejects wrong or ambiguous containers before moving', async () => {
  const el = {
    scrollTop: 0,
    scrollHeight: 500,
    clientHeight: 100,
    getBoundingClientRect: () => ({ width: 200, height: 100 }),
    dispatchEvent() {}
  };
  let elements = [el];
  const page = {
    evalChecked: source => Promise.resolve(vm.runInNewContext(source, {
      document: { querySelectorAll: () => elements },
      Event: class {}
    }))
  };
  await assert.rejects(scrollContainer(page, '#list', 100, 'false'), /guard/);
  assert.equal(el.scrollTop, 0);
  elements = [el, el];
  await assert.rejects(scrollContainer(page, '#list', 100, 'true'), /unique/);
  assert.equal(el.scrollTop, 0);
  elements = [el];
  const result = await scrollContainer(page, '#list', 1000, 'true');
  assert.equal(result.after, 400);
  assert.equal(result.contentComplete, false);
  const end = await scrollContainer(page, '#list', 100, 'true');
  assert.equal(end.didMove, false);
});
