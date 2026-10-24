#!/usr/bin/env node
const cdp = require('../lib/cdp');

(async () => {
  for (const key of ['resolveCdpHttp', 'createCdp', 'getJson', 'requireTarget', 'fillNative', 'waitFor', 'waitForSelector', 'clickNative', 'clickByBox', 'dragByBox', 'pressKey', 'selectOption', 'readUnique', 'inspectAuth', 'waitForUserAuth', 'captureUniquePng', 'connectBrowser', 'attachTarget']) {
    if (typeof cdp[key] !== 'function') throw new Error('Missing required API: ' + key);
  }
  const desktop = require('../lib/desktop');
  for (const key of ['invokeNamedButton', 'focusNamedWindow', 'sendKeysToNamedWindow', 'captureNamedWindow']) {
    if (typeof desktop[key] !== 'function') throw new Error('Missing required API: ' + key);
  }
  const identity = await cdp.identity.verify();
  const info = await cdp.getJson('/json/version');
  console.log(JSON.stringify({
    ok: true,
    version: cdp.version,
    identity: {
      ok: identity.ok,
      browser: identity.browser,
      port: identity.port,
      proxy: identity.proxy,
      loopback: identity.loopback
    },
    protocol: info['Protocol-Version'],
    browserVersion: info.Browser,
    capabilities: ['instance-identity', 'explicit-target', 'native-input', 'native-click', 'box-drag', 'named-key', 'select-option', 'unique-read', 'selector-wait', 'user-auth-wait', 'unique-image-capture', 'desktop-named-button', 'desktop-named-window', 'local-debug-proxy', 'checked-evaluation', 'bounded-wait'],
    businessWrites: 0
  }));
})().catch(error => {
  console.error(JSON.stringify({ ok: false, version: cdp.version, error: error.message }));
  process.exitCode = 1;
});
