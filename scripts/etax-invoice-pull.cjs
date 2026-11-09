#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cdp = require('../lib/cdp');

const LOGIN_URL = 'https://etax.guangdong.chinatax.gov.cn:8443/loginb/';
const QUERY_URL = 'https://dppt.guangdong.chinatax.gov.cn:8443/invoice-query/invoice-query';
const BATCH_URL = 'https://dppt.guangdong.chinatax.gov.cn:8443/importing-exporting-batches-search';
const QUERY_GUARD = 'location.href.includes("invoice-query")';
const BATCH_GUARD = 'location.href.includes("importing-exporting-batches-search")';
const cmd = process.argv[2] || 'status';
const cmdArg = process.argv[3] || '';

function envBridge() {
  process.env.CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9224';
  process.env.BROWSER_BRIDGE_REQUIRE_INSTANCE = process.env.BROWSER_BRIDGE_REQUIRE_INSTANCE || '1';
  process.env.BROWSER_BRIDGE_EXPECT_PROFILE =
    process.env.BROWSER_BRIDGE_EXPECT_PROFILE ||
    path.join(process.env.LOCALAPPDATA, 'AgentBrowserBridge', 'profiles', 'Edge-K3Cloud');
  process.env.BROWSER_BRIDGE_EXPECT_PROXY = process.env.BROWSER_BRIDGE_EXPECT_PROXY || 'none';
  process.env.BROWSER_BRIDGE_EXPECT_BROWSER = process.env.BROWSER_BRIDGE_EXPECT_BROWSER || 'edge';
}

function todayDir() {
  const stamp = new Date();
  const y = stamp.getFullYear();
  const m = String(stamp.getMonth() + 1).padStart(2, '0');
  const d = String(stamp.getDate()).padStart(2, '0');
  return process.env.ETAX_SAMPLE_DIR || path.join(process.env.LOCALAPPDATA, 'GkIT', 'etax-invoice-samples', `${y}-${m}-${d}`);
}

function loadSkip(filePath) {
  if (!filePath) return new Set();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const nums = raw.numbers || raw.invoices || [];
  return new Set(nums.map((item) => String(item.number || item)));
}

function polishDownloads(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    const buf = fs.readFileSync(full);
    let dest = full;
    if (buf.slice(0, 2).toString() === 'PK' && !/\.zip$/i.test(name)) {
      dest = `${full}.zip`;
      fs.renameSync(full, dest);
    } else if (buf.slice(0, 5).toString() === '%PDF-' && !/\.pdf$/i.test(name)) {
      dest = `${full}.pdf`;
      fs.renameSync(full, dest);
    } else if (/<\?xml|<EInvoice|<Invoice/i.test(buf.slice(0, 120).toString('utf8')) && !/\.xml$/i.test(name)) {
      dest = `${full}.xml`;
      fs.renameSync(full, dest);
    }
    out.push({ name: path.basename(dest), bytes: fs.statSync(dest).size });
  }
  return out;
}

async function attachByUrl(browser, includes) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const targets = await cdp.listTargets(browser);
      let pick = null;
      if (includes === 'invoice-query') {
        const pages = targets.filter((item) => item.type === 'page' && (item.url || '').includes('invoice-query'));
        pick = pages.find((item) => /\/invoice-query\/invoice-query/.test(item.url || '') && !(item.url || '').includes('third-menu'))
          || pages[0]
          || null;
      } else {
        pick = cdp.findPageByUrl(targets, { urlIncludes: includes });
      }
      if (!pick) return null;
      const page = await cdp.attachTarget(browser, pick.id);
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      await browser.send('Target.activateTarget', { targetId: pick.id });
      return { pick, page };
    } catch (error) {
      if (!/Session with given id not found|CDP disconnected|Target closed/i.test(error.message || '')) throw error;
      await cdp.sleep(500);
    }
  }
  return null;
}

