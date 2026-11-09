// 金蝶云星空只读网格提取工具 (inspect-grid.cjs)
module.exports = async function inspectGrid(args = {}, context = {}) {
  const page = context.page || context.cdp;
  if (!page || typeof page.evalChecked !== 'function') {
    throw new Error('k3cloud inspect-grid requires context.page (CDP client)');
  }
  const guard = args.guardExpression || context.defaultGuard || "location.href.toLowerCase().includes('k3cloud')";
  const maxRows = Math.max(1, Math.min(200, Number(args.maxRows) || 50));

  return page.evalChecked(`(() => {
    if (!(${guard})) throw new Error("Context guard failed before k3cloud inspect-grid");
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const headers = [...document.querySelectorAll('th, [role="columnheader"], .kd-grid-hd-cell')]
      .filter(isVisible)
      .map(el => String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean);
    const rowEls = [...document.querySelectorAll('tbody tr, [role="row"], .kd-grid-row')]
      .filter(isVisible)
      .slice(0, ${maxRows});
    const rows = rowEls.map(tr => {
      const cells = [...tr.querySelectorAll('td, [role="gridcell"], [role="cell"], .kd-grid-cell')];
      return cells.map(td => String(td.innerText || td.textContent || '').replace(/\\s+/g, ' ').trim());
    }).filter(r => r.some(Boolean));
    return { headerCount: headers.length, headers, rowCount: rows.length, rows };
  })()`);
};
