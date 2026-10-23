#!/usr/bin/env node
const cdp = require('../lib/cdp');

(async () => {
  for (const key of ['resolveCdpHttp', 'createCdp', 'getJson', 'requireTarget', 'fillNative', 'waitFor', 'connectBrowser', 'attachTarget']) {
    if (typeof cdp[key] !== 'function') throw new Error('Missing required API: ' + key);
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
    capabilities: ['instance-identity', 'explicit-target', 'native-input', 'checked-evaluation', 'bounded-wait'],
    businessWrites: 0
  }));
})().catch(error => {
  console.error(JSON.stringify({ ok: false, version: cdp.version, error: error.message }));
  process.exitCode = 1;
});