async function openUrl(browser, url, includes) {
  let pair = await attachByUrl(browser, includes);
  if (pair) {
    if (url.includes('/invoice-query/invoice-query')) {
      const href = await pair.page.evalChecked(`location.href`).catch(() => '');
      if (!href || href.includes('third-menu') || !/查询类型/.test(await pair.page.evalChecked(`document.body.innerText || ''`))) {
        await cdp.navigateAndWait(pair.page, url, 8000);
        await cdp.sleep(1500);
      }
    }
    return pair;
  }
  const created = await browser.send('Target.createTarget', { url });
  const page = await cdp.attachTarget(browser, created.targetId);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await cdp.navigateAndWait(page, url, 12000);
  await cdp.sleep(1500);
  return { page, pick: { id: created.targetId } };
}

async function mark(page, expression) {
  return Boolean(await page.evalChecked(expression));
}

async function markClick(page, expression, selector, guard) {
  if (!(await mark(page, expression))) return false;
  await cdp.sleep(200);
  await cdp.clickByBox(page, selector, guard);
  return true;
}

function parseRows(textRows) {
  return textRows.map((text, i) => {
    const nums = text.match(/\d{16,20}/g) || [];
    const number = nums.find((n) => n.length >= 16) || '';
    const when = (text.match(/\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?/) || [''])[0];
    return {
      i,
      number,
      last4: number.slice(-4),
      status: /已冲红/.test(text) ? '已冲红' : /红字|负数/.test(text) ? '红字' : '正常',
      date: when.slice(0, 10),
      seller: text.slice(0, 180),
      text: text.slice(0, 240)
    };
  }).filter((row) => row.number);
}

async function queryFormReady(page) {
  return Boolean(await page.evalChecked(`(() => {
    const text = document.body.innerText || '';
    const typeVal = (document.querySelector('.t-form-item__gjbq input.t-input__inner') || {}).value || '';
    return /查询类型/.test(text) && /取得发票|开具发票/.test(typeVal);
  })()`));
}

async function ensureQueryPage(page) {
  const href = await page.evalChecked(`location.href`);
  if (href && href.includes('third-menu')) {
    await cdp.navigateAndWait(page, QUERY_URL, 8000);
    await cdp.sleep(1500);
  }
}

async function ensureObtained(page) {
  await ensureQueryPage(page);
  if (!(await queryFormReady(page))) {
    const clicked = await markClick(page, `(() => {
      const el = [...document.querySelectorAll('a,button,span,div,li')].find((node) => {
        const t = (node.innerText || '').replace(/\\s+/g, '').trim();
        const r = node.getBoundingClientRect();
        return t === '全量发票查询' && r.width >= 80 && r.height >= 20 && r.y >= 0;
      });
      if (!el) return false;
      el.setAttribute('data-gc-etax', 'all-query');
      return true;
    })()`, '[data-gc-etax="all-query"]', 'location.href.includes("invoice-query")').catch(() => false);
    if (!clicked) {
      await cdp.navigateAndWait(page, QUERY_URL, 8000);
    }
    await cdp.sleep(2500);
  }
  if (!(await queryFormReady(page))) {
    throw new Error('invoice query form not ready');
  }
  const typeVal = await page.evalChecked(`(() => (document.querySelector('.t-form-item__gjbq input.t-input__inner') || {}).value || '')`);
  if (typeVal !== '取得发票') {
    await page.evalChecked(`(() => {
      const el = document.querySelector('.t-form-item__gjbq input.t-input__inner');
      if (el) el.click();
      return true;
    })()`);
    await cdp.sleep(600);
    await page.evalChecked(`(() => {
      const opt = [...document.querySelectorAll('.t-select-option, li, div, span')].find((el) => (el.innerText || '').trim() === '取得发票');
      if (opt) opt.click();
      return true;
    })()`);
    await cdp.sleep(400);
    await page.evalChecked(`(() => {
      const el = [...document.querySelectorAll('button,span,div,a')].find((node) => {
        const t = (node.innerText || '').replace(/\\s+/g, '').trim();
        const r = node.getBoundingClientRect();
        return t === '全量' && r.width >= 24 && r.width <= 90 && r.height >= 16 && r.y >= 0 && r.y < 420;
      });
      if (el) el.click();
      return true;
    })()`);
    await cdp.sleep(400);
    await page.evalChecked(`(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => (el.innerText || '').trim() === '查询');
      if (btn) btn.click();
      return true;
    })()`);
    await cdp.sleep(4000);
  }
}

