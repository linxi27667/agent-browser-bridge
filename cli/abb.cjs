#!/usr/bin/env node
// AgentBrowserBridge / GcWebAuto - 零仪式感状态化 CLI (cli/abb.cjs v0.7.2)
// 核心目标：
//   1. 免手填 5 个环境变量、免写临时 .ps1/.cjs 包装器：通过 --scene k3 | k3-admin | etax | chrome 自动完成严格实例校验绑定
//   2. @e1..@eN 快照引用跨进程持久化（落盘到 %LOCALAPPDATA%\AgentBrowserBridge\state），单步命令即看即点
//   3. 交互动作（click/fill/type/press/k3）执行后自动重采快照、更新 @ref 并输出增量 diff，一轮顶过去三轮
//   4. 敏感输入支持 --env <VAR> / --stdin，严禁明文密码上命令行或进日志

const fs = require('node:fs');
const path = require('node:path');
const sceneMod = require('../lib/cdp/scene');

function printHelp() {
  const hasUnified = fs.existsSync(path.join(__dirname, 'agent.cjs'));
  if (hasUnified) {
    console.log('[Unified Entry Notice] For general browser + desktop tasks, prefer: node cli/agent.cjs --help\n');
  }
  console.log(`Usage: node cli/abb.cjs [--scene <k3|k3-admin|etax|lceda|chrome|smoke>] [--port <N>] <command> [args] [flags]

Commands:
  scenes                              列出内置场景预设与当前本机存活的专用调试浏览器实例
  tabs                                列出目标实例当前打开的页面标签 (id / title / url)
  snap                                采集交互快照并持久化 e1..eN 引用 (支持 --find <词> --selector <css> --all)
  click <eN|'@eN'|locator>            点击元素（PowerShell 推荐直接写 e3 或 '@e3' 防 @ 展开；自动输出增量 UI Diff）
  hover <eN|'@eN'|locator>            悬停元素以展开 CSS :hover 隐藏按钮/菜单
  hover-click <hoverLoc> <clickLoc>   单锁原子悬停后立即点击悬停显现的按钮（如行内删除按钮）
  fill  <eN|'@eN'|locator> [text]     填写输入框（模态框自动物理点击聚焦+blur；密码请用 --env VAR 或 --stdin）
  type  <eN|'@eN'|locator> [text]     逐键安全输入（杜绝 keyDown+char 双倍字符；密码请用 --env VAR 或 --stdin）
  press <Enter|Tab|Escape>            发送安全按键并输出增量 UI Diff
  read  <eN|'@eN'|locator>            读取唯一元素的 value 或文本
  shot  [prefix]                      自动激活标签页并隐藏 HUD 截图（支持 --out <path.png> 或 --selector <loc>）
  k3    <action> [...]                金蝶云星空 / 管理中心快捷动作:
                                        open-list <菜单名> [--exclude <排除词>]
                                        filter-bill <单据编号> [--reset]
                                        select-row <行关键词> [--also <次关键词>]
                                        split-menu <主按钮名> [下拉子项名]
                                        admin-2fa --env <ADMIN_PWD_ENV>
                                        confirm [是|确定|否]
                                        close-tabs
  lceda <action> [...]                嘉立创EDA专业版 (pro.lceda.cn) 防休眠与插件自愈快捷动作:
                                        ensure [--project-uuid <uuid>] [--eext <path>] [--force]
                                        status
                                        import-ext [--eext <path>] [--force]
                                        reconnect

Global Flags:
  --scene <name>      场景预设 (默认 k3=9224; 管理中心 k3-admin=9232; 嘉立创 lceda=9234/9224; 公司 Chrome=9222)
  --port <number>     显式覆盖调试端口
  --url <substr>      按 URL 子串筛选标签页
  --target <id>       按精确 targetId 绑定标签页
  --guard <jsExpr>    显式覆盖上下文门禁表达式
  --read-only         开启只读拦截 (阻止点击 保存/提交/审核/删除 等写按钮)
  --find <keyword>    snap 时仅输出包含关键词的快照行（省 Token）
  --selector <loc>    snap 限定子树 / shot 截取指定唯一元素
  --all               snap 包含非交互文本节点
  --keep-hover        click 后保持鼠标悬停在原位（不归位到 (2,2)）
  --native            click 使用 DOM e.click() 替代物理坐标点击
  --blur              fill/type 后强制派发 blur/focusout 同步 MVVM
  --enter             fill/type 后自动按 Enter
  --env <VAR_NAME>    从当前环境变量读取敏感输入文本（零明文上命令行）
  --stdin             从标准输入读取文本
  --settle <ms>       动作后等待页面稳定毫秒数（默认 350）
  --no-diff           动作后跳过自动快照与增量 diff
  --out <file.png>    shot 指定输出 PNG 路径`);
}

