const { test } = require('node:test');
const assert = require('node:assert/strict');
const cdp = require('../lib/cdp');

test('parseRef recognizes @e1, @1, ref=e1, e1 and ignores plain tag names', () => {
  assert.equal(cdp.parseRef('@e1'), 'e1');
  assert.equal(cdp.parseRef('@12'), 'e12');
  assert.equal(cdp.parseRef('ref=e5'), 'e5');
  assert.equal(cdp.parseRef('ref=7'), 'e7');
  assert.equal(cdp.parseRef('e9'), 'e9');
  assert.equal(cdp.parseRef('em'), null);
  assert.equal(cdp.parseRef('embed'), null);
  assert.equal(cdp.parseRef('#e1'), null);
});

test('parseSelectorOrLocator parses role, text, cssText, href, xpath, and terminal nth', () => {
  const r1 = cdp.parseSelectorOrLocator('role:button[name="查询"]');
  assert.equal(r1.kind, 'role');
  assert.equal(r1.role, 'button');
  assert.equal(r1.name, '查询');
  assert.equal(r1.nameMode, 'exact');

  const r2 = cdp.parseSelectorOrLocator('loc=role:link[name*="下载"]');
  assert.equal(r2.kind, 'role');
  assert.equal(r2.nameMode, 'substring');
  assert.equal(r2.name, '下载');

  const t1 = cdp.parseSelectorOrLocator('text="取得发票"');
  assert.equal(t1.kind, 'text');
  assert.equal(t1.mode, 'exact');
  assert.equal(t1.text, '取得发票');

  const t2 = cdp.parseSelectorOrLocator('text=全量发票');
  assert.equal(t2.kind, 'text');
  assert.equal(t2.mode, 'substring');

  const ct = cdp.parseSelectorOrLocator('.t-select-option:text-is("数电票")');
  assert.equal(ct.kind, 'cssText');
  assert.equal(ct.selector, '.t-select-option');
  assert.equal(ct.mode, 'exact');
  assert.equal(ct.text, '数电票');

  const nth = cdp.parseSelectorOrLocator('button:has-text("提交") >> nth=-1');
  assert.equal(nth.kind, 'nth');
  assert.equal(nth.index, -1);
  assert.equal(nth.inner.kind, 'cssText');
  assert.equal(nth.inner.mode, 'substring');

  assert.throws(
    () => cdp.parseSelectorOrLocator('button >> nth=abc'),
    (err) => err instanceof cdp.ElementResolutionError && err.kind === 'permanent'
  );
});

test('RefMap supports durable ref allocation across same loaderId and resolves @e1 expressions', () => {
  const fakeCdp = {};
  const map = cdp.ensurePageRefMap(fakeCdp);
  assert.equal(map.observeDocument('main', 'loader-1'), true);
  const r1 = map.allocateRef('main', 101, true);
  const r2 = map.allocateRef('main', 202, true);
  const r1Again = map.allocateRef('main', 101, true);
  assert.equal(r1, 'e1');
  assert.equal(r2, 'e2');
  assert.equal(r1Again, 'e1');

  map.add('e1', 101, 'button', '查询', undefined, {
    loc: 'role:button[name="查询"]',
    selector: '[data-abb-ref="e1"]',
  });
  const expr = cdp.buildFindElementsExpression(fakeCdp, '@1');
  assert.ok(expr.includes('data-abb-ref'));
  assert.ok(expr.includes('查询'));

  assert.throws(
    () => cdp.buildFindElementsExpression(fakeCdp, '@e999'),
    (err) => err instanceof cdp.ElementResolutionError && err.code === 'CDP_STALE_REF'
  );
});