async function readPageRows(page) {
  const data = await page.evalChecked(`(() => {
    const rows = [...document.querySelectorAll('tbody tr, .t-table__body tr')].map((tr) => (tr.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
    const total = ((document.body.innerText || '').match(/共\\s*(\\d+)\\s*条/) || [])[1] || '';
    return { rows, total };
  })()`);
  return {
    total: Number((data && data.total) || 0),
    invoices: parseRows((data && data.rows) || [])
  };
}

async function gotoFirst(page) {
  const ok = await markClick(page, `(() => {
    const one = [...document.querySelectorAll('.t-pagination__number')].find((el) => (el.innerText || '').trim() === '1');
    if (!one) return false;
    one.setAttribute('data-gc-etax', 'page-1');
    one.scrollIntoView({ block: 'nearest' });
    return true;
  })()`, '[data-gc-etax="page-1"]', QUERY_GUARD).catch(() => false);
  if (ok) await cdp.sleep(1500);
}

async function gotoNext(page) {
  const marker = await page.evalChecked(`(() => {
    const row = document.querySelector('tbody tr, .t-table__body tr');
    return (row && (row.innerText || '').slice(0, 40)) || '';
  })()`);
  const clicked = await markClick(page, `(() => {
    const btn = [...document.querySelectorAll('.t-pagination__btn-next')].find((el) => {
      const r = el.getBoundingClientRect();
      const cls = (el.className || '').toString();
      return r.width >= 8 && r.height >= 8 && !/t-is-disabled|disabled/.test(cls);
    });
    if (!btn) return false;
    btn.setAttribute('data-gc-etax', 'page-next');
    btn.scrollIntoView({ block: 'nearest' });
    return true;
  })()`, '[data-gc-etax="page-next"]', QUERY_GUARD).catch(() => false);
  if (!clicked) return false;
  for (let i = 0; i < 20; i += 1) {
    await cdp.sleep(300);
    const now = await page.evalChecked(`(() => {
      const row = document.querySelector('tbody tr, .t-table__body tr');
      return (row && (row.innerText || '').slice(0, 40)) || '';
    })()`);
    if (now && now !== marker) return true;
  }
  return true;
}

async function tryPageSize(page, want) {
  const opened = await markClick(page, `(() => {
    const wrap = document.querySelector('.t-pagination__select');
    if (!wrap) return false;
    wrap.setAttribute('data-gc-etax', 'page-size');
    wrap.scrollIntoView({ block: 'nearest' });
    return true;
  })()`, '[data-gc-etax="page-size"]', QUERY_GUARD).catch(() => false);
  if (!opened) return false;
  await cdp.sleep(500);
  const picked = await markClick(page, `(() => {
    const opt = [...document.querySelectorAll('.t-select-option, li, div, span')].find((el) => {
      const t = (el.innerText || '').replace(/\\s+/g, '');
      return t === '${want}条/页' || t === String(${want});
    });
    if (!opt) return false;
    opt.setAttribute('data-gc-etax', 'page-size-opt');
    return true;
  })()`, '[data-gc-etax="page-size-opt"]', QUERY_GUARD).catch(() => false);
  if (picked) await cdp.sleep(2500);
  return picked;
}

async function cmdStatus(browser) {
  const pages = (await cdp.listTargets(browser)).filter((item) => item.type === 'page').map((item) => ({
    title: item.title,
    url: (item.url || '').split('?')[0]
  }));
  let identity = { enterprise: false, natural: false, org: '' };
  const home = await attachByUrl(browser, 'etax.guangdong.chinatax.gov.cn');
  if (home) {
    identity = await home.page.evalChecked(`(() => {
      const text = document.body.innerText || '';
      return {
        natural: /自然人/.test(text) && !/股份有限公司|有限公司/.test(text),
        enterprise: /广州高昌/.test(text) || /一般纳税人/.test(text),
        org: (text.match(/广州高昌[^\\s]{0,20}/) || [])[0] || '',
        hasAccount: text.includes('税务数字账户')
      };
    })()`) || identity;
  }
  const query = Boolean(cdp.findPageByUrl(await cdp.listTargets(browser), { urlIncludes: 'invoice-query' }));
  console.log(JSON.stringify({ ok: identity.enterprise || query, pages, identity, hasQuery: query }, null, 2));
}

