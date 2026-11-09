// 电子税务局全量发票表格只读提取与规整工具 (parse-invoices.cjs)
function normalizeRow(cells, source) {
  if (!Array.isArray(cells) || cells.length < 10) return null;
  if (!/^\d+$/.test(cells[0])) return null;
  if (cells.length >= 21) {
    return {
      source,
      seq: cells[0],
      invoiceType: cells[1],
      invoiceNo: cells[2],
      legacyCode: cells[3],
      legacyNo: cells[4],
      sellerTaxId: cells[5],
      sellerName: cells[6],
      buyerTaxId: cells[7],
      buyerName: cells[8],
      issueTime: cells[9],
      amountExclTax: cells[10],
      taxAmount: cells[11],
      totalAmount: cells[12],
      invoiceSource: cells[13],
      invoiceCategory: cells[14],
      status: cells[15],
      positiveNegative: cells[16],
      riskLevel: cells[17],
      issuer: cells[18],
      remark: cells[19],
    };
  }
  return {
    source,
    seq: cells[0],
    invoiceType: cells[1],
    invoiceNo: cells[2],
    sellerTaxId: cells[3],
    sellerName: cells[4],
    buyerTaxId: cells[5],
    buyerName: cells[6],
    issueTime: cells[7],
    amountExclTax: cells[8],
    taxAmount: cells[9],
    totalAmount: cells[10],
    invoiceSource: cells[11] || '',
    invoiceCategory: cells[12] || '',
    status: cells[13] || '',
    positiveNegative: cells[14] || '',
    riskLevel: cells[15] || '',
    issuer: cells[16] || '',
    remark: cells[17] || '',
  };
}

module.exports = async function parseInvoices(args = {}, context = {}) {
  const page = context.page || context.cdp;
  if (!page || typeof page.evalChecked !== 'function') {
    throw new Error('etax-gd parse-invoices requires context.page (CDP client)');
  }
  const guard = args.guardExpression || context.defaultGuard || "location.hostname.endsWith('.chinatax.gov.cn')";
  const source = args.source || 'etax';

  const raw = await page.evalChecked(`(() => {
    if (!(${guard})) throw new Error("Context guard failed before etax parse-invoices");
    const totalText = document.body.innerText.match(/共\\s*(\\d+)\\s*条/);
    const rows = [...document.querySelectorAll('.t-table__body tr, tbody tr')].map(tr => {
      const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.replace(/\\s+/g, ' ').trim());
      return cells.length > 5 ? cells : null;
    }).filter(Boolean);
    return {
      totalCount: totalText ? Number(totalText[1]) : rows.length,
      rows,
    };
  })()`);

  const invoices = (raw.rows || []).map((cells) => normalizeRow(cells, source)).filter(Boolean);
  return {
    totalCount: raw.totalCount,
    parsedCount: invoices.length,
    invoices,
  };
};

module.exports.normalizeRow = normalizeRow;