test('snapshot enforces context guard, populates RefMap, and supports SnapshotResult.find + diffSnapshots', async () => {
  await assert.rejects(
    cdp.snapshot({ evalChecked: async () => true }, ''),
    /requires context guard/
  );
  await assert.rejects(
    cdp.snapshot({ evalChecked: async () => false }, 'location.href.includes("ok")'),
    /Context guard failed/
  );

  const fakeCdp = {
    evalChecked: async (expr) => {
      if (expr === 'true') return true;
      return {
        url: 'https://example.test/etax',
        title: '电子税务局',
        lines: [
          '- heading "全量发票查询" [level=1]',
          '- combobox "发票来源" [ref=e1]',
          '- button "查询" [ref=e2]',
        ],
        refs: [
          { refId: 'e1', role: 'combobox', name: '发票来源', loc: 'role:combobox[name="发票来源"]', selector: '[data-abb-ref="e1"]' },
          { refId: 'e2', role: 'button', name: '查询', loc: 'role:button[name="查询"]', selector: '[data-abb-ref="e2"]' },
        ],
      };
    },
  };

  const snap1 = await cdp.snapshot(fakeCdp, 'true');
  assert.ok(snap1.text.includes('- button "查询" [ref=e2]'));
  assert.equal(snap1.find('查询'), '- heading "全量发票查询" [level=1]\n- button "查询" [ref=e2]');
  assert.equal(cdp.ensurePageRefMap(fakeCdp).get('@2').name, '查询');

  const snap2Text = [
    '[Page] "电子税务局" (https://example.test/etax)',
    '- heading "全量发票查询" [level=1]',
    '- combobox "发票来源" [value="取得发票"] [ref=e1]',
    '- button "查询" [ref=e2]',
    '- row "共 12 条"',
  ].join('\n');

  const diff = cdp.diffSnapshots(snap1, snap2Text);
  assert.equal(diff.changed, true);
  assert.equal(diff.additions, 2);
  assert.equal(diff.removals, 1);
  assert.ok(diff.diff.includes('+ - row "共 12 条"'));
});

test('clickByBox and readUnique accept @e1 refs and semantic locators while preserving guard checks', async () => {
  const sent = [];
  const fakeCdp = {
    evalChecked: async (expr) => {
      if (expr === 'true') return true;
      if (expr.includes('data-abb-ref')) return { x: 20, y: 40, width: 60, height: 24 };
      if (expr.includes('__abbImplicitRole')) return '成功读取语义节点';
      throw new Error('Unexpected expression: ' + expr);
    },
    send: async (method, params) => sent.push({ method, params }),
  };
  cdp.ensurePageRefMap(fakeCdp).add('e1', 10, 'button', '查询', undefined, {
    selector: '[data-abb-ref="e1"]',
  });

  const clickRes = await cdp.clickByBox(fakeCdp, '@e1', 'true');
  assert.equal(clickRes.clicked, true);
  assert.equal(clickRes.x, 50);
  assert.equal(clickRes.y, 52);

  const text = await cdp.readUnique(fakeCdp, 'role:heading[name="结果"]', 'true');
  assert.equal(text, '成功读取语义节点');
});

test('installPageContextGuard and runScript trap browser globals in Node and execute multi-step code', async () => {
  await assert.rejects(
    cdp.runScript('return document.title;'),
    (err) => err instanceof ReferenceError && err.message.includes('page.evalChecked')
  );
  await assert.rejects(
    cdp.runScript('return window.location.href;'),
    (err) => err instanceof ReferenceError && err.message.includes('page.evalChecked')
  );

  const res = await cdp.runScript(`
    cliLog('step-1');
    const sites = listSiteLearnings();
    return sites.map(s => s.site);
  `);
  assert.equal(res.ok, true);
  assert.ok(res.result.includes('k3cloud'));
  assert.ok(res.result.includes('etax-gd'));
  assert.ok(res.output.includes('step-1'));
});

test('learnings engine validates site manifests, matches URLs, and runs site tools', async () => {
  const report = cdp.validateSiteLearnings();
  assert.equal(report.ok, true);
  assert.ok(report.total >= 2);

  const etaxSite = cdp.loadSiteLearning('https://etax.guangdong.chinatax.gov.cn/xxmh');
  assert.ok(etaxSite);
  assert.equal(etaxSite.site, 'etax-gd');
  assert.ok(etaxSite.noteContents['notes/invoice-query.md'].includes('TDesign'));

  const fakePage = {
    evalChecked: async () => ({
      totalCount: 1,
      rows: [
        ['1', '数电票', '26442000000012345678', '91440000MA5XXXXXX', '某供应商', '91440101MA5YYYYYY', '高昌机电', '2026-11-01', '1000.00', '130.00', '1130.00', '增值税发票管理系统', '数电普票', '正常', '正数', '正常', '张三', '测试备注'],
      ],
    }),
  };
  const parsed = await cdp.runSiteTool('etax-gd', 'parse-invoices', { source: 'received' }, { page: fakePage });
  assert.equal(parsed.totalCount, 1);
  assert.equal(parsed.parsedCount, 1);
  assert.equal(parsed.invoices[0].invoiceNo, '26442000000012345678');
  assert.equal(parsed.invoices[0].buyerName, '高昌机电');
});