async function cmdWaitLogin(browser) {
  for (let i = 0; i < 90; i += 1) {
    const home = await attachByUrl(browser, 'chinatax.gov.cn');
    if (home) {
      const val = await home.page.evalChecked(`(() => {
        const text = document.body.innerText || '';
        return {
          enterprise: /广州高昌/.test(text),
          natural: text.includes('自然人') && !text.includes('广州高昌')
        };
      })()`);
      if (val && val.enterprise) {
        console.log(JSON.stringify({ ok: true, waited: i, identity: 'enterprise' }));
        return;
      }
    }
    await cdp.sleep(2000);
  }
  throw new Error('wait login timeout: need enterprise 广州高昌');
}

async function collectAll(page) {
  await ensureObtained(page);
  await tryPageSize(page, 100);
  await gotoFirst(page);
  const all = [];
  let total = 0;
  for (let pageNo = 0; pageNo < 30; pageNo += 1) {
    const chunk = await readPageRows(page);
    total = chunk.total || total;
    for (const row of chunk.invoices) {
      if (!all.some((item) => item.number === row.number)) all.push(row);
    }
    if (all.length >= total && total > 0) break;
    if (!(await gotoNext(page))) break;
    await cdp.sleep(800);
  }
  return { total, invoices: all };
}

async function cmdList(browser) {
  const pair = await openUrl(browser, QUERY_URL, 'invoice-query');
  const data = await collectAll(pair.page);
  console.log(JSON.stringify({ ok: true, count: data.invoices.length, total: data.total, invoices: data.invoices }, null, 2));
}

async function enableDownload(browser, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const events = [];
  try {
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true });
  } catch {
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true }).catch(() => {});
  }
  browser.on('Browser.downloadWillBegin', (params) => events.push({ event: 'begin', guid: params.guid, name: params.suggestedFilename }));
  browser.on('Browser.downloadProgress', (params) => {
    if (params.state === 'completed' || params.state === 'canceled') events.push({ event: params.state, guid: params.guid });
  });
  return events;
}

async function selectMissing(page, skip, dateFrom) {
  return page.evalChecked(`(() => {
    const skip = new Set(${JSON.stringify([...skip])});
    const dateFrom = ${JSON.stringify(dateFrom || '')};
    const rows = [...document.querySelectorAll('tbody tr, .t-table__body tr')];
    const wanted = [];
    const skippedRows = [];
    for (const tr of rows) {
      const text = (tr.innerText || '').replace(/\\s+/g, ' ').trim();
      const nums = text.match(/\\d{16,20}/g) || [];
      const number = nums.find((n) => n.length >= 16) || '';
      if (!number) continue;
      const when = (text.match(/\\d{4}-\\d{2}-\\d{2}/) || [''])[0];
      const box = tr.querySelector('input[type="checkbox"], .t-checkbox');
      if (!box) continue;
      if (skip.has(number) || (dateFrom && when && when < dateFrom)) {
        skippedRows.push({ tr, box, number });
        continue;
      }
      wanted.push({ tr, box, number, last4: number.slice(-4) });
    }
    for (const item of wanted) {
      item.tr.scrollIntoView({ block: 'nearest' });
      const wrap = item.box.closest ? item.box.closest('.t-checkbox') : item.box;
      const checked = item.box.checked || /t-is-checked/.test((wrap.className || item.box.className || '').toString());
      if (!checked) wrap.click();
    }
    return wanted.map((item) => ({ number: item.number, last4: item.last4 }));
  })()`);
}

