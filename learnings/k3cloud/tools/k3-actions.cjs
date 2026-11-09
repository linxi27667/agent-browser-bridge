// 金蝶云星空（K3Cloud HTML5）实战验证过的只读操作封装（2026-11-09 在 10.1.3.38 / 101 广州高昌 实测）
// 原则：只读。不点保存/提交/审核；以“修改”模式打开的未审核单据读完立即关闭，避免占用同事的网控锁。
const path = require('node:path');
const cdp = require(path.resolve(__dirname, '../../../lib/cdp'));

const K3_GUARD = "location.href.toLowerCase().includes('k3cloud') && !document.getElementById('btnLogin') && !!document.querySelector('.kd-fullsearch-searchicon, input.kd-appplat-searchinput')";

function guardOf(opts = {}) {
  return opts.guard || K3_GUARD;
}

// 在页面里执行一个纯函数（不能引用 Node 侧变量），执行前强制检查上下文门禁
function inPage(page, guard, fn, arg) {
  const expr = '(()=>{if(!(' + guard + '))throw Error("Context guard failed");return (' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')})()';
  return page.evalChecked(expr);
}

// 网格状态：可见单号链接、是否“暂无数据”、是否在加载
async function gridSignature(page, opts = {}) {
  const guard = guardOf(opts);
  return inPage(page, guard, () => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    const links = [...document.querySelectorAll('a.type-link')].filter((e) => vis(e) && e.getBoundingClientRect().y > 250).slice(0, 200).map((e) => (e.innerText || '').trim());
    const empty = [...document.querySelectorAll('div,span,p')].some((e) => e.children.length === 0 && vis(e) && /暂时没有相关数据/.test(e.innerText || ''));
    const loading = [...document.querySelectorAll('.k-loading-image, .k-loading-mask')].some(vis);
    return { links, empty, loading, key: (empty ? 'EMPTY|' : '') + links.slice(0, 5).join(',') };
  });
}

// 等网格加载完成并连续两次读数一致（间隔 500ms）。不做“见到目标就返回”的捷径：
// 旧列表屏幕外的行里可能本来就有目标单号，查询还没生效就会被误判为找到
async function waitGridSettled(page, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs || 20000);
  let last = null;
  let s = null;
  while (Date.now() < deadline) {
    s = await gridSignature(page, opts);
    const ready = !s.loading && (s.links.length > 0 || s.empty);
    if (ready && last === s.key) return { ...s, settled: true };
    last = ready ? s.key : null;
    await cdp.sleep(500);
  }
  return { ...(s || { links: [], empty: false, loading: false, key: '' }), settled: false };
}

// 点查询后先等网格发生变化（清空或换内容），证明这次查询真的开始生效
async function waitGridChanged(page, fromKey, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs || 6000);
  while (Date.now() < deadline) {
    const s = await gridSignature(page, opts);
    if (s.loading || s.key !== fromKey) return true;
    await cdp.sleep(150);
  }
  return false;
}

async function waitLoadingGone(page, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000;
  await cdp.waitFor(page, `(() => [...document.querySelectorAll('.k-loading-image, .k-loading-mask')].every((m) => { const r = m.getBoundingClientRect(); return r.width === 0 || r.height === 0; }))()`, { timeoutMs }).catch(() => {});
  await cdp.sleep(300);
}

// 关掉“是否保存”类提示时一律选“否”（本工具从不修改单据，不保存任何内容）
async function dismissSavePrompt(page, guard) {
  return inPage(page, guard, () => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    const wins = [...document.querySelectorAll('.k-window')].filter(vis).filter((w) => /保存/.test(w.innerText || ''));
    for (const w of wins) {
      const no = [...w.querySelectorAll('a,button,span')].find((b) => vis(b) && /^(否|不保存)$/.test((b.innerText || '').trim()));
      if (no) { no.click(); return true; }
    }
    return false;
  });
}

