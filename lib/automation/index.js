const { normalizeOptions, fail } = require('./errors');
const { createBrowser } = require('./browser');

function routeTask(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_ARGS', 'Route input must be an object');
  if (input.api) return { route: 'api', reason: 'Use the available API or CLI before UI automation' };
  if (input.file) return { route: 'file', reason: 'Read or transform the file directly before driving an application' };
  if (input.url) {
    let url;
    try { url = new URL(input.url); } catch { throw fail('INVALID_ARGS', 'Route URL must be valid HTTP or HTTPS'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw fail('INVALID_ARGS', 'Route URL must use HTTP or HTTPS');
    return { route: 'browser', reason: 'Use the dedicated browser bridge for web content' };
  }
  if (input.visual) return { route: 'visual', reason: 'Inspect capabilities first; coordinate input needs exclusive mode' };
  if (input.app) return { route: 'desktop', reason: 'Use native accessibility controls when the application exposes them' };
  return { route: 'clarify', reason: 'Provide an API, file, URL, or explicit application target' };
}

function createAutomation(options = {}, dependencies = {}) {
  const policy = normalizeOptions(options);
  const factory = dependencies.createDesktopClient || require('../desktop/agentDesktop').createDesktopClient;
  return Object.freeze({
    desktop: factory(policy),
    browser: createBrowser(policy, dependencies.cdp),
    routeTask,
  });
}

async function doctor(options = {}, dependencies = {}) {
  const policy = normalizeOptions(options);
  const desktop = createAutomation(policy, dependencies).desktop;
  let desktopReport = { available: false, ready: false };
  try {
    desktopReport.version = await desktop.adVersion();
    desktopReport.available = true;
    const status = await desktop.adStatus();
    desktopReport.platform = status.platform || status.os;
    const accessibility = status.accessibility || status.permissions?.accessibility;
    desktopReport.accessibility = accessibility?.state || accessibility || 'unknown';
    desktopReport.ready = ['granted', 'not_required'].includes(desktopReport.accessibility);
  } catch (error) {
    desktopReport.ready = false;
    if (error.code === 'DESKTOP_VERSION_MISMATCH') desktopReport.available = true;
    desktopReport.error = require('./errors').serializeError(error);
  }
  let browser;
  try {
    const config = require('../cdp/config').resolveConfig();
    browser = { configured: Boolean(config.strict && config.profile && config.browser && config.proxy && !config.attachExisting) };
    if (browser.configured) browser = { ...browser, endpoint: config.endpoint, browser: config.browser };
  } catch (error) {
    browser = { configured: false, error: 'Invalid browser identity configuration' };
  }
  return { node: process.versions.node, projectVersion: require('../../package.json').version, config: options.configInfo, policy: { mode: policy.mode, readOnly: policy.readOnly }, desktop: desktopReport, browser };
}

module.exports = { createAutomation, routeTask, doctor, ...require('./workflow'), ...require('./config') };
