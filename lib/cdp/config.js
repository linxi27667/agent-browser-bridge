const path = require('node:path');

function setting(env, name) {
  return env['BROWSER_BRIDGE_' + name];
}

function normalizeBrowser(value) {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (['edge', 'msedge'].includes(normalized)) return 'edge';
  if (['chrome', 'google-chrome'].includes(normalized)) return 'chrome';
  if (['chromium', 'chromium-browser'].includes(normalized)) return 'chromium';
  throw new Error('EXPECT_BROWSER must be edge, chrome, or chromium');
}

function resolveConfig(env = process.env) {
  const strict = Boolean(setting(env, 'REQUIRE_INSTANCE'));
  const endpoint = env.CDP_HTTP || (strict ? '' : 'http://127.0.0.1:9222');
  if (!endpoint) throw new Error('CDP_HTTP required for instance verification');
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('CDP endpoint must be a local HTTP root without credentials');
  }
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CDP port');
  const profile = setting(env, 'EXPECT_PROFILE');
  const proxy = setting(env, 'EXPECT_PROXY');
  const browser = normalizeBrowser(setting(env, 'EXPECT_BROWSER'));
  const attachExisting = ['1', 'true', 'yes'].includes(String(setting(env, 'ATTACH_EXISTING') || '').toLowerCase());
  if (strict && (!profile || !proxy || !browser)) throw new Error('EXPECT_PROFILE, EXPECT_PROXY, and EXPECT_BROWSER required in strict mode');
  if (profile && !path.isAbsolute(profile)) throw new Error('Profile must be absolute');
  if (attachExisting) {
    if (process.platform !== 'win32' || !strict || browser !== 'edge') throw new Error('ATTACH_EXISTING requires strict verification on Windows and Microsoft Edge');
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData) throw new Error('ATTACH_EXISTING requires the Windows LOCALAPPDATA path');
    const expectedDefault = path.resolve(localAppData, 'Microsoft', 'Edge', 'User Data');
    const actualProfile = profile && path.resolve(profile);
    if (!actualProfile || (process.platform === 'win32' ? actualProfile.toLowerCase() !== expectedDefault.toLowerCase() : actualProfile !== expectedDefault)) {
      throw new Error('ATTACH_EXISTING is limited to the current Windows user\'s default Edge User Data directory');
    }
  }
  return { endpoint: url.origin, port, strict, profile, proxy, browser, attachExisting };
}

function resolveCdpHttp(env = process.env) {
  return resolveConfig(env).endpoint;
}

module.exports = { resolveConfig, resolveCdpHttp, normalizeBrowser };