function parseCli(argv) {
  const opts = {
    scene: '',
    port: 0,
    url: undefined,
    target: '',
    guard: '',
    readOnly: false,
    all: false,
    selector: '',
    find: '',
    keepHover: false,
    native: false,
    blur: false,
    enter: false,
    envVar: '',
    fromStdin: false,
    settleMs: 350,
    noDiff: false,
    out: '',
    exclude: '',
    also: '',
    reset: false,
    eext: '',
    projectUuid: '',
    force: false,
    maxNodes: 350,
    help: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--scene' || a === '-s') opts.scene = argv[++i] || '';
    else if (a === '--port' || a === '-p') opts.port = Number(argv[++i]) || 0;
    else if (a === '--url' || a === '--url-includes') opts.url = argv[++i] || '';
    else if (a === '--target' || a === '-t') opts.target = argv[++i] || '';
    else if (a === '--guard' || a === '-g') opts.guard = argv[++i] || '';
    else if (a === '--read-only' || a === '--readonly') opts.readOnly = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--selector') opts.selector = argv[++i] || '';
    else if (a === '--find') opts.find = argv[++i] || '';
    else if (a === '--keep-hover') opts.keepHover = true;
    else if (a === '--native') opts.native = true;
    else if (a === '--blur') opts.blur = true;
    else if (a === '--enter') opts.enter = true;
    else if (a === '--env') opts.envVar = argv[++i] || '';
    else if (a === '--stdin') opts.fromStdin = true;
    else if (a === '--settle') opts.settleMs = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--no-diff') opts.noDiff = true;
    else if (a === '--out' || a === '-o') opts.out = argv[++i] || '';
    else if (a === '--exclude') opts.exclude = argv[++i] || '';
    else if (a === '--also') opts.also = argv[++i] || '';
    else if (a === '--reset') opts.reset = true;
    else if (a === '--eext') opts.eext = argv[++i] || '';
    else if (a === '--project-uuid') opts.projectUuid = argv[++i] || '';
    else if (a === '--force') opts.force = true;
    else if (a === '--max-nodes') opts.maxNodes = Number(argv[++i]) || 350;
    else positionals.push(a);
  }
  return { opts, cmd: (positionals[0] || '').toLowerCase(), args: positionals.slice(1) };
}

async function readStdinText() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function resolveInputValue(positionalVal, opts) {
  if (opts.envVar) {
    const val = process.env[opts.envVar];
    if (typeof val !== 'string' || !val.length) {
      throw new Error(`Environment variable "${opts.envVar}" is empty or not set`);
    }
    return { value: val, secret: true };
  }
  if (opts.fromStdin) {
    const val = await readStdinText();
    if (!val.length) throw new Error('Standard input was empty for --stdin');
    return { value: val, secret: true };
  }
  if (typeof positionalVal === 'string') {
    return { value: positionalVal, secret: false };
  }
  throw new Error('Missing input text; pass <text>, --env <VAR_NAME>, or --stdin');
}

function filterSnapshotLines(text, keyword) {
  if (!keyword) return text;
  const kw = keyword.toLowerCase();
  const lines = String(text || '').split('\n');
  const kept = lines.filter((line) => (
    line.startsWith('[Page]')
    || line.startsWith('[URL]')
    || line.startsWith('[ActiveModal]')
    || line.startsWith('[Stats]')
    || line.toLowerCase().includes(kw)
  ));
  return kept.join('\n');
}