async function submitSelected(page, format) {
  const opened = await markClick(page, `(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => {
      const t = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      return t === '下载' && !el.closest('tbody') && r.width >= 32;
    });
    if (!btn) return false;
    btn.scrollIntoView({ block: 'center' });
    btn.setAttribute('data-gc-etax', 'toolbar-download');
    return true;
  })()`, '[data-gc-etax="toolbar-download"]', QUERY_GUARD);
  if (!opened) throw new Error('no toolbar 下载');
  await cdp.sleep(700);
  const selected = await markClick(page, `(() => {
    const opt = [...document.querySelectorAll('.t-dropdown__item, li, span, div, button')].find((el) => {
      const t = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      return (t === '下载选中' || t === '下载为XML') && r.width >= 24 && r.height >= 12 && r.y >= 0 && r.y < 900;
    });
    if (!opt) return false;
    opt.setAttribute('data-gc-etax', 'dl-selected');
    return true;
  })()`, '[data-gc-etax="dl-selected"]', QUERY_GUARD);
  if (!selected) throw new Error('no 下载选中');
  await cdp.sleep(1000);
  const wantFmt = format === 'pdf' ? 'PDF文件' : 'XML文件';
  const hasFmt = await page.evalChecked(`(() => {
    const dialog = [...document.querySelectorAll('.t-dialog')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 200 && r.height >= 80 && /文件下载类型/.test(el.innerText || '');
    });
    if (!dialog) return false;
    const want = ${JSON.stringify(wantFmt)};
    for (const box of [...dialog.querySelectorAll('.t-checkbox')]) {
      const t = (box.innerText || '').trim();
      const on = /t-is-checked/.test((box.className || '').toString());
      if (t === want && !on) box.click();
      if ((t === 'PDF文件' || t === 'OFD文件' || t === 'XML文件') && t !== want && on) box.click();
    }
    return true;
  })()`);
  await cdp.sleep(400);
  const ok = await markClick(page, `(() => {
    const dialog = [...document.querySelectorAll('.t-dialog')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 200 && r.height >= 80 && /XML文件|PDF文件/.test(el.innerText || '');
    });
    if (!dialog) return false;
    const btn = [...dialog.querySelectorAll('button, .t-button')].find((el) => (el.innerText || '').trim() === '确认' && el.getBoundingClientRect().width >= 16);
    if (!btn) return false;
    btn.setAttribute('data-gc-etax', 'fmt-ok');
    return true;
  })()`, '[data-gc-etax="fmt-ok"]', QUERY_GUARD);
  if (!ok) throw new Error('no confirm');
  await cdp.sleep(1500);
  await markClick(page, `(() => {
    const dialog = [...document.querySelectorAll('.t-dialog')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 200 && r.height >= 80 && /提交成功|我知道了/.test(el.innerText || '');
    });
    if (!dialog) return false;
    const btn = [...dialog.querySelectorAll('button, .t-button')].find((el) => (el.innerText || '').trim() === '我知道了');
    if (!btn) return false;
    btn.setAttribute('data-gc-etax', 'got-it');
    return true;
  })()`, '[data-gc-etax="got-it"]', QUERY_GUARD).catch(() => false);
  await cdp.sleep(400);
  return { opened, hasFmt, ok };
}

function batchKey(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const when = (t.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/) || [''])[0];
  const who = (t.match(/发票批量下载\s+(\S+)/) || [])[1] || '';
  return when ? `${who} ${when}` : t.replace(/^\d+\s+/, '');
}

async function listBatchRows(page) {
  return page.evalChecked(`(() => [...document.querySelectorAll('tr')].map((tr) => (tr.innerText || '').replace(/\\s+/g, ' ').trim()).filter((t) => t.includes('发票批量下载') || t.includes('发票下载')).slice(0, 10))()`) || [];
}

