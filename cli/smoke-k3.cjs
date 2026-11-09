#!/usr/bin/env node
// 金蝶时序回归冒烟：在隔离的 about:blank 页面里模拟金蝶 HTML5 的两个时序陷阱，验证 learnings/k3cloud/tools/k3-actions.cjs
//  1) 列表打开后首次加载要 2.5 秒才返回（提前查询会被覆盖）
//  2) 旧列表屏幕外的行里本来就有目标单号（查询未生效就会误判“找到”）
// 另验证：快捷过滤字段切换、修改模式单据识别、只读点击拦截、掉线识别。绝不访问真实业务网站。
const assert = require('node:assert/strict');
const path = require('node:path');
const cdp = require('../lib/cdp');
const k3 = require(path.resolve(__dirname, '../learnings/k3cloud/tools/k3-actions.cjs'));

const GUARD = 'document.title === "k3-fixture"';
const opts = { guard: GUARD };

const FIXTURE = `<!doctype html><title>k3-fixture</title>
<style>
body{margin:0;font:13px sans-serif;width:780px;height:580px;position:relative}
.abs{position:absolute}
#tabs{left:20px;top:46px;height:30px}
li.contentHeadEL{display:inline-block;height:28px;padding:0 10px;margin-right:4px;border:1px solid #ccc;list-style:none}
li.contentHeadEL.k-state-active{background:#def}
.mainTabCloseButton{display:inline-block;width:12px;height:12px;margin-left:6px;background:#c33}
#searchbox{left:450px;top:8px;width:200px;height:24px;display:none}
.kd-fullsearch-searchicon{left:700px;top:8px;width:24px;height:24px;background:#36c}
#drop{left:300px;top:60px;width:440px;display:none;background:#fff;border:1px solid #999;z-index:5}
.kd-fullSearchList-header-searchresult-container{height:24px}
li.kd-fullsearch-item-container{list-style:none;height:26px}
.kd-fullsearch-item-headertitle{display:inline-block;width:220px;height:22px}
#listPanel{display:none}
.k-widget{left:78px;top:189px;width:120px;height:24px}
input.kd-defaultQuikerRow-partFileds{width:96px;height:22px}
.k-select{display:inline-block;width:20px;height:22px;background:#999}
#qfValue{left:309px;top:189px;width:233px;height:22px;z-index:2}
.kd-filterquicker-btnSearch-container{left:560px;top:189px;width:28px;height:24px;background:#36c}
#reset{left:600px;top:189px;width:40px;height:24px}
#fieldList{left:78px;top:215px;width:120px;height:40px;overflow:auto;display:none;background:#fff;border:1px solid #999;z-index:6;padding:0;margin:0}
li.k-item{list-style:none;height:22px}
#grid{left:20px;top:263px;width:740px;height:280px;overflow:auto;border:1px solid #ddd}
#grid div.row{height:30px}
a.type-link{display:inline-block;min-width:80px;height:20px;color:#06c}
.k-loading-image{left:380px;top:380px;width:40px;height:40px;background:#888;display:none}
#billPanel{display:none}
#saveBar{left:40px;top:84px;height:24px}
#statusLabel{left:40px;top:300px;width:60px;height:22px}
#statusValue{left:120px;top:300px;width:120px;height:22px}
</style>
<div class="abs" id="tabs"></div>
<input class="abs kd-appplat-searchinput" id="searchbox">
<div class="abs kd-fullsearch-searchicon"></div>
<div class="abs" id="drop"><div class="kd-fullSearchList-header-searchresult-container">搜索</div><ul id="items" style="margin:0;padding:0"></ul></div>
<div id="listPanel">
  <!-- 陷阱 3：关闭过的列表留下的旧控件，有尺寸但被当前控件盖住，且显示的字段不同 -->
  <span class="abs k-widget k-combobox" style="z-index:0"><input class="k-input kd-defaultQuikerRow-partFileds" value="单据编号"><span class="k-select"></span></span>
  <input class="abs k-textbox" style="left:309px;top:189px;width:233px;height:22px;z-index:0" placeholder="请输入关键字后回车查询">
  <span class="abs k-widget k-combobox" id="liveField" style="z-index:2;background:#fff"><input class="k-input kd-defaultQuikerRow-partFileds" value="物料编码" aria-owns="fieldList"><span class="k-select"></span></span>
  <ul class="abs" id="fieldList"><li class="k-item">单据编号</li><li class="k-item">申请日期</li><li class="k-item">物料编码</li><li class="k-item">生产车间</li></ul>
  <input class="abs k-textbox" id="qfValue" placeholder="请选择内容后回车查询">
  <a class="abs kd-filterquicker-btnSearch-container"></a>
  <a class="abs" id="reset">重置</a>
  <div class="abs" id="grid"></div>
  <div class="abs k-loading-image"></div>
</div>
<div id="billPanel">
  <div class="abs" id="saveBar"><a class="kdmenuitem"><span class="kdmenuitem-content" id="save-btn">保存</span></a></div>
  <span class="abs" id="statusLabel">单据状态</span><input class="abs" id="statusValue" value="已审核">
</div>
<script>
window.__saved = false;
const $ = (s) => document.querySelector(s);
const grid = $('#grid');
let initialLoadDone = false;
function render(rows) { grid.innerHTML = rows.map((t) => '<div class="row"><a class="type-link">' + t + '</a></div>').join(''); }
function renderEmpty() { grid.innerHTML = '<div style="height:40px">很抱歉，暂时没有相关数据~</div>'; }
function oldRows() { const r = []; for (let i = 0; i < 200; i++) r.push(i === 150 ? 'TGT-001' : 'OLD-' + i); return r; }
function setTabs(list) {
  $('#tabs').innerHTML = list.map((t) => '<li class="contentHeadEL' + (t.active ? ' k-state-active' : '') + '"><span class="k-link">' + t.text + '</span><span class="mainTabCloseButton"></span></li>').join('');
}
let tabs = [];
$('.kd-fullsearch-searchicon').onclick = () => { $('#searchbox').style.display = 'block'; };
$('.kd-fullSearchList-header-searchresult-container').onclick = () => {
  const q = $('#searchbox').value;
  $('#items').innerHTML = q.includes('销售订单列表')
    ? '<li class="kd-fullsearch-item-container"><span class="kd-fullsearch-item-headertitle">XSDDBGLB销售订单变更单列表</span></li><li class="kd-fullsearch-item-container"><span class="kd-fullsearch-item-headertitle">XSDDLB销售订单列表</span> 供应链>销售管理</li>'
    : '';
};
$('#searchbox').addEventListener('keyup', () => { $('#drop').style.display = 'block'; });
$('#items').addEventListener('click', (e) => {
  const t = e.target.closest('.kd-fullsearch-item-headertitle');
  if (!t || !t.innerText.includes('销售订单列表') || t.innerText.includes('变更')) return;
  $('#drop').style.display = 'none'; $('#searchbox').style.display = 'none';
  tabs = [{ text: '销售订单列表', active: true }]; setTabs(tabs);
  $('#listPanel').style.display = 'block'; grid.innerHTML = '';
  setTimeout(() => { initialLoadDone = true; render(oldRows()); }, 2500); // 陷阱 1：首次加载迟到
});
$('#liveField .k-select').onclick = () => { $('#fieldList').style.display = 'block'; $('#fieldList').scrollTop = 44; }; // 陷阱 4：下拉框默认滚到当前字段，“单据编号”被滚出可视区上方
$('#fieldList').addEventListener('click', (e) => {
  const li = e.target.closest('li.k-item'); if (!li) return;
  $('#liveField input').value = li.innerText.trim();
  $('#qfValue').placeholder = li.innerText.trim() === '单据编号' ? '请输入关键字后回车查询' : '请选择内容后回车查询';
  $('#fieldList').style.display = 'none';
});
$('.kd-filterquicker-btnSearch-container').onclick = () => {
  const field = $('#liveField input').value, v = $('#qfValue').value;
  setTimeout(() => { grid.innerHTML = ''; $('.k-loading-image').style.display = 'block'; }, 300); // 陷阱 2：旧列表先保留 300ms
  setTimeout(() => {
    $('.k-loading-image').style.display = 'none';
    if (field === '单据编号' && v === 'TGT-001') render(['TGT-001', 'TGT-001', 'TGT-001']);
    else if (field === '单据编号') renderEmpty();
    else render(['MAT-0001', 'MAT-0002', 'MAT-0003']); // 用错字段查：结果里没有目标
  }, 1200);
};
$('#reset').onclick = () => { $('#liveField input').value = '物料编码'; $('#qfValue').value = ''; setTimeout(() => render(oldRows()), 800); };
grid.addEventListener('click', (e) => {
  const a = e.target.closest('a.type-link'); if (!a || a.innerText !== 'TGT-001') return;
  tabs = tabs.map((t) => ({ ...t, active: false })).concat([{ text: 'TGT-001 - 修改', active: true }]); setTabs(tabs);
  $('#listPanel').style.display = 'none'; $('#billPanel').style.display = 'block';
});
$('#tabs').addEventListener('click', (e) => {
  if (!e.target.classList.contains('mainTabCloseButton')) return;
  const idx = [...$('#tabs').children].indexOf(e.target.closest('li'));
  tabs.splice(idx, 1); if (tabs.length) tabs[tabs.length - 1].active = true; setTabs(tabs);
  $('#billPanel').style.display = 'none'; $('#listPanel').style.display = tabs.length ? 'block' : 'none';
});
$('#save-btn').onclick = () => { window.__saved = true; };
</script>`;

