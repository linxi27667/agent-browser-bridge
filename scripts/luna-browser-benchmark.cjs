const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const repo = path.resolve(__dirname, '..');
const artifactDir = path.join(repo, 'artifacts', 'luna-browser-benchmark');
const fixturePath = path.join(repo, 'tests', 'fixtures', 'luna-browser-benchmark.html');
const html = fs.readFileSync(fixturePath, 'utf8');
const startedAt = new Date().toISOString();
const wallStarted = performance.now();
const setup = require('../lib/automation/config').loadLocalConfig();
const { connectBrowser, attachTarget } = require('../lib/cdp/client');
const cdp = require('../lib/cdp');
const { runWorkflow } = require('../lib/automation');

const guard = `location.href === 'about:blank' && document.title === 'Luna Bench - Expense Approvals' && document.querySelector('#expense-app')?.dataset.benchmark === 'luna-v1'`;
const expectedCsv = [
  '单号,申请人,部门,数量,单价,金额',
  'BX-26015,测试申请人甲,研发部,2,120.00,240.00',
  'BX-26017,测试申请人甲,研发部,1,800.00,800.00',
  'BX-26020,测试申请人甲,研发部,4,32.00,128.00',
  'BX-26021,测试申请人甲,研发部,2,300.00,600.00',
  '合计,,,9,,1768.00',
].join('\n');

function checkedRef(snap, id) {
  const ref = snap.refs.find(item => item.loc === `css:#${id}`);
  return ref?.checked === true;
}

async function setFixture(browser, targetId) {
  const page = await attachTarget(browser, targetId);
  try {
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.setDocumentContent', { frameId: (await page.send('Page.getFrameTree')).frameTree.frame.id, html });
    const verified = await page.evalChecked(`document.title === 'Luna Bench - Expense Approvals' && document.querySelector('#expense-app')?.dataset.benchmark === 'luna-v1'`);
    if (verified !== true) throw new Error('Fixture setup readback failed');
  } finally {
    page.close();
  }
}