async function closeModalWindows(page, opts = {}) {
  const guard = guardOf(opts);
  return inPage(page, guard, () => {
    const btns = [...document.querySelectorAll('.k-window .k-window-titlebar a.k-window-action, .k-window .k-window-titlebar .k-i-close')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
    btns.forEach((b) => b.click());
    return btns.length;
  });
}

async function closeInnerTabs(page, opts = {}) {
  const guard = guardOf(opts);
  await closeModalWindows(page, opts).catch(() => 0);
  await cdp.sleep(200);
  let closed = 0;
  for (let i = 0; i < 12; i++) {
    const left = await inPage(page, guard, () => {
      const btns = [...document.querySelectorAll('li.contentHeadEL span.mainTabCloseButton')].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 4 && r.y >= 30 && r.y <= 90;
      });
      if (!btns.length) return 0;
      btns[btns.length - 1].click();
      return btns.length;
    });
    if (!left) break;
    closed++;
    await cdp.sleep(350);
    await dismissSavePrompt(page, guard).catch(() => false);
  }
  return closed;
}

async function closeActiveBillTab(page, opts = {}) {
  const guard = guardOf(opts);
  await closeModalWindows(page, opts).catch(() => 0);
  await cdp.sleep(200);
  const clicked = await inPage(page, guard, () => {
    const tab = [...document.querySelectorAll('li.contentHeadEL.k-state-active')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.y >= 30 && r.y <= 90 && r.width > 30;
    });
    const btn = tab && tab.querySelector('span.mainTabCloseButton');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await cdp.sleep(400);
  await dismissSavePrompt(page, guard).catch(() => false);
  return clicked;
}

async function openListBySearch(page, job, opts = {}) {
  const guard = guardOf(opts);
  const query = job.query || job.q;
  const needle = job.needle || query;
  if (!query) throw new Error('openListBySearch requires job.query');
  if (opts.closeTabsFirst !== false) await closeInnerTabs(page, opts);

  const searchOpen = await inPage(page, guard, () => {
    const inp = document.querySelector('input.kd-appplat-searchinput');
    return !!(inp && inp.getBoundingClientRect().width > 20);
  });
  if (!searchOpen) {
    await cdp.clickByBox(page, '.kd-fullsearch-searchicon', guard, { parkPointer: true });
    await cdp.sleep(450);
  }
  // 顶部搜索只认 keydown/keyup；fillNative 已补发 input/change/keyup。再点“搜索 …”标题让候选按新关键词刷新
  // 关掉页签后搜索框偶尔处于半展开状态（不可输入），失败时收起重开再试一次
  try {
    await cdp.fillNative(page, 'input.kd-appplat-searchinput', query, guard);
  } catch (err) {
    if (!/must be unique|unavailable|focus changed/i.test(String(err && err.message))) throw err;
    await cdp.pressKey(page, 'Escape', guard).catch(() => {});
    await cdp.sleep(300);
    await cdp.clickByBox(page, '.kd-fullsearch-searchicon', guard, { parkPointer: true });
    await cdp.sleep(500);
    await cdp.fillNative(page, 'input.kd-appplat-searchinput', query, guard);
  }
  await cdp.sleep(350);
  await inPage(page, guard, () => {
    const hdr = document.querySelector('.kd-fullSearchList-header-searchresult-container');
    if (hdr) hdr.click();
    return !!hdr;
  });

  let matched = null;
  const t0 = Date.now();
  while (Date.now() - t0 < (opts.searchTimeoutMs || 10000)) {
    matched = await inPage(page, guard, (a) => {
      const norm = (s) => String(s || '').replace(/\s+/g, '');
      const excl = String(a.exclude || '').split('|').filter(Boolean);
      for (const el of document.querySelectorAll('[data-abb-menu-hit]')) el.removeAttribute('data-abb-menu-hit');
      for (const item of document.querySelectorAll('li.kd-fullsearch-item-container')) {
        const title = item.querySelector('.kd-fullsearch-item-headertitle') || item;
        const t = norm(title.innerText);
        const r = title.getBoundingClientRect();
        if (r.width < 15 || r.height < 10 || !t.includes(norm(a.needle))) continue;
        if (excl.some((x) => t.includes(x))) continue;
        title.setAttribute('data-abb-menu-hit', '1');
        return { found: true, text: (item.innerText || '').trim().replace(/\s+/g, ' ') };
      }
      return { found: false };
    }, { needle, exclude: job.exclude });
    if (matched && matched.found) break;
    await cdp.sleep(250);
  }
  if (!matched || !matched.found) throw new Error(`K3 menu search did not find ${needle}`);

  // 点击标题（不是整行中心），点完鼠标移开，避免悬停弹出下方工具栏的下拉菜单
  await cdp.clickByBox(page, '[data-abb-menu-hit="1"]', guard, { parkPointer: true });

  await cdp.waitFor(page, `(${guard}) && (() => {
    const needle = ${JSON.stringify(String(needle).replace(/\s+/g, ''))};
    const tab = [...document.querySelectorAll('li.contentHeadEL')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.y >= 30 && r.y <= 90 && r.width > 30 && (el.innerText || '').replace(/\\s+/g, '').includes(needle);
    });
    if (!tab) return false;
    if (!tab.classList.contains('k-state-active')) { (tab.querySelector('span.k-link') || tab).click(); return false; }
    return true;
  })()`, { timeoutMs: opts.openTimeoutMs || 25000 });
  // 等快捷过滤栏和网格就绪（个别列表没有快捷过滤，软等待）
  await cdp.waitFor(page, `(() => [...document.querySelectorAll('input')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.y > 140 && r.y < 260 && (e.placeholder || '').includes('回车查询') && !e.disabled && !e.readOnly; }))()`, { timeoutMs: 15000 }).catch(() => {});
  await waitLoadingGone(page, { timeoutMs: 20000 });
  // 关键：列表首次加载会在打开后数秒才返回，提前查询会被这次加载覆盖成全量列表
  const grid = await waitGridSettled(page, { ...opts, timeoutMs: opts.gridTimeoutMs || 25000 });
  return { menuText: matched.text, gridReady: grid.settled, rows: grid.links.length, empty: grid.empty };
}

// 很多列表首个快捷过滤字段不是“单据编号”（如生产入库单列表默认是“物料编码”），必须先切换
async function ensureQuickFilterField(page, label = '单据编号', opts = {}) {
  const guard = guardOf(opts);
  const cur = await inPage(page, guard, (want) => {
    const f = [...document.querySelectorAll('input.kd-defaultQuikerRow-partFileds')].find((e) => e.getBoundingClientRect().width > 20);
    if (!f) return null;
    if ((f.value || '').trim() === want) return want;
    const wrap = f.closest('.k-widget, .k-combobox, .k-dropdown');
    const sel = wrap && wrap.querySelector('.k-select');
    if (sel) sel.click();
    return f.value || '';
  }, label);
  if (cur === null || cur === label) return { field: cur, switched: false };
  await cdp.sleep(450);
  const marked = await inPage(page, guard, (want) => {
    for (const el of document.querySelectorAll('[data-abb-qf-item]')) el.removeAttribute('data-abb-qf-item');
    const item = [...document.querySelectorAll('li.k-item')].find((e) => {
      const r = e.getBoundingClientRect();
      return (e.innerText || '').trim() === want && r.width > 10 && r.height > 8;
    });
    if (!item) return false;
    item.setAttribute('data-abb-qf-item', '1');
    return true;
  }, label);
  if (!marked) throw new Error(`Quick filter field "${label}" not offered by this list`);
  await cdp.clickByBox(page, '[data-abb-qf-item="1"]', guard, { parkPointer: true });
  await cdp.sleep(500);
  return { field: label, switched: true, from: cur };
}

// 第一个快捷过滤字段右侧的值输入框（placeholder 会随字段类型变化，不能靠它定位）
async function markQuickFilterValueInput(page, opts = {}) {
  const guard = guardOf(opts);
  return inPage(page, guard, () => {
    for (const el of document.querySelectorAll('[data-abb-qf-value]')) el.removeAttribute('data-abb-qf-value');
    const field = [...document.querySelectorAll('input.kd-defaultQuikerRow-partFileds')].find((e) => e.getBoundingClientRect().width > 20);
    if (!field) return false;
    const fr = field.getBoundingClientRect();
    let best = null;
    for (const el of document.querySelectorAll('input')) {
      const r = el.getBoundingClientRect();
      if (el === field || r.width < 60 || el.disabled || el.readOnly) continue;
      if (Math.abs(r.y - fr.y) > 6 || r.x <= fr.x + fr.width) continue;
      if (el.classList.contains('kd-defaultQuikerRow-partFileds')) continue;
      const d = r.x - fr.x;
      if (d < 120) continue; // 跳过紧挨着的“包含/等于”比较符
      if (!best || d < best.d) best = { el, d };
    }
    if (!best) return false;
    best.el.setAttribute('data-abb-qf-value', '1');
    return true;
  });
}

async function filterByBillNo(page, billNo, opts = {}) {
  const guard = guardOf(opts);
  const runSearch = async () => {
    await ensureQuickFilterField(page, '单据编号', opts);
    const before = await gridSignature(page, opts);
    if (!await markQuickFilterValueInput(page, opts)) throw new Error('Quick filter value input not found');
    await cdp.fillNative(page, '[data-abb-qf-value="1"]', billNo, guard);
    // 只点一次放大镜。回车 + 点按钮会连发两次查询，第二次重绘会把刚出现的单号链接销毁
    await cdp.clickByBox(page, 'a.kd-filterquicker-btnSearch-container', guard, { parkPointer: true });
    await waitGridChanged(page, before.key, opts);
    let s = await waitGridSettled(page, { ...opts, timeoutMs: 15000 });
    if (!s.links.includes(billNo)) {
      // 网格可能刚好被一次迟到的刷新覆盖：再查一次
      const again = await gridSignature(page, opts);
      await cdp.clickByBox(page, 'a.kd-filterquicker-btnSearch-container', guard, { parkPointer: true });
      await waitGridChanged(page, again.key, opts);
      s = await waitGridSettled(page, { ...opts, timeoutMs: 15000 });
    }
    return s.links.includes(billNo);
  };
  let found = await runSearch();
  let reset = false;
  if (!found) {
    // 默认方案可能带日期条件，先“重置”再查一次（重置会把快捷过滤字段恢复为方案默认，runSearch 会再切回单据编号）
    reset = await inPage(page, guard, () => {
      const btn = [...document.querySelectorAll('a,span')].find((e) => (e.innerText || '').trim() === '重置' && e.getBoundingClientRect().width > 10);
      if (btn) btn.click();
      return !!btn;
    });
    await cdp.sleep(800);
    await waitGridSettled(page, { ...opts, timeoutMs: 15000 });
    found = await runSearch();
  }
  return { found, reset };
}

async function readBillState(page, opts = {}) {
  const guard = guardOf(opts);
  return inPage(page, guard, () => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    const tab = [...document.querySelectorAll('li.contentHeadEL.k-state-active')].find((el) => { const r = el.getBoundingClientRect(); return r.y >= 30 && r.y <= 90 && r.width > 30; });
    const title = tab ? (tab.innerText || '').trim() : '';
    const m = /-\s*(修改|查看|新增)\s*$/.exec(title);
    const mode = m ? m[1] : '';
    let billStatus = '';
    const label = [...document.querySelectorAll('span,label,div')].find((e) => e.children.length === 0 && (e.innerText || '').trim() === '单据状态' && vis(e));
    if (label) {
      const lr = label.getBoundingClientRect();
      let best = null;
      for (const el of document.querySelectorAll('input, span.k-input')) {
        const r = el.getBoundingClientRect();
        if (r.width < 10 || Math.abs((r.y + r.height / 2) - (lr.y + lr.height / 2)) > 10 || r.x < lr.x + lr.width - 4) continue;
        const d = r.x - lr.x;
        const v = el.tagName === 'INPUT' ? el.value : el.innerText;
        if (!best || d < best.d) best = { d, v: String(v || '').trim() };
      }
      billStatus = best ? best.v : '';
    }
    const conflictEl = [...document.querySelectorAll('span,div,p')].find((e) => e.children.length === 0 && vis(e) && /冲突，请稍候再使用|已被.{0,20}锁定|正在被.{0,20}(修改|使用)/.test(e.innerText || ''));
    const locked = /已审核|已关闭|已作废/.test(billStatus);
    return {
      title,
      mode,
      billStatus,
      conflict: conflictEl ? (conflictEl.innerText || '').trim().slice(0, 200) : null,
      // 状态读不到时按可编辑处理（保守），调用方读完必须关闭
      editable: mode === '修改' && !locked,
    };
  });
}

