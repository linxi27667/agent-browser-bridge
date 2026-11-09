// 金蝶云星空：按菜单打开列表 → 按单据编号过滤 → 打开单据（只读），可选打开序列号查询
// 以“修改”模式打开且未审核的单据，默认读完立即关闭，避免占用同事的网控锁（keepOpen: true 可保留）
const k3 = require('./k3-actions.cjs');

module.exports = async function openBillTool(args = {}, context = {}) {
  const page = context.page || context.cdp;
  if (!page || typeof page.evalChecked !== 'function') throw new Error('k3cloud open-bill requires context.page (CDP client)');
  if (!args.menuQuery || !args.billNo) throw new Error('k3cloud open-bill requires args.menuQuery and args.billNo');
  const opts = { guard: args.guardExpression || k3.K3_GUARD };

  const list = await k3.openListBySearch(page, { query: args.menuQuery, needle: args.needle || args.menuQuery, exclude: args.exclude }, opts);
  const filter = await k3.filterByBillNo(page, args.billNo, opts);
  if (!filter.found) return { list, filter, opened: false };

  const state = await k3.openBill(page, args.billNo, opts);
  let serial = null;
  if (args.serial) serial = await k3.openSerialView(page, opts);

  let closedForSafety = false;
  if (state.editable && !args.keepOpen) {
    closedForSafety = await k3.closeActiveBillTab(page, opts);
  }
  return { list, filter, opened: true, state, serial, closedForSafety };
};
