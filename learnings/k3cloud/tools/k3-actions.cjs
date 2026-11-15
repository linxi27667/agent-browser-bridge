// 金蝶云星空（K3Cloud HTML5）实战验证过的只读操作封装（2026-11-09 在 10.1.3.38 / 101 广州高昌 实测）
// 原则：只读。不点保存/提交/审核；以“修改”模式打开的未审核单据读完立即关闭，避免占用同事的网控锁。
const path = require('node:path');
const cdp = require(path.resolve(__dirname, '../../../lib/cdp'));

const K3_GUARD = "location.href.toLowerCase().includes('k3cloud') && !document.getElementById('btnLogin') && !!document.querySelector('.kd-fullsearch-searchicon, input.kd-appplat-searchinput')";
const K3_ADMIN_GUARD = "location.href.toLowerCase().includes('k3cloud') && !document.getElementById('btnLogin')";

function guardOf(opts = {}) {
  return opts.guard || K3_GUARD;
}

// 在页面里执行一个纯函数（不能引用 Node 侧变量），执行前强制检查上下文门禁
function inPage(page, guard, fn, arg) {
  const expr = '(()=>{if(!(' + guard + '))throw Error("Context guard failed");return (' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')})()';
  return page.evalChecked(expr);
}

// 掉线识别：回到登录页、被挤下线或会话超时时，抛 K3_SESSION_LOST 并停下（不自动重登、不重试业务操作）
async function assertSession(page) {
  const state = await page.evalChecked(`(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    const login = document.getElementById('btnLogin');
    if (login && vis(login)) return 'login-page';
    const msg = [...document.querySelectorAll('.k-window, .kd-messagebox, [role=dialog], [role=alertdialog]')].filter(vis)
      .map((w) => w.innerText || '').find((s) => /在其他地方登录|在别处登录|被迫下线|会话已失效|会话已过期|登录超时|请重新登录/.test(s));
    return msg ? 'kicked: ' + msg.replace(/\\s+/g, ' ').slice(0, 120) : 'ok';
  })()`);
  if (state !== 'ok') {
    const error = new Error('K3Cloud session lost (' + state + '); stop and re-login before continuing');
    error.code = 'K3_SESSION_LOST';
    error.detail = state;
    throw error;
  }
  return true;
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
  await assertSession(page);
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
    const onTop = (e) => { const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return false; const h = document.elementFromPoint(r.x + Math.min(r.width / 2, 20), r.y + r.height / 2); return !!h && (h === e || e.contains(h) || h.contains(e)); };
    const f = [...document.querySelectorAll('input.kd-defaultQuikerRow-partFileds')].find((e) => onTop(e));
    if (!f) return null;
    if ((f.value || '').trim() === want) return want;
    const wrap = f.closest('.k-widget, .k-combobox, .k-dropdown');
    const sel = wrap && wrap.querySelector('.k-select');
    if (sel) sel.click();
    return f.value || '';
  }, label);
  if (cur === null || cur === label) return { field: cur, switched: false };
  const markItem = () => inPage(page, guard, (want) => {
    for (const el of document.querySelectorAll('[data-abb-qf-item]')) el.removeAttribute('data-abb-qf-item');
    const onTop = (e) => { const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return false; const h = document.elementFromPoint(r.x + Math.min(r.width / 2, 20), r.y + r.height / 2); return !!h && (h === e || e.contains(h) || h.contains(e)); };
    const f = [...document.querySelectorAll('input.kd-defaultQuikerRow-partFileds')].find((e) => onTop(e));
    const owns = f && f.getAttribute('aria-owns');
    const root = (owns && document.getElementById(owns)) || document;
    const item = [...root.querySelectorAll('li.k-item')].find((e) => {
      if ((e.innerText || '').trim() !== want || e.getBoundingClientRect().width <= 10) return false;
      e.scrollIntoView({ block: 'nearest' });
      return onTop(e);
    });
    if (!item) return false;
    item.setAttribute('data-abb-qf-item', '1');
    return true;
  }, label);
  let marked = false;
  for (let attempt = 0; attempt < 2 && !marked; attempt++) {
    if (attempt > 0) {
      await inPage(page, guard, () => {
        const onTop = (e) => { const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return false; const h = document.elementFromPoint(r.x + Math.min(r.width / 2, 20), r.y + r.height / 2); return !!h && (h === e || e.contains(h) || h.contains(e)); };
        const f = [...document.querySelectorAll('input.kd-defaultQuikerRow-partFileds')].find((e) => onTop(e));
        const sel = f && f.closest('.k-widget, .k-combobox, .k-dropdown') && f.closest('.k-widget, .k-combobox, .k-dropdown').querySelector('.k-select');
        if (sel) sel.click();
        return !!sel;
      });
    }
    const until = Date.now() + 3000;
    while (!(marked = await markItem()) && Date.now() < until) await cdp.sleep(200);
  }
  if (!marked) throw new Error(`Quick filter field "${label}" not offered by this list`);
  try {
    await cdp.clickByBox(page, '[data-abb-qf-item="1"]', guard, { parkPointer: true });
  } catch (err) {
    // 下拉弹层偶尔部分渲染在可视区外（坐标为负），改为对同一个下拉项做 DOM 点击
    if (!/not clickable|unavailable/i.test(String(err && err.message))) throw err;
    await inPage(page, guard, () => { const e = document.querySelector('[data-abb-qf-item="1"]'); if (e) e.click(); return !!e; });
  }
  await cdp.waitFor(page, `(() => { const onTop = (e) => { const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return false; const h = document.elementFromPoint(r.x + Math.min(r.width / 2, 20), r.y + r.height / 2); return !!h && (h === e || e.contains(h) || h.contains(e)); }; const f = [...document.querySelectorAll('input.kd-defaultQuikerRow-partFileds')].find((e) => onTop(e)); return !!f && f.value.trim() === ${JSON.stringify(label)}; })()`, { timeoutMs: 5000 })
    .catch(async () => {
      const diag = await page.evalChecked(`(() => [...document.querySelectorAll('input.kd-defaultQuikerRow-partFileds')].map((e) => { const r = e.getBoundingClientRect(); return e.value + '@' + Math.round(r.x) + ',' + Math.round(r.y) + 'w' + Math.round(r.width); }).join(' | '))()`).catch(() => '');
      throw new Error(`Quick filter field did not switch to "${label}" (fields: ${diag})`);
    });
  await cdp.sleep(500);
  return { field: label, switched: true, from: cur };
}