async function openBill(page, billNo, opts = {}) {
  const guard = guardOf(opts);
  const before = await inPage(page, guard, () => document.querySelectorAll('li.contentHeadEL').length);
  // 同一单号在多行明细里会重复出现（每行一个链接），标记第一个可见的再点
  const markLink = () => inPage(page, guard, (bill) => {
    for (const el of document.querySelectorAll('[data-abb-bill-hit]')) el.removeAttribute('data-abb-bill-hit');
    const link = [...document.querySelectorAll('a.type-link')].find((e) => {
      const r = e.getBoundingClientRect();
      return (e.innerText || '').trim() === bill && r.width > 15 && r.height > 8 && r.y > 200;
    });
    if (!link) return false;
    link.setAttribute('data-abb-bill-hit', '1');
    return true;
  }, billNo);
  let marked = false;
  const markDeadline = Date.now() + 8000;
  while (!(marked = await markLink()) && Date.now() < markDeadline) await cdp.sleep(300);
  if (!marked) throw new Error(`Bill link ${billNo} not visible in grid`);
  await cdp.clickByBox(page, '[data-abb-bill-hit="1"]', guard, { parkPointer: true });
  await cdp.waitFor(page, `(() => document.querySelectorAll('li.contentHeadEL').length > ${Number(before) || 0})()`, { timeoutMs: 15000 }).catch(() => {});
  await cdp.sleep(1500);
  await waitLoadingGone(page, { timeoutMs: 15000 });
  return readBillState(page, opts);
}