test('hud and advanced capabilities: dialog guard, observe ring buffer, and waitForDownload', async () => {
  // 1. HUD 仅对真实 targetId 或显式 hud:true 开启，不污染轻量 Mock
  assert.equal(cdp.isHudEnabled({}), false);
  assert.equal(cdp.isHudEnabled({ targetId: 'T-1' }), true);
  assert.equal(cdp.isHudEnabled({ targetId: 'T-1', hud: false }), false);

  // 2. Dialog Guard + Observe Ring Buffer
  const listeners = new Map();
  const sent = [];
  const fakeSession = {
    targetId: 'T-1',
    hud: false,
    on(event, fn) {
      listeners.set(event, fn);
      return () => listeners.delete(event);
    },
    async send(method, params) {
      sent.push({ method, params });
      return {};
    },
    async evalChecked() {
      return true;
    },
  };

  await cdp.enableDialogGuard(fakeSession, { acceptConfirm: true });
  await cdp.enableObserve(fakeSession);

  // 模拟触发 alert 与 confirm
  await listeners.get('Page.javascriptDialogOpening')({
    type: 'alert',
    message: '保存成功',
    url: 'https://example.test/k3?token=secret123',
  });
  const dialogs = cdp.getDialogs(fakeSession);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].message, '保存成功');
  assert.equal(dialogs[0].accept, true);
  assert.ok(dialogs[0].url.includes('?[redacted]'));
  assert.ok(sent.some((s) => s.method === 'Page.handleJavaScriptDialog' && s.params.accept === true));

  // 模拟 Console Error、Uncaught Exception 与 HTTP 500
  listeners.get('Runtime.consoleAPICalled')({
    type: 'error',
    args: [{ value: 'K3Cloud grid load failed' }],
  });
  listeners.get('Runtime.exceptionThrown')({
    exceptionDetails: { text: 'TypeError: Cannot read properties of null', url: 'https://example.test/app.js?jwt=abc' },
  });
  listeners.get('Network.requestWillBeSent')({
    requestId: 'req-1',
    request: { url: 'https://example.test/api/query?ak=secret', method: 'POST' },
    type: 'XHR',
  });
  listeners.get('Network.responseReceived')({
    requestId: 'req-1',
    response: { status: 500, statusText: 'Internal Server Error', url: 'https://example.test/api/query?ak=secret' },
    type: 'XHR',
  });
  listeners.get('Network.loadingFinished')({ requestId: 'req-1' });

  const diag = cdp.readDiagnostics(fakeSession);
  assert.equal(diag.observeEnabled, true);
  assert.equal(diag.console.length, 1);
  assert.equal(diag.exceptions.length, 1);
  assert.equal(diag.networkFailures.length, 1);
  assert.equal(diag.networkFailures[0].status, 500);
  assert.ok(!diag.networkFailures[0].url.includes('secret'));
  assert.equal(diag.inFlightCount, 0);

  // 3. 受控下载闭环 waitForDownload
  const dlResult = await cdp.waitForDownload(
    fakeSession,
    async () => {
      listeners.get('Browser.downloadWillBegin')({
        guid: 'guid-1',
        url: 'https://example.test/export?token=123',
        suggestedFilename: 'invoices.xlsx',
      });
      listeners.get('Browser.downloadProgress')({
        guid: 'guid-1',
        state: 'completed',
        totalBytes: 4096,
      });
    },
    { guardExpression: 'true' }
  );
  assert.equal(dlResult.completed, true);
  assert.equal(dlResult.suggestedFilename, 'invoices.xlsx');
  assert.equal(dlResult.totalBytes, 4096);
});