async function waitAndFetchBatch(browser, sinceMs, dir, knownRows) {
  const pair = await openUrl(browser, BATCH_URL, 'importing-exporting-batches-search');
  const known = new Set((knownRows || []).map((row) => batchKey(row)));
  const deadline = Date.now() + 1800000;
  let lastRows = [];
  let doneRow = '';
  while (Date.now() < deadline) {
    lastRows = await listBatchRows(pair.page);
    doneRow = lastRows.find((t) => /处理完成|成功/.test(t) && !/待处理|处理中/.test(t) && !known.has(batchKey(t))) || '';
    if (doneRow) break;
    await markClick(pair.page, `(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => /查询|刷新/.test((el.innerText || '').trim()));
      if (!btn) return false;
      btn.setAttribute('data-gc-etax', 'batch-refresh');
      return true;
    })()`, '[data-gc-etax="batch-refresh"]', BATCH_GUARD).catch(() => false);
    await cdp.sleep(4000);
  }
  const hasBtn = await mark(pair.page, `(() => {
    const known = ${JSON.stringify([...(knownRows || [])].map((row) => batchKey(row)))};
    const keyOf = (t) => {
      const when = (t.match(/\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}/) || [''])[0];
      const who = (t.match(/发票批量下载\\s+(\\S+)/) || [])[1] || '';
      return when ? (who + ' ' + when) : t.replace(/^\\d+\\s+/, '');
    };
    const tr = [...document.querySelectorAll('tr')].find((el) => {
      const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      return (/发票批量下载|发票下载/.test(t) && /处理完成|成功/.test(t) && !/待处理|处理中/.test(t) && !known.includes(keyOf(t)));
    });
    if (!tr) return false;
    const btn = [...tr.querySelectorAll('a,button,span')].find((el) => (el.innerText || '').trim() === '下载');
    if (!btn) return false;
    btn.setAttribute('data-gc-etax', 'batch-dl');
    return true;
  })()`);
  if (!hasBtn) return { ok: false, reason: 'batch not finished', rows: lastRows, files: polishDownloads(dir) };
  await cdp.clickByBox(pair.page, '[data-gc-etax="batch-dl"]', BATCH_GUARD);
  await cdp.sleep(6000);
  return { ok: true, doneRow, rows: lastRows, files: polishDownloads(dir), waitedMs: Date.now() - sinceMs };
}