// 两仓连接 API 不同：ABB 有 connectBrowser/attachTarget，GcWebAuto 用 /json + 页面 WebSocket
async function openFixturePage() {
  if (typeof cdp.connectBrowser === 'function' && typeof cdp.attachTarget === 'function') {
    const browser = await cdp.connectBrowser();
    const target = await browser.send('Target.createTarget', { url: 'about:blank', background: true });
    return { browser, targetId: target.targetId, page: await cdp.attachTarget(browser, target.targetId) };
  }
  const version = await cdp.getJson('/json/version');
  const browser = cdp.createCdp(version.webSocketDebuggerUrl);
  const target = await browser.send('Target.createTarget', { url: 'about:blank', background: true });
  const fixture = cdp.requireTarget(await cdp.listTargets(), { id: target.targetId });
  const page = cdp.createCdp(fixture.webSocketDebuggerUrl);
  await page.ready;
  // 后台标签页里 Chromium 会把合成鼠标事件节流到约 5 秒一次；带上 targetId/browser 让点击前自动激活标签页
  page.targetId = target.targetId;
  page.browser = browser;
  await browser.send('Target.activateTarget', { targetId: target.targetId }).catch(() => {});
  return { browser, targetId: target.targetId, page };
}

(async () => {
  await cdp.identity.verify();
  let browser, targetId, page;
  const t0 = Date.now();
  const step = (name) => console.log(`ok  ${name}  (+${Date.now() - t0}ms)`);
  try {
    ({ browser, targetId, page } = await openFixturePage());
    await page.send('Page.enable');
    const tree = await page.send('Page.getFrameTree');
    await page.send('Page.setDocumentContent', { frameId: tree.frameTree.frame.id, html: FIXTURE });
    await cdp.waitFor(page, GUARD, { timeoutMs: 5000 });

    const list = await k3.openListBySearch(page, { query: '销售订单列表', exclude: '变更|新' }, { ...opts, closeTabsFirst: false });
    assert.equal(list.gridReady, true);
    assert.equal(list.rows, 200, 'must wait for the late first load before returning');
    step('openListBySearch waits for late first grid load');

    const miss = await k3.filterByBillNo(page, 'NONE-999', opts);
    assert.equal(miss.found, false, 'stale off-screen TGT-001 must not count as a hit for another query');
    step('filterByBillNo not fooled by stale off-screen rows (and field switched to 单据编号)');

    const hit = await k3.filterByBillNo(page, 'TGT-001', opts);
    assert.equal(hit.found, true);
    step('filterByBillNo finds the bill after the query really ran');

    const state = await k3.openBill(page, 'TGT-001', opts);
    assert.equal(state.mode, '修改');
    assert.equal(state.billStatus, '已审核');
    assert.equal(state.editable, false);
    step('openBill clicks a duplicated link and reads modify mode / status');

    page.readOnly = true;
    await assert.rejects(cdp.clickByBox(page, '#save-btn', GUARD), (e) => e.code === 'READ_ONLY_BLOCKED');
    assert.equal(await page.evalChecked('window.__saved'), false);
    page.readOnly = false;
    step('read-only mode blocks the 保存 button for real');

    assert.equal(await k3.closeActiveBillTab(page, opts), true);
    step('closeActiveBillTab');

    await page.evalChecked(`(() => { const b = document.createElement('button'); b.id = 'btnLogin'; b.textContent = '登录'; b.style.cssText = 'position:absolute;left:10px;top:10px;width:60px;height:24px'; document.body.appendChild(b); return true; })()`);
    await assert.rejects(k3.openListBySearch(page, { query: '销售订单列表' }, opts), (e) => e.code === 'K3_SESSION_LOST');
    step('session loss is detected and stops the run');

    console.log(`K3 timing smoke passed in ${Date.now() - t0}ms`);
  } finally {
    if (page) page.close();
    if (browser && targetId) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
    if (browser) browser.close();
  }
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