// 序列号查询：有的单据在顶部工具栏直接有“序列号”，有的在“业务操作”下拉里
async function openSerialView(page, opts = {}) {
  const guard = guardOf(opts);
  const direct = await inPage(page, guard, () => {
    for (const el of document.querySelectorAll('[data-abb-sn]')) el.removeAttribute('data-abb-sn');
    const t = [...document.querySelectorAll('span.kdmenuitem-content, li.contentHeadEL span.k-link, span.kd-billdashboard-itemlink')].find((e) => {
      const r = e.getBoundingClientRect();
      return (e.innerText || '').trim() === '序列号' && r.width > 15 && r.height > 10 && r.y > 50;
    });
    if (!t) return false;
    t.setAttribute('data-abb-sn', '1');
    return true;
  });
  if (!direct) {
    const parent = await inPage(page, guard, () => {
      for (const el of document.querySelectorAll('[data-abb-sn-parent]')) el.removeAttribute('data-abb-sn-parent');
      for (const e of document.querySelectorAll('span.kdmenuitem-content')) {
        if ((e.innerText || '').trim() !== '序列号') continue;
        const li = e.closest('li.kdmenuitem-splitbutton');
        if (li && li.getBoundingClientRect().width > 20) { li.setAttribute('data-abb-sn-parent', '1'); return true; }
      }
      return false;
    });
    if (!parent) return { opened: false, reason: '此单据没有序列号查询入口' };
    await cdp.clickByBox(page, '[data-abb-sn-parent="1"]', guard);
    await cdp.sleep(450);
    const item = await inPage(page, guard, () => {
      const e = [...document.querySelectorAll('span.kdmenuitem-content')].find((x) => (x.innerText || '').trim() === '序列号' && x.getBoundingClientRect().width > 10);
      if (!e) return false;
      e.setAttribute('data-abb-sn', '1');
      return true;
    });
    if (!item) return { opened: false, reason: '业务操作下拉中未出现序列号' };
  }
  await cdp.clickByBox(page, '[data-abb-sn="1"]', guard, { parkPointer: true });
  // 等“单据序列号查询”弹窗出现，并等“查询进度/正在取数”结束
  await cdp.waitFor(page, `(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    const dlg = [...document.querySelectorAll('.k-window')].filter(vis).find((w) => /序列号查询/.test(w.innerText || ''));
    if (!dlg) return false;
    const busy = [...document.querySelectorAll('.k-window')].filter(vis).some((w) => /正在取数|查询进度/.test(w.innerText || ''));
    return !busy;
  })()`, { timeoutMs: opts.serialTimeoutMs || 30000 });
  await cdp.sleep(500);
  const total = await inPage(page, guard, () => {
    const m = /共计[:：]\s*(\d+)\s*条记录/.exec(document.body.innerText || '');
    return m ? Number(m[1]) : null;
  });
  return { opened: true, total };
}

module.exports = {
  K3_GUARD,
  waitLoadingGone,
  gridSignature,
  waitGridSettled,
  waitGridChanged,
  markQuickFilterValueInput,
  closeModalWindows,
  closeInnerTabs,
  closeActiveBillTab,
  openListBySearch,
  ensureQuickFilterField,
  filterByBillNo,
  readBillState,
  openBill,
  openSerialView,
};