async function selectTargetCriteria(cdp, spec, opts) {
  if (opts.target) return { id: opts.target };
  if (opts.url) return { urlIncludes: opts.url };
  const allTargets = await cdp.listTargets();
  const pages = (allTargets || []).filter((t) => (
    t.type === 'page'
    && !String(t.url || '').startsWith('devtools://')
    && !String(t.url || '').startsWith('chrome-extension://')
  ));
  if (pages.length === 0) {
    throw new Error(`No open page tabs found on port ${spec.port} (${spec.scene})`);
  }
  if (spec.urlIncludes) {
    const matched = pages.filter((p) => String(p.url || '').toLowerCase().includes(spec.urlIncludes.toLowerCase()));
    if (matched.length >= 1) {
      return { id: matched[0].id };
    }
  }
  if (pages.length === 1) {
    return { id: pages[0].id };
  }
  const summary = pages.map((p) => `  - ${p.id} | ${p.title || '(untitled)'} | ${p.url}`).join('\n');
  throw new Error(`Multiple tabs open on port ${spec.port}; specify --url <substr> or --target <id>:\n${summary}`);
}

function ensureRefHydrated(page, spec, targetId, selectorOrRef) {
  const prev = sceneMod.loadRefState(spec.port, targetId);
  if (prev) {
    prev.hydrate(page);
  } else if (typeof selectorOrRef === 'string' && /^(?:@e?|ref=e?|e)\d+$/i.test(selectorOrRef.trim())) {
    throw new Error(`No saved @ref snapshot state for tab ${targetId} on port ${spec.port}; run "node cli/abb.cjs --scene ${spec.scene} snap" first`);
  }
  return prev;
}

async function postActionSnapshotAndDiff(cdp, page, spec, targetId, guard, prevState, opts) {
  if (opts.noDiff) return;
  if (opts.settleMs > 0) await cdp.sleep(opts.settleMs);
  let after;
  try {
    after = await cdp.snapshot(page, guard, { interactiveOnly: true, maxNodes: opts.maxNodes });
  } catch {
    after = await cdp.snapshot(page, 'true', { interactiveOnly: true, maxNodes: opts.maxNodes });
  }
  sceneMod.saveRefState(spec.port, targetId, after, page._refMap);
  if (prevState && prevState.snapshotText) {
    const diffRes = cdp.diffSnapshots(prevState.snapshotText, after.text);
    const rawDiff = typeof diffRes === 'string' ? diffRes : String(diffRes?.diff || '(no changes)');
    const header = after.text
      .split('\n')
      .filter((l) => l.startsWith('[Page]') || l.startsWith('[ActiveModal') || l.startsWith('[ModalBody]') || l.startsWith('[Alert]'))
      .join('\n');
    const allDiffLines = rawDiff.split('\n');
    const diffLines = allDiffLines.length <= 50
      ? allDiffLines.join('\n')
      : [...allDiffLines.slice(0, 30), `... (${allDiffLines.length - 45} lines omitted) ...`, ...allDiffLines.slice(-15)].join('\n');
    const summary = diffRes && typeof diffRes === 'object' && diffRes.changed
      ? ` (+${diffRes.additions} / -${diffRes.removals})`
      : '';
    console.log(`\n--- UI Diff (@refs refreshed${summary}) ---`);
    if (header) console.log(header);
    console.log(diffLines);
  } else {
    console.log('\n--- Snapshot (@refs saved) ---');
    console.log(after.text.split('\n').slice(0, 35).join('\n'));
  }
}

async function connectBrowserCompat(cdp) {
  if (typeof cdp.connectBrowser === 'function') return cdp.connectBrowser();
  const version = await cdp.getJson('/json/version');
  if (!version || !version.webSocketDebuggerUrl) throw new Error('CDP /json/version missing webSocketDebuggerUrl');
  const client = cdp.createCdp(version.webSocketDebuggerUrl);
  await client.ready;
  return client;
}

