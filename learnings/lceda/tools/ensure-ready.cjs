// learnings/lceda/tools/ensure-ready.cjs - 站点工具入口：嘉立创EDA连接器一键幂等自愈
const sceneMod = require('../../../lib/cdp/scene');
const lceda = require('./lceda-actions.cjs');

module.exports = async function ensureReadyTool(args = {}) {
  const spec = sceneMod.resolveScene({ scene: args.scene || 'lceda', port: args.port });
  return lceda.ensureEasyEdaReady(spec, args);
};
