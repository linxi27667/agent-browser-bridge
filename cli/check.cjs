#!/usr/bin/env node
const cdp = require('../lib/cdp');

(async () => {
  for (const key of ['resolveCdpHttp', 'createCdp', 'getJson', 'requireTarget', 'fillNative', 'waitFor', 'waitForSelector', 'clickNative', 'clickByBox', 'readUnique', 'inspectAuth', 'waitForUserAuth', 'captureUniquePng', 'connectBrowser', 'attachTarget']) {
    if (typeof cdp[key] !== 'function') throw new Error('Missing required API: ' + key);
  }
  if (typeof require('../lib/desktop/invokeNamedButton').invokeNamedButton !== 'function') {
    throw new Error('Missing required API: invokeNamedButton');
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
    capabilities: ['instance-identity', 'explicit-target', 'native-input', 'native-click', 'unique-read', 'selector-wait', 'user-auth-wait', 'unique-image-capture', 'desktop-named-button', 'checked-evaluation', 'bounded-wait'],
    businessWrites: 0
  }));
})().catch(error => {
  console.error(JSON.stringify({ ok: false, version: cdp.version, error: error.message }));
  process.exitCode = 1;
});