// 第一个快捷过滤字段右侧的值输入框（placeholder 会随字段类型变化，不能靠它定位）
async function markQuickFilterValueInput(page, opts = {}) {
  const guard = guardOf(opts);
  return inPage(page, guard, () => {
    for (const el of document.querySelectorAll('[data-abb-qf-value]')) el.removeAttribute('data-abb-qf-value');
    const onTop = (e) => { const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return false; const h = document.elementFromPoint(r.x + Math.min(r.width / 2, 20), r.y + r.height / 2); return !!h && (h === e || e.contains(h) || h.contains(e)); };
    const field = [...document.querySelectorAll('input.kd-defaultQuikerRow-partFileds')].find((e) => onTop(e));
    if (!field) return false;
    const fr = field.getBoundingClientRect();
    let best = null;
    for (const el of document.querySelectorAll('input')) {
      const r = el.getBoundingClientRect();
      if (el === field || r.width < 60 || el.disabled || el.readOnly || !onTop(el)) continue;
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
  await assertSession(page);
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
  if (!found && opts.resetOnMiss) {
    // 可选：默认方案带日期等条件时，先“重置”再查一次（会改动当前列表的过滤状态，所以默认不做）
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
  await assertSession(page);
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
  let total = null;
  const until = Date.now() + (opts.serialTotalTimeoutMs || 10000);
  while (Date.now() < until) {
    total = await inPage(page, guard, () => {
      const m = /共计[:：]\s*(\d+)\s*条记录/.exec(document.body.innerText || '');
      return m ? Number(m[1]) : null;
    });
    if (total !== null) break;
    await cdp.sleep(300);
  }
  await cdp.sleep(300);
  return { opened: true, total };
}

// 列表行幂等单选勾选（不点蓝字单号/姓名超链接，避免误打开编辑页签占用网控锁；若已勾选则幂等保持，避免二次点击反选取消！）
async function selectGridRowByText(page, rowText, opts = {}) {
  const guard = opts.guard || K3_ADMIN_GUARD;
  if (!rowText || !String(rowText).trim()) throw new Error('selectGridRowByText requires rowText');
  await assertSession(page);
  const exclusive = opts.exclusive !== false;

  const inspectRows = async () => inPage(page, guard, (arg) => {
    for (const el of document.querySelectorAll('[data-abb-row-sel],[data-abb-row-unsel]')) {
      el.removeAttribute('data-abb-row-sel');
      el.removeAttribute('data-abb-row-unsel');
    }
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    const want = norm(arg.rowText);
    const extra = arg.alsoIncludes ? norm(arg.alsoIncludes) : '';
    const isRowChecked = (tr) => {
      const cb = tr.querySelector('input[type="checkbox"]');
      if (cb) return Boolean(cb.checked);
      return tr.classList.contains('k-state-selected') || tr.getAttribute('aria-selected') === 'true';
    };
    const pickClickBox = (tr) => (
      [tr.querySelector('.kd-grid-selector'), tr.querySelector('span.k-checkbox'), tr.querySelector('.kd-grid-checkbox'), tr.querySelector('input[type="checkbox"]'), tr.querySelector('td:first-child')].find((e) => e && vis(e))
      || [...tr.querySelectorAll('td')].find((td) => vis(td) && !td.querySelector('a.type-link'))
      || tr
    );

    const rows = [...document.querySelectorAll('.k-grid-content tr, tr[data-uid], div[id*="FLIST"] tr')].filter(vis);
    let targetTr = null;
    for (const tr of rows) {
      const txt = norm(tr.innerText || '');
      if (!txt.includes(want)) continue;
      if (extra && !txt.includes(extra)) continue;
      targetTr = tr;
      break;
    }
    if (!targetTr) return { found: false };

    if (arg.exclusive) {
      for (const tr of rows) {
        if (tr === targetTr) continue;
        if (isRowChecked(tr)) {
          const box = pickClickBox(tr);
          box.setAttribute('data-abb-row-unsel', '1');
          return {
            found: true,
            needUnselectOther: true,
            checked: isRowChecked(targetTr),
            summary: (targetTr.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120),
          };
        }
      }
    }

    targetTr.scrollIntoView({ block: 'nearest' });
    const checked = isRowChecked(targetTr);
    const target = pickClickBox(targetTr);
    target.setAttribute('data-abb-row-sel', '1');
    return {
      found: true,
      needUnselectOther: false,
      checked,
      summary: (targetTr.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    };
  }, { rowText: String(rowText), alsoIncludes: opts.alsoIncludes || '', exclusive });

  let state = await inspectRows();
  if (!state || !state.found) {
    throw new Error(`Grid row matching "${rowText}" not found in visible K3Cloud grid`);
  }

  let guardLoops = 0;
  while (state.needUnselectOther && guardLoops < 10) {
    guardLoops += 1;
    await cdp.clickByBox(page, '[data-abb-row-unsel="1"]', guard, { parkPointer: true });
    await cdp.sleep(150);
    state = await inspectRows();
  }

  if (state.checked) {
    return { selected: true, alreadySelected: true, rowSummary: state.summary };
  }

  await cdp.clickByBox(page, '[data-abb-row-sel="1"]', guard, { parkPointer: true });
  await cdp.sleep(250);
  const after = await inspectRows();
  return { selected: Boolean(after && after.checked), alreadySelected: false, rowSummary: state.summary };
}

// 工具栏拆分按钮下拉菜单点击（如“密码策略 ▼ → 重置密码”“重置密码 ▼ → 重置密码”“业务操作 ▼ → 序列号”）
// 关键修复：
// 1. 点击拆分箭头/父按钮时绝不移走鼠标（keepHover: true），避免 Kendo hover 弹层自毁收起；
// 2. 等待 Kendo .k-animation-container 下滑动画稳定（默认 320ms）再采集坐标，避免动画中途误点导致弹层悬停不触发；
// 3. 仅命中无子级 ul 的叶子菜单项（优先 span.kdmenuitem-content / a.k-link 且位于工具栏按钮下方）。
async function clickSplitMenuOption(page, parentLabel, itemLabel, opts = {}) {
  const guard = opts.guard || K3_ADMIN_GUARD;
  const targetItem = itemLabel || parentLabel;
  if (!parentLabel) throw new Error('clickSplitMenuOption requires parentLabel');
  await assertSession(page);

  const info = await inPage(page, guard, (parentTxt) => {
    for (const el of document.querySelectorAll('[data-abb-split-arrow],[data-abb-split-btn]')) {
      el.removeAttribute('data-abb-split-arrow');
      el.removeAttribute('data-abb-split-btn');
    }
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width >= 6 && r.height >= 6; };
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    const want = norm(parentTxt);
    for (const span of document.querySelectorAll('span.kdmenuitem-content, .kd-toolbar-item span, li.k-item span.k-link')) {
      if (!vis(span) || norm(span.innerText) !== want) continue;
      // 跳过已在弹出层内的同名子项，确保第一步点的是主工具栏父按钮
      if (span.closest('.k-animation-container, ul.k-popup, .kd-menu-popup')) continue;
      const split = span.closest('li.kdmenuitem-splitbutton, .k-split-button, li.k-item');
      const arrow = split && [...split.querySelectorAll('.k-i-arrow-s, .k-i-arrow-60-down, .kd-splitbutton-arrow, .k-select')].find(vis);
      const anchorRect = (split || span).getBoundingClientRect();
      if (arrow) {
        arrow.setAttribute('data-abb-split-arrow', '1');
        return { mode: 'split-arrow', triggerBottom: Math.round(anchorRect.bottom) };
      }
      span.setAttribute('data-abb-split-btn', '1');
      return { mode: 'direct-button', triggerBottom: Math.round(anchorRect.bottom) };
    }
    return { mode: 'missing', triggerBottom: 0 };
  }, parentLabel);

  if (!info || info.mode === 'missing') {
    throw new Error(`Toolbar button "${parentLabel}" not found`);
  }

  if (info.mode === 'direct-button' && normStr(parentLabel) === normStr(targetItem)) {
    await cdp.clickByBox(page, '[data-abb-split-btn="1"]', guard, { parkPointer: true });
    return { clicked: true, mode: 'direct-button' };
  }

  const openSel = info.mode === 'split-arrow' ? '[data-abb-split-arrow="1"]' : '[data-abb-split-btn="1"]';
  await cdp.clickByBox(page, openSel, guard, { keepHover: true });
  // 等待 Kendo UI .k-animation-container 下拉动画完全展开到位（约 200~260ms）
  await cdp.sleep(opts.openSettleMs ?? 320);

  let itemMarked = false;
  const until = Date.now() + (opts.menuTimeoutMs || 3000);
  while (Date.now() < until) {
    itemMarked = await inPage(page, guard, (wantTxt, minTop) => {
      for (const el of document.querySelectorAll('[data-abb-split-item]')) el.removeAttribute('data-abb-split-item');
      const vis = (e) => {
        const st = window.getComputedStyle(e);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
        const r = e.getBoundingClientRect();
        return r.width >= 10 && r.height >= 10;
      };
      const norm = (s) => String(s || '').replace(/\s+/g, '');
      const want = norm(wantTxt);
      const popups = [...document.querySelectorAll('.k-animation-container ul, ul.k-popup, .kd-menu-popup, ul.k-group')].filter(vis);
      const roots = popups.length ? popups : [document];
      for (const root of roots) {
        // 优先命中内层文本/链接节点，其次才是无子菜单的叶子 li.k-item
        const candidates = [
          ...root.querySelectorAll('span.kdmenuitem-content, a.k-link, span.k-link'),
          ...root.querySelectorAll('li.k-item'),
        ];
        for (const el of candidates) {
          if (!vis(el) || norm(el.innerText) !== want) continue;
          if (el.hasAttribute('data-abb-split-btn')) continue;
          if (el.tagName === 'LI' && el.querySelector('ul')) continue;
          const r = el.getBoundingClientRect();
          if (!popups.length) {
            if (el.closest('li.kdmenuitem-splitbutton') && !el.closest('.k-animation-container')) continue;
            if (minTop > 0 && r.top < minTop - 6) continue;
          }
          el.setAttribute('data-abb-split-item', '1');
          return true;
        }
      }
      return false;
    }, targetItem, info.triggerBottom || 0);
    if (itemMarked) break;
    await cdp.sleep(150);
  }

  if (!itemMarked) {
    throw new Error(`Dropdown option "${targetItem}" did not appear after opening "${parentLabel}"`);
  }
  await cdp.clickByBox(page, '[data-abb-split-item="1"]', guard, { parkPointer: true });
  return { clicked: true, mode: 'popup-item' };
}

function normStr(s) {
  return String(s || '').replace(/\s+/g, '');
}

// 金蝶管理中心 administrator“二次认证”模态框填写与提交（绝不打印或返回明文密码）
// 自动锁定最顶层可见 .k-window、执行真实物理点击聚焦 + blur 同步 MVVM 后点击确定
async function submitK3Admin2FA(page, adminPassword, opts = {}) {
  const guard = opts.guard || K3_ADMIN_GUARD;
  if (typeof adminPassword !== 'string' || !adminPassword) {
    throw new Error('submitK3Admin2FA requires non-empty adminPassword string');
  }
  const marked = await inPage(page, guard, () => {
    for (const el of document.querySelectorAll('[data-abb-k3-2fa-pwd],[data-abb-k3-2fa-ok]')) {
      el.removeAttribute('data-abb-k3-2fa-pwd');
      el.removeAttribute('data-abb-k3-2fa-ok');
    }
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width >= 8 && r.height >= 8; };
    const modals = [...document.querySelectorAll('.k-window, [role="dialog"]')].filter(vis)
      .filter((w) => /二次认证|身份验证|管理员密码|密码验证/.test(w.innerText || '') || w.querySelector('input[type="password"]'));
    if (!modals.length) return { found: false };
    modals.sort((a, b) => (parseFloat(getComputedStyle(a).zIndex) || 0) - (parseFloat(getComputedStyle(b).zIndex) || 0));
    const top = modals[modals.length - 1];
    const pwd = [...top.querySelectorAll('input[type="password"], input')].find((i) => vis(i) && !i.disabled && !i.readOnly && (i.type === 'password' || /密码/.test(i.placeholder || '')));
    if (!pwd) return { found: false, reason: 'password-input-missing' };
    const okBtn = [...top.querySelectorAll('a, button, input[type="button"], span.kd-btn, span.k-button')].find((b) => vis(b) && /^(确定|提交|验证|确认|OK)$/i.test((b.innerText || b.value || '').trim()));
    pwd.setAttribute('data-abb-k3-2fa-pwd', '1');
    if (okBtn) okBtn.setAttribute('data-abb-k3-2fa-ok', '1');
    return { found: true, hasOk: Boolean(okBtn), title: (top.querySelector('.k-window-title')?.innerText || '二次认证').trim() };
  });

  if (!marked || !marked.found) {
    throw new Error('Active K3Cloud 2FA modal (.k-window) not found');
  }
  await cdp.fillNative(page, '[data-abb-k3-2fa-pwd="1"]', adminPassword, guard, { physicalFocus: true, blur: true });
  await cdp.sleep(150);
  if (marked.hasOk) {
    await cdp.clickByBox(page, '[data-abb-k3-2fa-ok="1"]', guard, { parkPointer: true });
  } else {
    await cdp.pressKey(page, 'Enter', guard);
  }
  await cdp.sleep(500);
  return { submitted: true, modalTitle: marked.title };
}

// 顶层金蝶提示框或顶部黄条按钮确认（如“是 / 否 / 确定 / 取消”，同时支持 .k-window 与 .kd-el-popmessage 浮层）
async function confirmK3Modal(page, buttonLabel = '确定', opts = {}) {
  const guard = opts.guard || K3_ADMIN_GUARD;
  const marked = await inPage(page, guard, (wantBtn) => {
    for (const el of document.querySelectorAll('[data-abb-k3-modal-btn]')) el.removeAttribute('data-abb-k3-modal-btn');
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width >= 8 && r.height >= 8; };
    const modals = [...document.querySelectorAll('.kd-el-popmessage, .kd-messagebox, .kd-msgbox, .k-window, [role="dialog"], [role="alertdialog"]')].filter(vis);
    if (!modals.length) return { found: false };
    // 若存在内联浮层 .kd-el-popmessage（如“密码即将修改，请确认！”），优先匹配浮层按钮，其次按 z-index 从高到低匹配弹窗
    modals.sort((a, b) => {
      const aPop = a.classList.contains('kd-el-popmessage') ? 1 : 0;
      const bPop = b.classList.contains('kd-el-popmessage') ? 1 : 0;
      if (aPop !== bPop) return aPop - bPop;
      return (parseFloat(getComputedStyle(a).zIndex) || 0) - (parseFloat(getComputedStyle(b).zIndex) || 0);
    });
    const want = String(wantBtn || '').trim();
    for (let i = modals.length - 1; i >= 0; i -= 1) {
      const m = modals[i];
      const btn = [...m.querySelectorAll('a, button, input[type="button"], span')].find((b) => {
        if (!vis(b)) return false;
        const t = String(b.innerText || b.value || '').trim();
        return t === want;
      });
      if (btn) {
        btn.setAttribute('data-abb-k3-modal-btn', '1');
        return { found: true, modalText: (m.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160) };
      }
    }
    const top = modals[modals.length - 1];
    return { found: false, modalText: (top.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160) };
  }, buttonLabel);
  if (!marked || !marked.found) {
    throw new Error(`Modal button "${buttonLabel}" not found${marked?.modalText ? ' in: ' + marked.modalText : ''}`);
  }
  await cdp.clickByBox(page, '[data-abb-k3-modal-btn="1"]', guard, { parkPointer: true });
  await cdp.sleep(300);
  return { clicked: true, button: buttonLabel, modalText: marked.modalText };
}

module.exports = {
  K3_GUARD,
  K3_ADMIN_GUARD,
  assertSession,
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
  selectGridRowByText,
  clickSplitMenuOption,
  submitK3Admin2FA,
  confirmK3Modal,
};