async function executeRound(targetId) {
  let observedCsv;
  const report = await runWorkflow(async ({ browser, step }) => {
    await browser.withLeasedTarget({ id: targetId }, async page => {
      await step('填写中文申请人', () => page.fillNative('#applicant', '测试申请人甲', guard), v => v.inputVerified === true);
      await step('选择研发部门', () => page.selectOption('#department', '研发部', guard), v => v.selected && v.value === '研发部');
      await step('选择待审批状态', () => page.selectOption('#status', '待审批', guard), v => v.selected && v.value === '待审批');
      await step('勾选合规票据条件', async () => {
        await page.clickNative('#hasReceipt', guard);
        return page.snapshot(guard, { interactiveOnly: true });
      }, v => checkedRef(v, 'hasReceipt'));
      await step('提交查询条件', () => page.clickNative('#search', guard), v => v.clicked === true);
      await step('等待异步查询表格', () => page.waitForSelector('#row-BX-26015', guard, { timeoutMs: 8000 }), Boolean);
      await step('核对查询结果数量', () => page.readUnique('#summary', guard), v => v === '查询完成：4 条费用记录');
      await step('按金额升序查看明细', async () => {
        await page.clickNative('#sortAmount', guard);
        return page.readUnique('#rows tr:first-child', guard);
      }, v => v.includes('BX-26020') && v.includes('128.00'));
      await step('清除金额排序并核对恢复', async () => {
        await page.clickNative('#clearSort', guard);
        return page.readUnique('#rows tr:first-child', guard);
      }, v => v.includes('BX-26015') && v.includes('240.00'));
      await step('选择第一页报销单26015', async () => {
        await page.clickNative('#pick-BX-26015', guard);
        return page.snapshot(guard, { interactiveOnly: true });
      }, v => checkedRef(v, 'pick-BX-26015'));
      await step('选择第一页报销单26017', async () => {
        await page.clickNative('#pick-BX-26017', guard);
        return page.snapshot(guard, { interactiveOnly: true });
      }, v => checkedRef(v, 'pick-BX-26017'));
      await step('翻到第二页', () => page.clickNative('#next', guard), v => v.clicked === true);
      await step('等待第二页动态记录', () => page.waitForSelector('#row-BX-26020', guard, { timeoutMs: 5000 }), Boolean);
      await step('核对第二页单号', () => page.readUnique('#row-BX-26020', guard), v => v.includes('BX-26020'));
      await step('选择第二页报销单26021', async () => {
        await page.clickNative('#pick-BX-26021', guard);
        return page.snapshot(guard, { interactiveOnly: true });
      }, v => checkedRef(v, 'pick-BX-26021'));
      await step('选择第二页报销单26020', async () => {
        await page.clickNative('#pick-BX-26020', guard);
        return page.snapshot(guard, { interactiveOnly: true });
      }, v => checkedRef(v, 'pick-BX-26020'));
      await step('打开批次确认弹窗', () => page.clickNative('#makeBatch', guard), v => v.clicked === true);
      await step('等待确认弹窗出现', () => page.waitForSelector('#modal', guard, { timeoutMs: 3000 }), Boolean);
      await step('核对弹窗单数', () => page.readUnique('#modalCount', guard), v => v === '4');
      await step('核对弹窗数量合计', () => page.readUnique('#modalQty', guard), v => v === '9');
      await step('核对弹窗金额合计', () => page.readUnique('#modalAmount', guard), v => v === '1768.00');
      await step('确认生成审批批次', async () => {
        await page.clickNative('#confirm', guard);
        await page.waitForSelector('#result', guard, { timeoutMs: 3000 });
        return page.readUnique('#result', guard);
      }, v => v === '批次审批-20261115-001 已生成：4 单，9 件，1768.00 元');
      await step('导出并回读审批清单', async () => {
        await page.clickNative('#export', guard);
        await page.waitForSelector('#exportText', guard, { timeoutMs: 3000 });
        observedCsv = await page.readUnique('#exportText', guard);
        return observedCsv;
      }, v => v === expectedCsv);
    });
  }, { ...setup.options, mode: 'cooperative', readOnly: false, timeoutMs: 30000 });
  return { report, observedCsv };
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const rounds = [];
  let browser;
  let targetId;
  let coldPreparationMs = 0;
  try {
    const coldStart = performance.now();
    await cdp.identity.verify();
    browser = await connectBrowser({ quiet: true });
    const created = await browser.send('Target.createTarget', { url: 'about:blank', background: true });
    targetId = created.targetId;
    await setFixture(browser, targetId);
    coldPreparationMs = Math.round(performance.now() - coldStart);

    for (let index = 1; index <= 3; index += 1) {
      const prepareStart = performance.now();
      if (index > 1) await setFixture(browser, targetId);
      const preparationMs = Math.round(performance.now() - prepareStart);
      const executionStart = performance.now();
      const { report, observedCsv } = await executeRound(targetId);
      const executionMs = Math.round(performance.now() - executionStart);
      rounds.push({
        round: index,
        preparationMs,
        executionMs,
        workflowDurationMs: report.durationMs,
        status: report.status,
        ok: report.ok,
        verifiedSteps: report.steps.filter(s => s.status === 'verified').length,
        failedSteps: report.steps.filter(s => s.status !== 'verified').map(s => ({ name: s.name, status: s.status, error: s.error })),
        observedCsv,
        steps: report.steps,
      });
      if (!report.ok || report.status !== 'verified' || rounds.at(-1).verifiedSteps !== 23) break;
    }

    const independentExpected = [
      { id: 'BX-26015', qty: 2, price: 120 },
      { id: 'BX-26017', qty: 1, price: 800 },
      { id: 'BX-26020', qty: 4, price: 32 },
      { id: 'BX-26021', qty: 2, price: 300 },
    ];
    const independentTotalQty = independentExpected.reduce((n, row) => n + row.qty, 0);
    const independentTotalAmount = independentExpected.reduce((n, row) => n + row.qty * row.price, 0);
    const exportedLines = String(rounds.at(-1)?.observedCsv || '').split(/\r?\n/);
    const parsedExportRecords = exportedLines.slice(1, -1).map(line => {
      const [id, applicant, department, qty, price, amount] = line.split(',');
      return { id, applicant, department, qty: Number(qty), price: Number(price), amount: Number(amount) };
    });
    const exportedTotal = exportedLines.at(-1)?.split(',');
    const exportMatchesOracle = JSON.stringify(parsedExportRecords.map(row => ({ id: row.id, qty: row.qty, price: row.price }))) === JSON.stringify(independentExpected) && parsedExportRecords.every(row => row.applicant === '测试申请人甲');
    const independentlyVerified = independentTotalQty === 9 && independentTotalAmount === 1768 &&
      parsedExportRecords.reduce((sum, row) => sum + row.amount, 0) === independentTotalAmount &&
      parsedExportRecords.reduce((sum, row) => sum + row.qty, 0) === independentTotalQty &&
      exportedTotal?.[0] === '合计' && Number(exportedTotal?.[3]) === independentTotalQty && Number(exportedTotal?.[5]) === independentTotalAmount;
    const result = {
      benchmark: 'Luna 0.8.0 complex browser workflow',
      projectVersion: require('../package.json').version,
      node: process.versions.node,
      startedAt,
      endedAt: new Date().toISOString(),
      workflowStepsPerRound: 23,
      actualInteractiveActionsPerRound: 15,
      interactionCountDefinition: 'State-changing page actions only: fill/select/check/click; waits and readback verifiers are workflow steps but not interactive actions.',
      coldPreparationMs,
      rounds,
      independentOracle: { expectedRecords: independentExpected, exportedRecords: parsedExportRecords, exportedTotal, totalQty: independentTotalQty, totalAmount: independentTotalAmount, independentlyVerified, exportMatchesOracle },
      targetId,
      note: 'All fixture data, applicant names, and bill IDs are synthetic. The page simulates an asynchronous 160 ms query and has no network dependency or external latency. Only an explicitly created about:blank page was configured by original CDP. All workflow actions used runWorkflow and its guarded browser facade. No business page or user browser was accessed.'
    };
    fs.writeFileSync(path.join(artifactDir, 'report.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ coldPreparationMs, rounds: rounds.map(r => ({ round: r.round, preparationMs: r.preparationMs, executionMs: r.executionMs, workflowDurationMs: r.workflowDurationMs, status: r.status, verifiedSteps: r.verifiedSteps, failedSteps: r.failedSteps })), independentOracle: result.independentOracle, targetId }, null, 2));
    if (rounds.length !== 3 || rounds.some(r => !r.ok || r.status !== 'verified' || r.verifiedSteps !== 23) || !independentlyVerified || !exportMatchesOracle) process.exitCode = 1;
  } finally {
    if (browser && targetId) {
      try {
        const target = (await browser.send('Target.getTargets')).targetInfos.find(t => t.targetId === targetId);
        if (target?.url === 'about:blank') await browser.send('Target.closeTarget', { targetId });
      } catch {}
      browser.close();
    }
  }
}

main().catch(error => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const payload = { startedAt, endedAt: new Date().toISOString(), error: { code: error.code || 'ERROR', message: error.message, pageReason: error.pageReason }, wallClockMs: Math.round(performance.now() - wallStarted) };
  fs.writeFileSync(path.join(artifactDir, 'failure.json'), JSON.stringify(payload, null, 2), 'utf8');
  console.error(JSON.stringify(payload, null, 2));
  process.exitCode = 1;
});
