// learnings/lceda/tools/status.cjs - 站点工具入口：只读查询嘉立创EDA连接器与页面扩展状态
const sceneMod = require('../../../lib/cdp/scene');
const lceda = require('./lceda-actions.cjs');

module.exports = async function statusTool(args = {}, context = {}) {
  if (context.page && typeof context.page.evalChecked === 'function') {
    const [daemon, editor] = await Promise.all([
      lceda.readDaemonHealth(args),
      lceda.readEditorExtensionStatus(context.page),
    ]);
    return {
      ok: Boolean(daemon.daemonOk && daemon.connectorOk && editor.loggedIn),
      daemon,
      editor,
    };
  }
  const spec = sceneMod.resolveScene({ scene: args.scene || 'lceda', port: args.port });
  return lceda.getFullLcedaStatus(spec, args);
};