async function cmdDownload(browser, format) {
  const skip = loadSkip(cmdArg);
  const dateFrom = process.env.ETAX_DATE_FROM || '';
  const dir = path.join(todayDir(), format === 'pdf' ? 'pdf' : 'xml-batch');
  const events = await enableDownload(browser, dir);
  const query = await openUrl(browser, QUERY_URL, 'invoice-query');
  await ensureObtained(query.page);
  await tryPageSize(query.page, 100);
  await gotoFirst(query.page);
  const submitted = [];
  const fetched = [];
  for (let pageNo = 0; pageNo < 30; pageNo += 1) {
    const picked = await selectMissing(query.page, skip, dateFrom);
    await query.page.evalChecked(`(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => (el.innerText || '').trim() === '下载' && !el.closest('tbody'));
      if (btn) btn.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await cdp.sleep(400);
    if (picked.length) {
      const batchPair = await openUrl(browser, BATCH_URL, 'importing-exporting-batches-search');
      const knownRows = await listBatchRows(batchPair.page);
      await browser.send('Target.activateTarget', { targetId: query.pick.id });
      await cdp.sleep(400);
      const sinceMs = Date.now();
      const submit = await submitSelected(query.page, format);
      submitted.push({ page: pageNo + 1, count: picked.length, numbers: picked.map((x) => x.number), submit });
      fetched.push(await waitAndFetchBatch(browser, sinceMs, dir, knownRows));
      await browser.send('Target.activateTarget', { targetId: query.pick.id });
      await cdp.sleep(1000);
    }
    const chunk = await readPageRows(query.page);
    if (chunk.invoices.length === 0) break;
    const allKnown = chunk.total > 0 && (pageNo + 1) * Math.max(chunk.invoices.length, 1) >= chunk.total;
    if (allKnown && pageNo > 0 && !picked.length) break;
    if (!(await gotoNext(query.page))) break;
    await cdp.sleep(800);
  }
  console.log(JSON.stringify({
    ok: submitted.length > 0,
    format,
    skip: skip.size,
    dateFrom,
    submitted,
    fetched,
    downloads: events,
    files: polishDownloads(dir),
    dir
  }, null, 2));
}

async function cmdDownloadRows(browser) {
  const skip = loadSkip(cmdArg);
  const dir = path.join(todayDir(), 'xml-rows');
  const events = await enableDownload(browser, dir);
  const before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  const query = await openUrl(browser, QUERY_URL, 'invoice-query');
  await ensureObtained(query.page);
  await tryPageSize(query.page, 20);
  await gotoFirst(query.page);
  const got = [];
  const failed = [];
  for (let pageNo = 0; pageNo < 30; pageNo += 1) {
    const chunk = await readPageRows(query.page);
    const missing = chunk.invoices.filter((row) => !skip.has(row.number));
    for (const row of missing) {
      const marked = await query.page.evalChecked(`(() => {
        [...document.querySelectorAll('[data-gc-etax="row-dl"]')].forEach((el) => el.removeAttribute('data-gc-etax'));
        const tr = [...document.querySelectorAll('tbody tr, .t-table__body tr')].find((el) => (el.innerText || '').includes(${JSON.stringify(row.number)}));
        if (!tr) return false;
        tr.scrollIntoView({ block: 'center' });
        const dl = [...tr.querySelectorAll('a,span,button')].find((el) => (el.innerText || '').trim() === '下载');
        if (!dl) return false;
        dl.setAttribute('data-gc-etax', 'row-dl');
        return true;
      })()`);
      if (!marked) {
        failed.push({ number: row.number, reason: 'no row download' });
        continue;
      }
      try {
        await cdp.pressKey(query.page, 'Escape', QUERY_GUARD).catch(() => {});
        await cdp.sleep(200);
        await cdp.clickByBox(query.page, '[data-gc-etax="row-dl"]', QUERY_GUARD);
        await cdp.sleep(500);
        const xml = await markClick(query.page, `(() => {
          const opt = [...document.querySelectorAll('li,span,div,button,a')].find((el) => {
            const t = (el.innerText || '').trim();
            const r = el.getBoundingClientRect();
            return (t === '下载为XML' || t === 'XML文件' || t === 'XML') && r.width >= 16 && r.height >= 12 && r.y >= 0 && r.y < 900;
          });
          if (!opt) return false;
          opt.setAttribute('data-gc-etax', 'row-xml');
          return true;
        })()`, '[data-gc-etax="row-xml"]', QUERY_GUARD);
        if (!xml) {
          await cdp.pressKey(query.page, 'Escape', QUERY_GUARD).catch(() => {});
          failed.push({ number: row.number, reason: 'no 下载为XML' });
          continue;
        }
        await cdp.sleep(1800);
        got.push(row.number);
        skip.add(row.number);
      } catch (error) {
        failed.push({ number: row.number, reason: error.message });
      }
    }
    if (chunk.invoices.length === 0) break;
    if (chunk.total > 0 && (pageNo + 1) * Math.max(chunk.invoices.length, 1) >= chunk.total && missing.length === 0) break;
    if (!(await gotoNext(query.page))) break;
    await cdp.sleep(800);
  }
  console.log(JSON.stringify({
    ok: true,
    got: got.length,
    failed,
    downloads: events,
    files: polishDownloads(dir).filter((item) => !before.has(item.name.replace(/\.xml$/i, ''))),
    dir
  }, null, 2));
}

async function main() {
  envBridge();
  const browser = await cdp.connectBrowser({ timeoutMs: 20000 });
  await browser.ready;
  if (cmd === 'status') await cmdStatus(browser);
  else if (cmd === 'wait-login') await cmdWaitLogin(browser);
  else if (cmd === 'list') await cmdList(browser);
  else if (cmd === 'download-xml') await cmdDownload(browser, 'xml');
  else if (cmd === 'download-xml-rows') await cmdDownloadRows(browser);
  else if (cmd === 'download-pdf') await cmdDownload(browser, 'pdf');
  else throw new Error('unknown cmd ' + cmd);
  process.exit(0);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
