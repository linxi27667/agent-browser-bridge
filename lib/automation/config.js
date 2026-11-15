const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fail } = require('./errors');

function defaultConfigPath(env = process.env) {
  return env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, 'AgentBrowserBridge', 'automation.json')
    : path.join(os.homedir(), '.config', 'agent-browser-bridge', 'automation.json');
}

function loadLocalConfig(options = {}, env = process.env) {
  const configPath = path.resolve(options.configPath || defaultConfigPath(env));
  let config = {};
  let loaded = true;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT' && !options.configPath) loaded = false;
    else throw fail('CONFIG_INVALID', 'The local automation configuration is missing or invalid JSON');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw fail('CONFIG_INVALID', 'The local automation configuration must be an object');
  const allowed = {
    desktop: ['binaryPath', 'expectedVersion', 'desktopHome'],
    browser: ['endpoint', 'profile', 'browser', 'proxy'],
  };
  for (const [section, value] of Object.entries(config)) {
    if (section === 'scenes') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw fail('CONFIG_INVALID', 'Local configuration scenes section must be an object');
      }
      for (const sceneCfg of Object.values(value)) {
        if (!sceneCfg || typeof sceneCfg !== 'object' || Array.isArray(sceneCfg)) {
          throw fail('CONFIG_INVALID', 'Each local scene configuration entry must be an object');
        }
        for (const [sKey, sVal] of Object.entries(sceneCfg)) {
          if (!['defaultUrl', 'urlIncludes', 'orgKeyword'].includes(sKey) || typeof sVal !== 'string' || !sVal.trim()) {
            throw fail('CONFIG_INVALID', 'Local scene configuration contains an unsupported or invalid field');
          }
        }
      }
      continue;
    }
    if (!allowed[section] || !value || typeof value !== 'object' || Array.isArray(value)) throw fail('CONFIG_INVALID', 'Local configuration only accepts desktop, browser, and scenes connection fields');
    for (const [key, field] of Object.entries(value)) {
      if (!allowed[section].includes(key) || typeof field !== 'string' || !field.trim()) throw fail('CONFIG_INVALID', 'Local configuration contains an unsupported or invalid field');
    }
  }
  if (!env.ABB_K3_URL && config.scenes?.k3?.defaultUrl) env.ABB_K3_URL = config.scenes.k3.defaultUrl;
  if (!env.ABB_K3_ADMIN_URL && config.scenes?.['k3-admin']?.defaultUrl) env.ABB_K3_ADMIN_URL = config.scenes['k3-admin'].defaultUrl;
  if (!env.ETAX_ORG_KEYWORD && config.scenes?.etax?.orgKeyword) env.ETAX_ORG_KEYWORD = config.scenes.etax.orgKeyword;
  const fields = {
    endpoint: 'CDP_HTTP', profile: 'BROWSER_BRIDGE_EXPECT_PROFILE',
    browser: 'BROWSER_BRIDGE_EXPECT_BROWSER', proxy: 'BROWSER_BRIDGE_EXPECT_PROXY',
  };
  for (const [field, name] of Object.entries(fields)) {
    if (!env[name] && config.browser?.[field]) env[name] = config.browser[field];
  }
  if (config.browser && !env.BROWSER_BRIDGE_REQUIRE_INSTANCE) env.BROWSER_BRIDGE_REQUIRE_INSTANCE = '1';
  return {
    options: {
      ...config.desktop,
      ...(env.AGENT_DESKTOP_BIN ? { binaryPath: env.AGENT_DESKTOP_BIN } : {}),
      ...(env.AGENT_DESKTOP_EXPECT_VERSION ? { expectedVersion: env.AGENT_DESKTOP_EXPECT_VERSION } : {}),
      ...(env.AGENT_DESKTOP_HOME ? { desktopHome: env.AGENT_DESKTOP_HOME } : {}),
      ...options,
    },
    config: { path: configPath, loaded },
  };
}

module.exports = { defaultConfigPath, loadLocalConfig };