async function hoverCompat(cdp, page, selector, guard) {
  if (typeof cdp.hover === 'function') return cdp.hover(page, selector, guard);
  const query = typeof cdp.buildFindElementsExpression === 'function'
    ? cdp.buildFindElementsExpression(page, selector)
    : `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`;
  const pt = await page.evalChecked(`(() => { if (!(${guard})) throw new Error('Context guard failed before hover'); const es = ${query}; if (es.length !== 1) throw new Error('Hover target must be unique; matched ' + es.length); const r = es[0].getBoundingClientRect(); if (r.width < 1 || r.height < 1) throw new Error('Hover target unavailable'); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' });
  return { hovered: true, x: pt.x, y: pt.y };
}

async function hoverAndClickCompat(cdp, page, hoverLoc, clickLoc, guard, options = {}) {
  if (typeof cdp.hoverAndClick === 'function') return cdp.hoverAndClick(page, hoverLoc, clickLoc, guard, options);
  await hoverCompat(cdp, page, hoverLoc, guard);
  return options.box ? cdp.clickByBox(page, clickLoc, guard, options) : cdp.clickNative(page, clickLoc, guard);
}

async function main() {
  const { opts, cmd, args } = parseCli(process.argv.slice(2));
  if (opts.help || !cmd || cmd === 'help') {
    printHelp();
    return;
  }
  if (
    cmd !== 'k3'
    && cmd !== 'lceda'
    && fs.existsSync(path.join(__dirname, 'agent.cjs'))
    && !process.env.NODE_TEST_CONTEXT
    && process.env.ABB_QUIET_LEGACY !== '1'
  ) {
    process.stderr.write('[legacy-cli] Prefer unified entry "node cli/agent.cjs browser ..." (guarded policy, cooperative/exclusive locks, and unified JSON envelope; set ABB_QUIET_LEGACY=1 to silence).\n');
  }

  if (cmd === 'scenes') {
    const presets = sceneMod.listScenes();
    const live = await sceneMod.discoverLiveDedicatedInstances();
    console.log(JSON.stringify({ presets, liveInstances: live }, null, 2));
    return;
  }

  const effectiveScene = opts.scene || (cmd === 'lceda' && !opts.port ? 'lceda' : undefined);
  const spec = sceneMod.applySceneToEnv({
    scene: effectiveScene,
    port: opts.port || undefined,
    urlIncludes: opts.url,
    guard: opts.guard || undefined,
  });
  const cdp = require('../lib/cdp');

  if (cmd === 'tabs') {
    const targets = await cdp.listTargets();
    const pages = (targets || []).filter((t) => t.type === 'page').map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      attached: Boolean(t.attached),
    }));
    console.log(JSON.stringify({ scene: spec.scene, port: spec.port, browser: spec.browser, pages }, null, 2));
    return;
  }

  if (cmd === 'lceda') {
    const lceda = require('../learnings/lceda/tools/lceda-actions.cjs');
    const sub = (args[0] || 'ensure').toLowerCase();
    if (sub === 'ensure') {
      const res = await lceda.ensureEasyEdaReady(spec, {
        projectUuid: opts.projectUuid || undefined,
        eextPath: opts.eext || undefined,
        forceImport: opts.force,
        targetId: opts.target || undefined,
      });
      console.log(JSON.stringify(res, null, 2));
      if (!res || !res.ok) process.exitCode = 1;
      return;
    }
    if (sub === 'status') {
      const res = await lceda.getFullLcedaStatus(spec, {});
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (sub === 'import-ext' || sub === 'reconnect') {
      await lceda.ensureDebugBrowserRunning(spec, {});
      sceneMod.applySceneToEnv(spec);
      const browser = await connectBrowserCompat(cdp);
      let tabInfo;
      try {
        tabInfo = await lceda.ensureEditorTabTarget(browser, { targetId: opts.target || undefined });
      } finally {
        browser.close();
      }
      await cdp.withLeasedTarget({ id: tabInfo.targetId }, {
        port: spec.port,
        ownerTag: `abb:lceda-${sub}`,
      }, async (page) => {
        const innerBrowser = await connectBrowserCompat(cdp);
        try {
          const res = sub === 'import-ext'
            ? await lceda.importAndEnableExtension(page, innerBrowser, {
              eextPath: opts.eext || args[1] || undefined,
              force: opts.force,
            })
            : await lceda.softReconnect(page, innerBrowser, {});
          console.log(JSON.stringify(res, null, 2));
          if (!res || !res.ok) process.exitCode = 1;
        } finally {
          innerBrowser.close();
        }
      });
      return;
    }
    throw new Error(`Unknown lceda subcommand "${sub}". Supported: ensure, status, import-ext, reconnect`);
  }

  const criteria = await selectTargetCriteria(cdp, spec, opts);
  const guard = opts.guard || spec.defaultGuard || 'true';

  await cdp.withLeasedTarget(criteria, {
    port: spec.port,
    readOnly: opts.readOnly,
    ownerTag: `abb:${cmd}`,
  }, async (page, meta) => {
    if (cmd === 'snap' || cmd === 'snapshot') {
      let snapRes;
      try {
        snapRes = await cdp.snapshot(page, guard, {
          interactiveOnly: !opts.all,
          selector: opts.selector || undefined,
          maxNodes: opts.maxNodes,
        });
      } catch (err) {
        if (!opts.guard && /Context guard failed/i.test(String(err && err.message))) {
          snapRes = await cdp.snapshot(page, 'true', {
            interactiveOnly: !opts.all,
            selector: opts.selector || undefined,
            maxNodes: opts.maxNodes,
          });
        } else {
          throw err;
        }
      }
      sceneMod.saveRefState(spec.port, meta.targetId, snapRes, page._refMap);
      console.log(filterSnapshotLines(snapRes.text, opts.find));
      return;
    }

    if (cmd === 'read') {
      const targetLoc = args[0];
      if (!targetLoc) throw new Error('Usage: abb read <@eN|locator>');
      ensureRefHydrated(page, spec, meta.targetId, targetLoc);
      const val = await cdp.readUnique(page, targetLoc, guard);
      console.log(val);
      return;
    }

    if (cmd === 'shot' || cmd === 'screenshot') {
      const prefix = args[0] || `abb-${spec.scene}`;
      ensureRefHydrated(page, spec, meta.targetId, opts.selector);
      if (opts.selector) {
        const outPath = opts.out || path.join(cdp.artifactsDir(), `${cdp.sanitizeSegment(prefix)}-${cdp.formatTimestamp()}.png`);
        const res = await cdp.captureUniquePng(page, opts.selector, guard, outPath);
        console.log(JSON.stringify({ ok: true, outPath: res.outPath, width: res.width, height: res.height }));
      } else if (opts.out) {
        const res = await cdp.capturePagePng(page, path.resolve(opts.out), guard);
        console.log(JSON.stringify({ ok: true, outPath: res.outPath }));
      } else {
        const saved = await cdp.saveScreenshot(page, prefix);
        console.log(JSON.stringify({ ok: true, outPath: saved }));
      }
      return;
    }

    if (cmd === 'hover') {
      const targetLoc = args[0];
      if (!targetLoc) throw new Error('Usage: abb hover <@eN|locator>');
      const prev = ensureRefHydrated(page, spec, meta.targetId, targetLoc);
      const res = await hoverCompat(cdp, page, targetLoc, guard);
      console.log(JSON.stringify({ ok: true, action: 'hover', target: targetLoc, ...res }));
      await postActionSnapshotAndDiff(cdp, page, spec, meta.targetId, guard, prev, opts);
      return;
    }

    if (cmd === 'hover-click' || cmd === 'hoverclick') {
      const hoverLoc = args[0];
      const clickLoc = args[1];
      if (!hoverLoc || !clickLoc) throw new Error('Usage: abb hover-click <hoverLocator> <clickLocator>');
      const prev = ensureRefHydrated(page, spec, meta.targetId, hoverLoc);
      ensureRefHydrated(page, spec, meta.targetId, clickLoc);
      const res = await hoverAndClickCompat(cdp, page, hoverLoc, clickLoc, guard, {
        box: !opts.native,
        parkPointer: !opts.keepHover,
        keepHover: opts.keepHover,
      });
      console.log(JSON.stringify({ ok: true, action: 'hover-click', hoverTarget: hoverLoc, clickTarget: clickLoc, ...res }));
      await postActionSnapshotAndDiff(cdp, page, spec, meta.targetId, guard, prev, opts);
      return;
    }

    if (cmd === 'click') {
      const targetLoc = args[0];
      if (!targetLoc) throw new Error('Usage: abb click <@eN|locator>');
      const prev = ensureRefHydrated(page, spec, meta.targetId, targetLoc);
      const res = opts.native
        ? await cdp.clickNative(page, targetLoc, guard)
        : await cdp.clickByBox(page, targetLoc, guard, {
          parkPointer: !opts.keepHover,
          keepHover: opts.keepHover,
        });
      console.log(JSON.stringify({ ok: true, action: 'click', target: targetLoc, ...res }));
      await postActionSnapshotAndDiff(cdp, page, spec, meta.targetId, guard, prev, opts);
      return;
    }

    if (cmd === 'fill' || cmd === 'type') {
      const targetLoc = args[0];
      if (!targetLoc) throw new Error(`Usage: abb ${cmd} <@eN|locator> [text|--env VAR|--stdin]`);
      const prev = ensureRefHydrated(page, spec, meta.targetId, targetLoc);
      const { value, secret } = await resolveInputValue(args[1], opts);
      const fn = cmd === 'type' ? cdp.typeKeysSafe : cdp.fillNative;
      const res = await fn(page, targetLoc, value, guard, {
        blur: opts.blur ? true : undefined,
      });
      if (opts.enter) {
        await cdp.pressKey(page, 'Enter', guard);
      }
      console.log(JSON.stringify({ ok: true, action: cmd, target: targetLoc, ...res, enterPressed: Boolean(opts.enter) }));
      await postActionSnapshotAndDiff(cdp, page, spec, meta.targetId, guard, prev, secret ? { ...opts, noDiff: true } : opts);
      return;
    }

    if (cmd === 'press') {
      const key = args[0];
      if (!key) throw new Error('Usage: abb press <Enter|Tab|Escape>');
      const prev = sceneMod.loadRefState(spec.port, meta.targetId);
      const res = await cdp.pressKey(page, key, guard);
      console.log(JSON.stringify({ ok: true, action: 'press', ...res }));
      await postActionSnapshotAndDiff(cdp, page, spec, meta.targetId, guard, prev, opts);
      return;
    }

    if (cmd === 'k3') {
      const k3 = require('../learnings/k3cloud/tools/k3-actions.cjs');
      const sub = (args[0] || '').toLowerCase();
      const prev = sceneMod.loadRefState(spec.port, meta.targetId);
      let result;
      if (sub === 'open-list') {
        result = await k3.openListBySearch(page, { query: args[1], exclude: opts.exclude || undefined }, { guard: opts.guard || undefined });
      } else if (sub === 'filter-bill') {
        result = await k3.filterByBillNo(page, args[1], { resetOnMiss: opts.reset, guard: opts.guard || undefined });
      } else if (sub === 'select-row') {
        result = await k3.selectGridRowByText(page, args[1], { alsoIncludes: opts.also, guard: opts.guard || k3.K3_ADMIN_GUARD });
      } else if (sub === 'split-menu') {
        result = await k3.clickSplitMenuOption(page, args[1], args[2] || args[1], { guard: opts.guard || k3.K3_ADMIN_GUARD });
      } else if (sub === 'admin-2fa') {
        const { value } = await resolveInputValue(undefined, opts);
        result = await k3.submitK3Admin2FA(page, value, { guard: opts.guard || k3.K3_ADMIN_GUARD });
      } else if (sub === 'confirm') {
        result = await k3.confirmK3Modal(page, args[1] || '确定', { guard: opts.guard || k3.K3_ADMIN_GUARD });
      } else if (sub === 'close-tabs') {
        const closed = await k3.closeInnerTabs(page, { guard: opts.guard || k3.K3_ADMIN_GUARD });
        result = { closed };
      } else {
        throw new Error(`Unknown k3 subcommand "${sub}". Supported: open-list, filter-bill, select-row, split-menu, admin-2fa, confirm, close-tabs`);
      }
      console.log(JSON.stringify({ ok: true, k3: sub, ...result }));
      await postActionSnapshotAndDiff(cdp, page, spec, meta.targetId, guard, prev, opts);
      return;
    }

    throw new Error(`Unknown command "${cmd}". Run "node cli/abb.cjs --help" for usage.`);
  });
}

main().catch((err) => {
  console.error(err && err.message ? `[abb error] ${err.message}` : String(err));
  process.exitCode = 1;
});
