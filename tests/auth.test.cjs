const { test } = require('node:test');
const assert = require('node:assert/strict');
const cdp = require('../lib/cdp');

test('auth inspect and image capture stop when the context guard fails', async () => {
  let sent = 0;
  const fake = { evalChecked: async () => false, send: async () => sent++ };
  await assert.rejects(cdp.inspectAuth(fake, { guardExpression: 'false', captchaSelector: '#c' }), /guard/);
  await assert.rejects(cdp.captureUniquePng(fake, '#c', 'false'), /guard/);
  await assert.rejects(cdp.waitForUserAuth(fake, { guardExpression: 'true' }), /ready selector/);
  assert.equal(sent, 0);
});

test('auth inspect reports a blocking unique captcha', async () => {
  const fake = {
    evalChecked: async expression => {
      if (expression === 'true') return true;
      assert.match(expression, /#captcha-box/);
      assert.match(expression, /#ready/);
      return { loginVisible: false, captchaVisible: true, ready: false, blocked: true, businessWrites: 0 };
    }
  };
  const state = await cdp.inspectAuth(fake, {
    guardExpression: 'true',
    captchaSelector: '#captcha-box',
    readySelector: '#ready'
  });
  assert.equal(state.blocked, true);
  assert.equal(state.captchaVisible, true);
});

test('user auth wait times out while still blocked', async () => {
  const fake = {
    evalChecked: async expression => expression === 'true'
      ? true
      : { loginVisible: false, captchaVisible: true, ready: false, blocked: true, businessWrites: 0 }
  };
  await assert.rejects(
    cdp.waitForUserAuth(fake, {
      guardExpression: 'true',
      captchaSelector: '#c',
      readySelector: '#ready',
      timeoutMs: 20,
      intervalMs: 5,
      onWait: () => {}
    }),
    /timed out/
  );
});
