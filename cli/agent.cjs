#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createAutomation, routeTask, doctor, runWorkflow, exclusiveLock, loadLocalConfig } = require('../lib/automation');
const { fail, normalizeOptions, serializeError } = require('../lib/automation/errors');
const appRegistry = require('../lib/desktop/appRegistry');
const winHelper = require('../lib/desktop/winHelper');
const sceneMod = require('../lib/cdp/scene');

const SUBCOMMAND_HELP = {
  desktop: `Desktop subcommands (node cli/agent.cjs [global options] desktop <subcommand> ...):

  apps        List installed app presets and running status (read-only)
  windows     List visible windows (--app, --window-id, --title-includes)
  tray        Inspect or click Windows system tray / hidden background icons ("后台任务")
  open-app    Wake tray-hidden window or launch app cleanly (--write --mode exclusive --app wechat|wecom|...)
  ensure-ready Restore minimized window & unlock foreground (--app ..., [--launch])
  capabilities Detect uia_semantic vs custom_ui_visual (--app ..., --no-snapshot)
  ocr         Background WinRT OCR (--app ..., [--region full|header|sidebar|messages|composer], [--find TEXT], [--out FILE])
  shot        Capture window or screen PNG (MUST pass --app, --window-id, --title-includes, or --screen; --out PATH requires --write)
  click-text  OCR click text on window (--write --mode exclusive --app ..., --text "...")
  chat-send   Verified IM delivery (text/image/sticker/file) via --stdin JSON (--write --mode exclusive)
  deliver     Standard UIA multi-message delivery via --stdin JSON (--write)
  batch       Raw UIA/input step array via --stdin JSON (--write [--mode exclusive])

Run "node cli/agent.cjs desktop <subcommand> --help" for copy-paste examples.`,
  'desktop:chat-send': `desktop chat-send --stdin [--app ALIAS] [--window-id w-...] (requires --write --mode exclusive)

PowerShell example (recommended — auto-wakes tray, verifies chat header OCR, optional saveAfterShot):
  @'
  {
    "app": "wechat",
    "sessionName": "文件传输助手",
    "launchIfMissing": true,
    "saveAfterShot": "C:\\Users\\Public\\Pictures\\chat-proof.png",
    "items": [
      { "type": "text", "text": "你好，这是测试消息" },
      { "type": "sticker", "path": "C:\\Users\\Public\\Pictures\\anim.gif" }
    ]
  }
  '@ | node cli/agent.cjs --write --mode exclusive desktop chat-send --stdin

Git Bash example:
  cat <<'EOF' | node cli/agent.cjs --write --mode exclusive desktop chat-send --stdin
  {"app":"wechat","sessionName":"文件传输助手","launchIfMissing":true,"items":["你好"]}
  EOF

Options inside JSON:
  app: wecom | wechat | qq | feishu | dingtalk | <process.exe>
  sessionName: exact contact/group name verified against chat header OCR
  items[]: string or {"type":"text"|"image"|"sticker"|"file", "text"|"path": ...}
  saveAfterShot: optional PNG path to save the post-delivery chat window screenshot in the same call
  navigationMode: "auto" | "keyboard_first" (zero mouse movement/clicks when Ctrl+F+Return opens session)`,
  'desktop:shot': `desktop shot (MUST specify --app, --window-id, --title-includes, or --screen)

Options:
  --app <alias|exe>          e.g. wechat, wecom, qq, notepad.exe
  --window-id <w-...>        (alias: --window) target window handle from desktop windows
  --title-includes <substr>  match window title substring
  --screen <index>           capture full display (0, 1, ...)
  --out <file.png>           (alias: --output) custom path; requires --write

Examples:
  node cli/agent.cjs desktop shot --app wechat
  node cli/agent.cjs --write desktop shot --app wechat --out .\\wechat.png
  node cli/agent.cjs --write desktop shot --screen 0 --out .\\screen.png`,
  'desktop:ocr': `desktop ocr (background PrintWindow + WinRT Chinese/English OCR)

Options:
  --app <alias|exe> | --window-id <w-...> | --title-includes <substr>
  --region <full|header|sidebar|messages|composer|x,y,w,h>
  --find <text>              (alias: --match) compact match coordinates only
  --scale <1..4>             upscale factor (default 2)
  --lines | --no-lines | --words | --compact
  --out <file.png>           (alias: --output) save screenshot PNG; requires --write

Example:
  node cli/agent.cjs desktop ocr --app wechat --region header --find "文件传输助手"`,
  'desktop:open-app': `desktop open-app (requires --write --mode exclusive)

Wakes running background/system-tray app first ("后台任务" overflow + promoted tray), then shell-launches if not running.
Options: --app <wecom|wechat|qq|feishu|dingtalk|notepad|...>, [--exe <ABS_PATH>], [--title-includes <substr>], [--focus|--no-focus], [--no-restore]

Example:
  node cli/agent.cjs --write --mode exclusive desktop open-app --app wechat`,
  'desktop:tray': `desktop tray (inspect or click Windows taskbar system tray / "隐藏的图标·后台任务")

Options:
  --find <keyword>           filter tray icons (read-only on promoted icons; pass --write --mode exclusive --open-overflow to also scan hidden overflow)
  --open-overflow            temporarily expand taskbar "隐藏的图标" panel to enumerate background apps (requires --write --mode exclusive)
  --click <keyword>          click matching tray icon to wake background app (requires --write --mode exclusive)
  --app <alias>              click tray icon matching preset app (e.g. wechat, wecom, qq) (requires --write --mode exclusive)
  --double                   double-click instead of single-click

Examples:
  node cli/agent.cjs --write --mode exclusive desktop tray --open-overflow
  node cli/agent.cjs --write --mode exclusive desktop tray --app wechat`,
  'desktop:click-text': `desktop click-text (requires --write --mode exclusive)

Options: --app <alias|exe>, --text <visibleText>, [--region full|header|sidebar|messages|composer], [--scroll-retries N], [--click-mode physical_restore|message], [--no-restore-cursor], [--no-ripple]`,
  'desktop:ensure-ready': `desktop ensure-ready
Options: --app <alias|exe>, [--window-id w-...], [--title-includes substr], [--launch], [--focus|--no-focus], [--no-restore]`,
  browser: `Browser subcommands (node cli/agent.cjs [--scene k3] browser <subcommand> ...):
  scenes | tabs | snap | read | click | hover | hover-click | fill | type | select | wait | press | shot | close`,
  route: `route: choose optimal automation channel
  Structured: node cli/agent.cjs route --url https://... | --app notepad.exe | --file data.csv
  Quick hint: node cli/agent.cjs route "对微信窗口截图并发消息"`,
};

function isHelpArgList(args) {
  return Array.isArray(args) && args.some(a => a === '--help' || a === '-h' || a === 'help');
}

function getSubcommandHelp(key) {
  if (SUBCOMMAND_HELP[key]) return SUBCOMMAND_HELP[key] + '\n';
  return HELP;
}

const HELP = `Agent Browser Bridge unified canonical entry (trusted local code, not a sandbox)

Single canonical CLI — do NOT call legacy PowerShell helpers or spawn per-step desktop processes:
  node cli/agent.cjs doctor [--scene smoke]
  node cli/agent.cjs route --url https://example.com | --app notepad.exe | --file data.csv
  node cli/agent.cjs browser scenes
  node cli/agent.cjs --scene k3 browser tabs
  node cli/agent.cjs --scene smoke browser snap --open-url https://example.com [--find KW] [--all]
  node cli/agent.cjs --scene smoke browser read e1
  node cli/agent.cjs --write --scene smoke browser click e3 [--box] [--no-diff]
  node cli/agent.cjs --write --scene smoke browser hover ".todo-list li"
  node cli/agent.cjs --write --scene smoke browser hover-click ".todo-list li" "button.destroy" [--box] [--no-diff]
  node cli/agent.cjs --write --scene smoke browser fill e2 --stdin --enter [--no-diff]
  node cli/agent.cjs --write --scene smoke browser type e2 --stdin --enter [--no-diff]
  node cli/agent.cjs --write --scene smoke browser select e4 "Option A" [--no-diff]
  node cli/agent.cjs --scene smoke browser wait ".ready-banner" [--timeout-ms 5000]
  node cli/agent.cjs --write --scene smoke browser close --url example.com | --target <id>
  node cli/agent.cjs --write --scene smoke browser press Enter [--no-diff]
  node cli/agent.cjs --mode exclusive --scene smoke browser shot [--selector e1] [--out shot.png]
  node cli/agent.cjs desktop apps [--app wecom]
  node cli/agent.cjs desktop windows [--app wecom] [--title-includes SUB]
  node cli/agent.cjs --write --mode exclusive desktop open-app --app wecom [--exe ABS_PATH] [--title-includes SUB]
  node cli/agent.cjs desktop capabilities --app notepad.exe [--window-id w-...] [--title-includes SUB] [--no-snapshot]
  node cli/agent.cjs --write --mode exclusive desktop ensure-ready --app notepad.exe [--launch] [--no-focus] [--no-restore]
  node cli/agent.cjs desktop shot --app wecom [--window-id w-...] [--out shot.png]
  node cli/agent.cjs desktop ocr --app wecom [--region full|header|sidebar|messages|composer] [--find TEXT] [--words] [--no-lines] [--max-lines N]
  node cli/agent.cjs --write --mode exclusive desktop click-text --app wecom --text "文件传输助手" [--region sidebar] [--scroll-retries N]
  node cli/agent.cjs --write --mode exclusive desktop chat-send --stdin
  node cli/agent.cjs --write [--mode exclusive] desktop deliver --stdin
  node cli/agent.cjs --write [--mode exclusive] desktop batch --stdin
  node cli/agent.cjs desktop snapshot --app explorer.exe [-i] [--compact]
  node cli/agent.cjs desktop find --app notepad.exe [--role button] [--name Save] [--first]
  node cli/agent.cjs desktop is @s1:e2 --property checked
  node cli/agent.cjs --write desktop select @s1:e3 "Option B"
  node cli/agent.cjs --write desktop check|uncheck|toggle|expand|collapse|clear|scroll-to @s1:e4
  node cli/agent.cjs --write --mode exclusive desktop focus @s1:e4
  node cli/agent.cjs --write --mode exclusive desktop resize-window --window-id w-... --width 960 --height 680
  node cli/agent.cjs run --file trusted-workflow.cjs

Browser options: --url <substr>, --open-url <https://...>, --target <id>, --guard <expr>,
                 --find <kw>, --selector <sel>, --all (include non-interactive nodes),
                 --box (box mouse click), --no-diff (skip post-action snapshot/diff),
                 --enter, --stdin, --env <VAR>, --out <path>
Task options: --write, --mode cooperative|exclusive, --timeout-ms N,
              --scene NAME, --port PORT,
              --binary ABSOLUTE_PATH, --expected-version VERSION, --config PATH,
              --target-window WINDOW_ID (coordinate input target preflight)
Default: read-only, cooperative. Physical input, window restore/focus, screenshots,
and shared-resource changes need --mode exclusive. Text for desktop type/set-value/
clipboard-set/batch/deliver and sensitive browser fill/type uses --stdin (or --env VAR).
run --file executes trusted CommonJS exporting async ({desktop,browser,scenes,step,signal}) => ...
step(name, action, verify) requires verify to return true to report verified.
No automatic retry. Exit 0: success/verified; 1: failure; 2: unverified workflow.
`;

const GLOBAL_VALUE_FLAGS = {
  '--mode': 'mode',
  '--timeout-ms': 'timeoutMs',
  '--binary': 'binaryPath',
  '--expected-version': 'expectedVersion',
  '--config': 'configPath',
  '--target-window': 'windowId',
  '--scene': 'scene',
  '--port': 'port',
};

function parse(argv) {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') {
      if (options.readOnly !== undefined) throw fail('INVALID_ARGS', 'Repeated task option');
      options.readOnly = false;
    } else if (GLOBAL_VALUE_FLAGS[arg]) {
      const key = GLOBAL_VALUE_FLAGS[arg];
      if (options[key] !== undefined) throw fail('INVALID_ARGS', 'Repeated task option');
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw fail('INVALID_ARGS', `Missing value for ${arg}`);
      options[key] = (arg === '--timeout-ms' || arg === '--port') ? Number(value) : value;
    } else {
      rest.push(arg);
    }
  }
  return { options, rest };
}

async function stdinText() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1024 * 1024) throw fail('INVALID_ARGS', 'stdin exceeds the 1 MiB input limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function pairs(args, allowed) {
  if (args.length % 2) throw fail('INVALID_ARGS', 'Arguments must be option/value pairs');
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || Object.hasOwn(values, args[i])) throw fail('INVALID_ARGS', 'Unknown or repeated option');
    values[args[i]] = args[i + 1];
  }
  return values;
}

function normalizeRefSelector(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw fail('INVALID_ARGS', 'Browser selector is required');
  const trimmed = raw.trim();
  return /^e\d+$/i.test(trimmed) ? `@${trimmed.toLowerCase()}` : trimmed;
}

function parseBrowserSubArgs(args) {
  const flags = {
    url: undefined,
    openUrl: undefined,
    target: undefined,
    guard: "location.protocol === 'http:' || location.protocol === 'https:' || location.href === 'about:blank'",
    find: '',
    selector: '',
    out: '',
    all: false,
    box: false,
    enter: false,
    noDiff: false,
    fromStdin: false,
    envVar: '',
  };
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--url' || a === '--url-includes') flags.url = args[++i];
    else if (a === '--open-url') flags.openUrl = args[++i];
    else if (a === '--target') flags.target = args[++i];
    else if (a === '--guard') flags.guard = args[++i];
    else if (a === '--find') flags.find = args[++i] || '';
    else if (a === '--selector') flags.selector = args[++i] || '';
    else if (a === '--out') flags.out = args[++i] || '';
    else if (a === '--env') flags.envVar = args[++i] || '';
    else if (a === '--all') flags.all = true;
    else if (a === '--box') flags.box = true;
    else if (a === '--enter') flags.enter = true;
    else if (a === '--no-diff') flags.noDiff = true;
    else if (a === '--stdin') flags.fromStdin = true;
    else if (a.startsWith('--')) throw fail('INVALID_ARGS', `Unknown browser option ${a}`);
    else pos.push(a);
  }
  return { flags, pos };
}

function filterSnapText(text, kw) {
  if (!kw) return text;
  const needle = kw.toLowerCase();
  return String(text || '')
    .split('\n')
    .filter(l => l.startsWith('[Page]') || l.startsWith('[URL]') || l.startsWith('[ActiveModal') || l.startsWith('[Stats]') || l.toLowerCase().includes(needle))
    .join('\n');
}

async function resolveBrowserTargetCriteria(cdp, flags, sceneUrlIncludes) {
  if (flags.target) return { id: flags.target };
  if (flags.url) return { urlIncludes: flags.url };
  const allTargets = await cdp.listTargets();
  const pages = (allTargets || []).filter(t => (
    t.type === 'page'
    && !String(t.url || '').startsWith('devtools://')
    && !String(t.url || '').startsWith('chrome-extension://')
  ));
  if (pages.length === 1) return { id: pages[0].id };
  if (pages.length === 0) throw fail('TARGET_NOT_FOUND', 'No open browser page tabs found; pass --open-url <https://...>');
  if (sceneUrlIncludes) {
    const matched = pages.filter(p => String(p.url || '').toLowerCase().includes(sceneUrlIncludes.toLowerCase()));
    if (matched.length === 1) return { id: matched[0].id };
  }
  throw fail('INVALID_ARGS', `Multiple browser tabs (${pages.length}) are open; pass --target <id> or --url <substr>`);
}

function attachSnapshotAndDiff(cdp, prevState, after) {
  if (!after) return {};
  const out = { snapshot: after.text };
  if (prevState?.snapshotText && typeof cdp.diffSnapshots === 'function') {
    const d = cdp.diffSnapshots(prevState.snapshotText, after.text);
    if (d && typeof d === 'object') {
      out.diff = { changed: Boolean(d.changed), additions: d.additions, removals: d.removals, summary: d.diff };
    }
  }
  return out;
}

async function executeBrowserCommand(options, args, sceneSpec) {
  if (!args.length || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    if (!args.length) {
      throw fail('INVALID_ARGS', 'browser requires a subcommand (scenes|tabs|snap|read|click|hover|hover-click|fill|type|select|wait|close|press|shot)');
    }
    return { helpText: getSubcommandHelp('browser') };
  }
  if (isHelpArgList(args)) {
    return { helpText: getSubcommandHelp('browser') };
  }
  const [sub, ...rest] = args;

  if (sub === 'scenes') {
    if (rest.length) throw fail('INVALID_ARGS', 'browser scenes takes no extra arguments');
    const presets = sceneMod.listScenes();
    const liveInstances = await sceneMod.discoverLiveDedicatedInstances();
    return { presets, liveInstances };
  }

  const { flags, pos } = parseBrowserSubArgs(rest);

  if (sub === 'tabs') {
    if (pos.length) throw fail('INVALID_ARGS', 'browser tabs takes no positional arguments');
    const cdp = require('../lib/cdp');
    const cfg = cdp.resolveConfig();
    if (!cfg.strict || !cfg.profile || !cfg.browser || !cfg.proxy || cfg.attachExisting) {
      throw fail('BROWSER_NOT_CONFIGURED', 'Configure a strict dedicated browser identity or pass --scene <name>');
    }
    await cdp.identity.verify();
    const raw = await cdp.listTargets();
    const tabs = (raw || [])
      .filter(t => t.type === 'page' && !String(t.url || '').startsWith('devtools://'))
      .map(t => ({ id: t.id, title: t.title, url: t.url }));
    return { port: cfg.port, count: tabs.length, tabs };
  }

  if (sub === 'close') {
    if (pos.length) throw fail('INVALID_ARGS', 'browser close takes no positional arguments');
    if (options.readOnly) throw fail('READ_ONLY_BLOCKED', 'browser close requires --write');
    if (!flags.target && !flags.url) {
      throw fail('INVALID_ARGS', 'browser close requires --target <id> or --url <substr>');
    }
    return exclusiveLock(options, async () => {
      const cdp = require('../lib/cdp');
      const cfg = cdp.resolveConfig();
      if (!cfg.strict || !cfg.profile || !cfg.browser || !cfg.proxy || cfg.attachExisting) {
        throw fail('BROWSER_NOT_CONFIGURED', 'Configure a strict dedicated browser identity or pass --scene <name>');
      }
      await cdp.identity.verify();
      const browser = await cdp.connectBrowser({ quiet: true });
      try {
        const raw = await cdp.listTargets(browser);
        const pages = (raw || []).filter(t => (
          t.type === 'page'
          && !String(t.url || '').startsWith('devtools://')
          && !String(t.url || '').startsWith('chrome-extension://')
        ));
        const matches = flags.target
          ? pages.filter(p => p.id === flags.target)
          : pages.filter(p => String(p.url || '').toLowerCase().includes(String(flags.url).toLowerCase()));
        if (matches.length === 0) throw fail('TARGET_NOT_FOUND', 'No matching browser tab found to close');
        if (matches.length > 1) throw fail('INVALID_ARGS', `Multiple tabs (${matches.length}) matched; pass --target <id>`);
        if (pages.length <= 1) throw fail('POLICY_DENIED', 'Refusing to close the last remaining browser tab');
        const target = matches[0];
        cdp.assertNotLeasedByOtherProcess(target.id, { port: cfg.port });
        await browser.send('Target.closeTarget', { targetId: target.id });
        return { closed: true, targetId: target.id, url: target.url };
      } finally {
        browser.close();
      }
    });
  }

  let inputText;
  if (sub === 'fill' || sub === 'type') {
    if (flags.envVar) {
      inputText = process.env[flags.envVar];
      if (typeof inputText !== 'string' || !inputText.length) throw fail('INVALID_ARGS', `Environment variable ${flags.envVar} is empty or unset`);
    } else if (flags.fromStdin) {
      inputText = (await stdinText()).replace(/\r?\n$/, '');
      if (!inputText.length) throw fail('INVALID_ARGS', `stdin text for browser ${sub} was empty`);
    } else if (typeof pos[1] === 'string') {
      inputText = pos[1];
    } else {
      throw fail('INVALID_ARGS', `browser ${sub} requires <selector> and <text>|--stdin|--env <VAR>`);
    }
  }

  return exclusiveLock(options, async (_assertHeld, leaseSignal) => {
    const automation = createAutomation({ ...options, signal: leaseSignal });
    const cdp = require('../lib/cdp');
    const runOnPage = async (page) => {
      const guard = flags.guard;
      const prevState = (page.port && page.targetId) ? sceneMod.loadRefState(page.port, page.targetId) : null;

      if (sub === 'snap') {
        const snap = await page.snapshot(guard, {
          interactiveOnly: !flags.all,
          ...(flags.selector ? { selector: normalizeRefSelector(flags.selector) } : {}),
        });
        return {
          targetId: page.targetId || null,
          url: snap.url,
          title: snap.title,
          stats: snap.stats,
          text: filterSnapText(snap.text, flags.find),
        };
      }
      if (sub === 'read') {
        if (pos.length !== 1) throw fail('INVALID_ARGS', 'browser read requires exactly <selector>');
        const value = await page.readUnique(normalizeRefSelector(pos[0]), guard);
        return { targetId: page.targetId || null, value };
      }
      if (sub === 'shot') {
        const outPath = flags.out
          ? path.resolve(flags.out)
          : path.join(cdp.artifactsDir(), `agent-shot-${cdp.formatTimestamp()}.png`);
        if (flags.selector) {
          const res = await page.captureUniquePng(normalizeRefSelector(flags.selector), guard, outPath);
          return { targetId: page.targetId || null, outPath: res.outPath, width: res.width, height: res.height };
        }
        const res = await page.capturePagePng(outPath, guard);
        return { targetId: page.targetId || null, outPath: res.outPath };
      }
      if (sub === 'click') {
        if (pos.length !== 1) throw fail('INVALID_ARGS', 'browser click requires exactly <selector>');
        const sel = normalizeRefSelector(pos[0]);
        const res = flags.box
          ? await page.clickByBox(sel, guard)
          : await page.clickNative(sel, guard);
        const after = flags.noDiff ? null : await page.snapshot('true', { interactiveOnly: true });
        return { targetId: page.targetId || null, action: res, ...attachSnapshotAndDiff(cdp, prevState, after) };
      }
      if (sub === 'hover') {
        if (pos.length !== 1) throw fail('INVALID_ARGS', 'browser hover requires exactly <selector>');
        const res = await page.hover(normalizeRefSelector(pos[0]), guard);
        const after = flags.noDiff ? null : await page.snapshot('true', { interactiveOnly: true });
        return { targetId: page.targetId || null, action: res, ...attachSnapshotAndDiff(cdp, prevState, after) };
      }
      if (sub === 'hover-click') {
        if (pos.length !== 2) throw fail('INVALID_ARGS', 'browser hover-click requires <hoverSelector> <clickSelector>');
        const res = await page.hoverAndClick(normalizeRefSelector(pos[0]), normalizeRefSelector(pos[1]), guard, { box: flags.box });
        const after = flags.noDiff ? null : await page.snapshot('true', { interactiveOnly: true });
        return { targetId: page.targetId || null, action: res, ...attachSnapshotAndDiff(cdp, prevState, after) };
      }
      if (sub === 'fill' || sub === 'type') {
        const sel = normalizeRefSelector(pos[0]);
        const res = sub === 'type'
          ? await page.typeKeysSafe(sel, inputText, guard)
          : await page.fillNative(sel, inputText, guard);
        if (flags.enter) await page.pressKey('Enter', guard);
        const suppressSecretDiff = Boolean(flags.noDiff || flags.fromStdin || flags.envVar);
        const after = suppressSecretDiff ? null : await page.snapshot('true', { interactiveOnly: true });
        return {
          targetId: page.targetId || null,
          action: sub,
          inputVerified: Boolean(res?.inputVerified ?? true),
          pressedEnter: Boolean(flags.enter),
          ...attachSnapshotAndDiff(cdp, prevState, after),
        };
      }
      if (sub === 'select') {
        if (pos.length !== 2) throw fail('INVALID_ARGS', 'browser select requires <selector> and <value>');
        const res = await page.selectOption(normalizeRefSelector(pos[0]), pos[1], guard);
        const after = flags.noDiff ? null : await page.snapshot('true', { interactiveOnly: true });
        return { targetId: page.targetId || null, action: res, ...attachSnapshotAndDiff(cdp, prevState, after) };
      }
      if (sub === 'wait') {
        if (pos.length !== 1) throw fail('INVALID_ARGS', 'browser wait requires exactly <selector>');
        const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 10000;
        await page.waitForSelector(normalizeRefSelector(pos[0]), guard, { timeoutMs });
        return { targetId: page.targetId || null, selector: pos[0], ready: true };
      }
      if (sub === 'press') {
        if (pos.length !== 1) throw fail('INVALID_ARGS', 'browser press requires <Enter|Tab|Escape>');
        const res = await page.pressKey(pos[0], guard);
        const after = flags.noDiff ? null : await page.snapshot('true', { interactiveOnly: true });
        return { targetId: page.targetId || null, action: res, ...attachSnapshotAndDiff(cdp, prevState, after) };
      }
      throw fail('INVALID_ARGS', `Unknown browser subcommand "${sub}"`);
    };

    if (flags.openUrl) {
      return automation.browser.withDedicatedTab({ url: flags.openUrl }, runOnPage);
    }
    const cfg = cdp.resolveConfig();
    if (!cfg.strict || !cfg.profile || !cfg.browser || !cfg.proxy || cfg.attachExisting) {
      throw fail('BROWSER_NOT_CONFIGURED', 'Configure a strict dedicated browser identity or pass --scene <name>');
    }
    await cdp.identity.verify();
    const criteria = await resolveBrowserTargetCriteria(cdp, flags, sceneSpec?.urlIncludes);
    return automation.browser.withLeasedTarget(criteria, runOnPage);
  });
}

async function executeDesktopCommand(options, args) {
  if (!args.length) throw fail('INVALID_ARGS', 'desktop requires a command (run "node cli/agent.cjs desktop --help")');
  const sub = args[0];
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    return { helpText: getSubcommandHelp('desktop') };
  }
  const restAll = args.slice(1);
  if (isHelpArgList(restAll)) {
    return { helpText: getSubcommandHelp(`desktop:${sub}`) !== HELP ? getSubcommandHelp(`desktop:${sub}`) : getSubcommandHelp('desktop') };
  }

  if (sub === 'apps') {
    const rest = args.slice(1);
    const kv = pairs(rest, ['--app']);
    return exclusiveLock(options, async (_assertHeld, leaseSignal) => {
      const desktop = createAutomation({ ...options, signal: leaseSignal }).desktop;
      const running = await desktop.adListApps().catch(() => []);
      const known = kv['--app']
        ? [appRegistry.resolveAppSpec(kv['--app'])]
        : appRegistry.listKnownApps();
      return { knownApps: known, runningApps: running };
    });
  }

  if (sub === 'tray') {
    const rest = args.slice(1);
    const boolFlags = new Set(['--open-overflow', '--double', '--no-close']);
    const kv = pairs(rest.filter(a => !boolFlags.has(a)), ['--find', '--click', '--app', '--exclude']);
    const wantClick = Boolean(kv['--click'] || kv['--app']);
    const openOverflow = rest.includes('--open-overflow');
    if (wantClick || openOverflow) {
      if (options.readOnly) throw fail('READ_ONLY_BLOCKED', 'desktop tray --click / --open-overflow requires --write');
      if (options.mode !== 'exclusive') throw fail('DESKTOP_FOREGROUND_REQUIRED', 'desktop tray --click / --open-overflow requires --mode exclusive');
    }
    return exclusiveLock(options, async (_assertHeld, leaseSignal) => {
      if (wantClick) {
        const spec = kv['--app'] ? appRegistry.resolveAppSpec(kv['--app']) : null;
        const keywords = kv['--click']
          ? [kv['--click']]
          : (spec?.trayKeywords?.length ? spec.trayKeywords : [kv['--app']]);
        const excludeKeywords = kv['--exclude']
          ? kv['--exclude'].split(',').map(s => s.trim()).filter(Boolean)
          : (spec?.trayExcludeKeywords || []);
        return winHelper.activateSystemTrayIcon({
          keywords,
          excludeKeywords,
          doubleClick: rest.includes('--double'),
          signal: leaseSignal,
          timeoutMs: options.timeoutMs,
        });
      }
      return winHelper.listSystemTrayIcons({
        find: kv['--find'],
        openOverflow,
        closeAfter: !rest.includes('--no-close'),
        signal: leaseSignal,
        timeoutMs: options.timeoutMs,
      });
    });
  }

  if (sub === 'windows') {
    const rest = args.slice(1);
    const kv = pairs(rest, ['--app', '--window-id', '--window', '--title-includes', '--exe']);
    return exclusiveLock(options, async (_assertHeld, leaseSignal) => {
      const desktop = createAutomation({ ...options, signal: leaseSignal }).desktop;
      const found = await appRegistry.findMatchingWindows(desktop, kv['--app'], {
        windowId: kv['--window-id'] || kv['--window'] || options.windowId,
        titleIncludes: kv['--title-includes'],
        exePath: kv['--exe'],
        signal: leaseSignal,
        timeoutMs: options.timeoutMs,
      });
      return { count: found.windows.length, windows: found.windows };
    });
  }

  if (sub === 'open-app') {
    if (options.readOnly) throw fail('READ_ONLY_BLOCKED', 'desktop open-app requires --write');
    if (options.mode !== 'exclusive') throw fail('DESKTOP_FOREGROUND_REQUIRED', 'desktop open-app requires --mode exclusive');
    const rest = args.slice(1);
    const boolFlags = new Set(['--prefer-focused', '--focus', '--no-focus', '--no-restore']);
    const kv = pairs(rest.filter(a => !boolFlags.has(a)), ['--app', '--exe', '--window-id', '--window', '--title-includes']);
    const focusOpt = rest.includes('--no-focus') ? false : (rest.includes('--focus') ? true : 'auto');
    return exclusiveLock(options, (_assertHeld, leaseSignal) => {
      const automation = createAutomation({ ...options, signal: leaseSignal });
      return automation.scenes.ensureWindowReady(
        automation.desktop,
        {
          app: kv['--app'],
          exePath: kv['--exe'],
          windowId: kv['--window-id'] || kv['--window'] || options.windowId,
          titleIncludes: kv['--title-includes'],
          preferFocused: true,
        },
        {
          focus: focusOpt,
          restoreIfMinimized: !rest.includes('--no-restore'),
          launchIfMissing: true,
          signal: leaseSignal,
          timeoutMs: options.timeoutMs,
        },
      );
    });
  }

  if (sub === 'shot') {
    const rest = args.slice(1);
    const kv = pairs(rest, ['--app', '--window-id', '--window', '--title-includes', '--out', '--output', '--screen']);
    const outArg = kv['--out'] || kv['--output'];
    const targetWindowId = kv['--window-id'] || kv['--window'] || options.windowId;
    if (!kv['--app'] && !targetWindowId && !kv['--title-includes'] && kv['--screen'] === undefined) {
      throw fail(
        'INVALID_ARGS',
        'desktop shot requires --app <name>, --window-id <id>, --title-includes <text>, or --screen <n> (example: node cli/agent.cjs --write desktop shot --app wechat --out .\\wechat.png)',
      );
    }
    if (outArg && options.readOnly) throw fail('READ_ONLY_BLOCKED', 'desktop shot with custom --out requires --write');
    return exclusiveLock(options, async (_assertHeld, leaseSignal) => {
      const cdp = require('../lib/cdp');
      const desktop = createAutomation({ ...options, signal: leaseSignal }).desktop;
      const outPath = outArg
        ? path.resolve(outArg)
        : path.join(cdp.artifactsDir(), `desktop-shot-${cdp.formatTimestamp()}.png`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const saveCapture = async (shotOpts) => {
        if (outArg || !options.readOnly) {
          await desktop.adScreenshot(undefined, outPath, shotOpts);
          return;
        }
        const raw = await desktop.adScreenshot(undefined, undefined, shotOpts);
        if (typeof raw?.data !== 'string' || raw.data.length === 0) {
          throw fail('AGENT_DESKTOP_PROTOCOL_ERROR', 'Desktop screenshot response did not return base64 image data');
        }
        fs.writeFileSync(outPath, Buffer.from(raw.data, 'base64'));
      };
      if (kv['--screen'] !== undefined) {
        const screenIdx = Number(kv['--screen']);
        if (!Number.isInteger(screenIdx) || screenIdx < 0) {
          throw fail('INVALID_ARGS', 'desktop shot --screen requires a non-negative integer display index');
        }
        await saveCapture({ screen: screenIdx });
        return { screen: screenIdx, outPath };
      }
      const found = await appRegistry.findMatchingWindows(desktop, kv['--app'], {
        windowId: targetWindowId,
        titleIncludes: kv['--title-includes'],
        preferMainWindow: !targetWindowId && !kv['--title-includes'],
        signal: leaseSignal,
        timeoutMs: options.timeoutMs,
      });
      if (!found.windows.length) {
        let msg = 'Target window for screenshot was not found';
        if (process.platform === 'win32' && found.appSpec?.exeNames?.length) {
          const proc = winHelper.queryRunningProcessPathSync(found.appSpec.exeNames);
          if (proc && (proc.count > 0 || proc.exePath)) {
            const token = kv['--app'] || found.appSpec.key || 'target';
            msg = `Target window for screenshot was not found (process is running in background/system tray; wake it first via "open-app --app ${token}")`;
          }
        }
        throw fail('WINDOW_NOT_FOUND', msg);
      }
      const targetWin = found.windows[0];
      await saveCapture({ windowId: targetWin.id });
      return { windowId: targetWin.id, title: targetWin.title, bounds: targetWin.bounds, outPath };
    });
  }

  if (sub === 'ocr') {
    const rest = args.slice(1);
    const boolFlags = new Set(['--words', '--no-lines', '--lines', '--compact']);
    const kv = pairs(rest.filter(a => !boolFlags.has(a)), [
      '--app', '--window-id', '--window', '--title-includes', '--region', '--find', '--match', '--scale', '--lang', '--max-lines', '--out', '--output',
    ]);
    const outArg = kv['--out'] || kv['--output'];
    if (outArg && options.readOnly) throw fail('READ_ONLY_BLOCKED', 'desktop ocr with custom --out requires --write');
    const findQuery = kv['--find'] ?? kv['--match'];
    const includeWords = rest.includes('--words');
    const explicitNoLines = rest.includes('--no-lines');
    const explicitLines = rest.includes('--lines');
    return exclusiveLock(options, async (_assertHeld, leaseSignal) => {
      const ocr = await createAutomation({ ...options, signal: leaseSignal }).desktop.adOcrWindow(kv['--app'], {
        windowId: kv['--window-id'] || kv['--window'] || options.windowId,
        titleIncludes: kv['--title-includes'],
        region: kv['--region'],
        find: findQuery,
        scale: kv['--scale'] !== undefined ? Number(kv['--scale']) : undefined,
        lang: kv['--lang'],
        includeWords,
        includeLines: explicitNoLines ? false : true,
        maxLines: kv['--max-lines'] !== undefined ? Number(kv['--max-lines']) : undefined,
        compactWindow: rest.includes('--compact'),
        outputPath: outArg ? path.resolve(outArg) : undefined,
        signal: leaseSignal,
        timeoutMs: options.timeoutMs,
      });
      if (findQuery && !explicitLines && !includeWords && Array.isArray(ocr.matches) && ocr.matches.length > 0) {
        const { lines: _omittedLines, ...compactHit } = ocr;
        return compactHit;
      }
      return ocr;
    });
  }

  if (sub === 'click-text') {
    if (options.readOnly) throw fail('READ_ONLY_BLOCKED', 'desktop click-text requires --write');
    if (options.mode !== 'exclusive') throw fail('DESKTOP_FOREGROUND_REQUIRED', 'desktop click-text requires --mode exclusive');
    const rest = args.slice(1);
    const boolFlags = new Set(['--double', '--launch', '--no-restore', '--no-restore-cursor', '--no-ripple']);
    const kv = pairs(rest.filter(a => !boolFlags.has(a)), [
      '--app', '--exe', '--window-id', '--window', '--title-includes', '--text', '--region', '--index', '--button', '--scale', '--scroll-retries', '--scroll-dy', '--click-mode',
    ]);
    return exclusiveLock(options, (_assertHeld, leaseSignal) => {
      const automation = createAutomation({ ...options, signal: leaseSignal });
      return automation.scenes.clickTextVerified(
        automation.desktop,
        {
          app: kv['--app'],
          exePath: kv['--exe'],
          windowId: kv['--window-id'] || kv['--window'] || options.windowId,
          titleIncludes: kv['--title-includes'],
          text: kv['--text'],
          region: kv['--region'],
          index: kv['--index'] !== undefined ? Number(kv['--index']) : 0,
          button: kv['--button'],
          scale: kv['--scale'] !== undefined ? Number(kv['--scale']) : 2,
          scrollRetries: kv['--scroll-retries'] !== undefined ? Number(kv['--scroll-retries']) : 0,
          scrollDy: kv['--scroll-dy'] !== undefined ? Number(kv['--scroll-dy']) : undefined,
          doubleClick: rest.includes('--double'),
          launchIfMissing: rest.includes('--launch'),
          restoreIfMinimized: !rest.includes('--no-restore'),
          restoreCursor: !rest.includes('--no-restore-cursor'),
          ripple: !rest.includes('--no-ripple'),
          ...(kv['--click-mode'] ? { clickMode: kv['--click-mode'] } : {}),
        },
        { signal: leaseSignal, timeoutMs: options.timeoutMs },
      );
    });
  }

  if (sub === 'chat-send') {
    const rest = args.slice(1);
    if (!rest.includes('--stdin')) {
      throw fail('INVALID_ARGS', 'desktop chat-send requires --stdin with JSON payload on standard input');
    }
    const kv = pairs(rest.filter(a => a !== '--stdin'), ['--app', '--window-id', '--window']);
    if (options.readOnly) throw fail('READ_ONLY_BLOCKED', 'desktop chat-send requires --write');
    if (options.mode !== 'exclusive') throw fail('DESKTOP_FOREGROUND_REQUIRED', 'desktop chat-send requires --mode exclusive');
    const raw = await stdinText();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw fail('INVALID_ARGS', 'desktop chat-send --stdin payload must be valid JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw fail('INVALID_ARGS', 'desktop chat-send --stdin requires a JSON object');
    }
    const baseSpec = payload.spec && typeof payload.spec === 'object' ? payload.spec : payload;
    const cliWindowId = kv['--window-id'] || kv['--window'] || options.windowId;
    const spec = {
      ...baseSpec,
      ...(payload.items && !baseSpec.items ? { items: payload.items } : {}),
      ...(payload.messages && !baseSpec.messages && !baseSpec.items ? { messages: payload.messages } : {}),
      ...(kv['--app'] && !baseSpec.app ? { app: kv['--app'] } : {}),
      ...(cliWindowId && !baseSpec.windowId ? { windowId: cliWindowId } : {}),
    };
    return exclusiveLock(options, (_assertHeld, leaseSignal) => {
      const automation = createAutomation({ ...options, signal: leaseSignal });
      return automation.scenes.deliverChatSessionVerified(automation.desktop, spec, {
        signal: leaseSignal,
        timeoutMs: options.timeoutMs,
      });
    });
  }

  if (sub === 'batch') {
    if (args.length !== 2 || args[1] !== '--stdin') {
      throw fail('INVALID_ARGS', 'desktop batch requires --stdin with a JSON step array on standard input');
    }
    const raw = await stdinText();
    let steps;
    try {
      steps = JSON.parse(raw);
    } catch {
      throw fail('INVALID_ARGS', 'desktop batch --stdin payload must be valid JSON');
    }
    return exclusiveLock(options, (_assertHeld, leaseSignal) => (
      createAutomation({ ...options, signal: leaseSignal }).desktop.adBatch(steps, { windowId: options.windowId })
    ));
  }

  if (sub === 'deliver') {
    if (args.length !== 2 || args[1] !== '--stdin') {
      throw fail('INVALID_ARGS', 'desktop deliver requires --stdin with {"spec":{...},"messages":[...]} JSON on standard input');
    }
    const raw = await stdinText();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw fail('INVALID_ARGS', 'desktop deliver --stdin payload must be valid JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw fail('INVALID_ARGS', 'desktop deliver --stdin requires an object with spec and messages');
    }
    const rawSpec = payload.spec && typeof payload.spec === 'object' ? payload.spec : payload;
    return exclusiveLock(options, (_assertHeld, leaseSignal) => {
      const automation = createAutomation({ ...options, signal: leaseSignal });
      const spec = {
        ...rawSpec,
        ...(options.windowId && !rawSpec.windowId ? { windowId: options.windowId } : {}),
      };
      return automation.scenes.deliverMessagesVerified(automation.desktop, spec, payload.messages, {
        signal: leaseSignal,
        timeoutMs: options.timeoutMs,
      });
    });
  }

  if (sub === 'ensure-ready') {
    const rest = args.slice(1);
    const boolFlags = new Set(['--prefer-focused', '--focus', '--no-focus', '--no-restore', '--launch']);
    const kv = pairs(rest.filter(a => !boolFlags.has(a)), ['--app', '--exe', '--window-id', '--window', '--title-includes']);
    const focusOpt = rest.includes('--no-focus') ? false : (rest.includes('--focus') ? true : 'auto');
    if (rest.includes('--launch') || rest.includes('--focus')) {
      if (options.readOnly) throw fail('READ_ONLY_BLOCKED', 'desktop ensure-ready with --launch or --focus requires --write');
      if (options.mode !== 'exclusive') throw fail('DESKTOP_FOREGROUND_REQUIRED', 'desktop ensure-ready with --launch or --focus requires --mode exclusive');
    }
    return exclusiveLock(options, (_assertHeld, leaseSignal) => {
      const automation = createAutomation({ ...options, signal: leaseSignal });
      return automation.scenes.ensureWindowReady(
        automation.desktop,
        {
          app: kv['--app'],
          exePath: kv['--exe'],
          windowId: kv['--window-id'] || kv['--window'] || options.windowId,
          titleIncludes: kv['--title-includes'],
          preferFocused: rest.includes('--prefer-focused') ? true : undefined,
        },
        {
          focus: focusOpt,
          restoreIfMinimized: !rest.includes('--no-restore'),
          launchIfMissing: rest.includes('--launch'),
          signal: leaseSignal,
          timeoutMs: options.timeoutMs,
        },
      );
    });
  }

  if (sub === 'capabilities') {
    const rest = args.slice(1);
    const boolFlags = new Set(['--prefer-focused', '--no-snapshot']);
    const kv = pairs(rest.filter(a => !boolFlags.has(a)), ['--app', '--window-id', '--window', '--title-includes']);
    return exclusiveLock(options, (_assertHeld, leaseSignal) => (
      createAutomation({ ...options, signal: leaseSignal }).desktop.adInspectCapabilities(kv['--app'], {
        windowId: kv['--window-id'] || kv['--window'] || options.windowId,
        titleIncludes: kv['--title-includes'],
        preferFocused: rest.includes('--prefer-focused'),
        includeSnapshot: !rest.includes('--no-snapshot'),
      })
    ));
  }

  const input = args.includes('--stdin') ? await stdinText() : undefined;
  return exclusiveLock(options, (_assertHeld, leaseSignal) => (
    createAutomation({ ...options, signal: leaseSignal }).desktop.adRaw(args, { input, windowId: options.windowId })
  ));
}

async function main(argv, signal) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
    process.stdout.write(HELP);
    return;
  }
  const parsed = parse(argv);
  if (parsed.options.port !== undefined && (!Number.isInteger(parsed.options.port) || parsed.options.port < 1024 || parsed.options.port > 65535)) {
    throw fail('INVALID_ARGS', 'Port must be an integer from 1024 to 65535');
  }
  const loaded = loadLocalConfig(parsed.options);
  let sceneSpec = null;
  if (parsed.options.scene || parsed.options.port) {
    try {
      sceneSpec = sceneMod.applySceneToEnv({ scene: parsed.options.scene, port: parsed.options.port });
    } catch (err) {
      throw fail('INVALID_ARGS', err.message || 'Invalid browser scene or port');
    }
  }
  const options = normalizeOptions({ ...loaded.options, configInfo: loaded.config, signal });
  const [command, ...args] = parsed.rest;
  if (!command || ['help', '--help', '-h'].includes(command)) {
    process.stdout.write(HELP);
    return;
  }
  let data;
  if (command === 'doctor') {
    if (isHelpArgList(args)) { process.stdout.write('doctor [--scene smoke]  Check desktop, OCR, and browser readiness.\n'); return; }
    if (args.length) throw fail('INVALID_ARGS', 'doctor takes no positional arguments');
    data = await doctor(options);
  } else if (command === 'route') {
    if (isHelpArgList(args)) { process.stdout.write(getSubcommandHelp('route')); return; }
    const flagTokens = args.filter(a => a.startsWith('--'));
    if (flagTokens.length === 0 && args.length > 0) {
      const queryText = args.join(' ').trim();
      const urlMatch = queryText.match(/https?:\/\/\S+/i);
      const low = queryText.toLowerCase();
      const inferredApp = /企业微信|企微|wecom|wxwork/.test(low) ? 'wecom'
        : (/微信|wechat|weixin/.test(low) ? 'wechat'
          : (/qq\b|腾讯qq/i.test(low) ? 'qq'
            : (/记事本|notepad/.test(low) ? 'notepad' : null)));
      if (urlMatch) {
        data = {
          ...routeTask({ url: urlMatch[0] }),
          query: queryText,
          recommendedCommand: `node cli/agent.cjs --scene smoke browser snap --open-url ${urlMatch[0]}`,
        };
      } else if (inferredApp) {
        const isVisual = /微信|企微|wechat|wecom|qq|截图|发送|聊天|点击|ocr/.test(low);
        data = {
          ...routeTask({ app: inferredApp, visual: isVisual }),
          app: inferredApp,
          query: queryText,
          recommendedCommand: /发|消息|聊天|图|表情/.test(low)
            ? 'node cli/agent.cjs --write --mode exclusive desktop chat-send --stdin'
            : (/截/.test(low)
              ? `node cli/agent.cjs --write desktop shot --app ${inferredApp} --out .\\${inferredApp}.png`
              : `node cli/agent.cjs --write --mode exclusive desktop open-app --app ${inferredApp}`),
        };
      } else {
        data = {
          ...routeTask({ visual: /截图|屏幕|窗口|desktop|点击/.test(low) }),
          query: queryText,
          usage: 'Pass --url <https://...>, --app <name>, --file <path>, --api, or --visual',
        };
      }
    } else {
      const values = pairs(args.filter(a => !['--api', '--visual'].includes(a)), ['--url', '--app', '--file']);
      data = routeTask({ url: values['--url'], app: values['--app'], file: values['--file'], api: args.includes('--api'), visual: args.includes('--visual') });
    }
  } else if (command === 'desktop') {
    data = await executeDesktopCommand(options, args);
    if (data && typeof data === 'object' && typeof data.helpText === 'string') {
      process.stdout.write(data.helpText);
      return;
    }
  } else if (command === 'browser') {
    data = await executeBrowserCommand(options, args, sceneSpec);
    if (data && typeof data === 'object' && typeof data.helpText === 'string') {
      process.stdout.write(data.helpText);
      return;
    }
  } else if (command === 'run') {
    if (isHelpArgList(args)) { process.stdout.write('node cli/agent.cjs [--write] [--mode exclusive] run --file <workflow.cjs>\n'); return; }
    const values = pairs(args, ['--file']);
    if (!values['--file']) throw fail('INVALID_ARGS', 'run requires --file');
    const filename = path.resolve(values['--file']);
    let stat;
    try {
      stat = fs.statSync(filename);
    } catch {
      throw fail('INVALID_ARGS', `Workflow file not found: ${path.basename(filename)}`);
    }
    if (!stat.isFile()) throw fail('INVALID_ARGS', 'Workflow path must be a file');
    let workflowFn;
    try {
      workflowFn = require(filename);
    } catch (err) {
      const code = typeof err?.code === 'string' && err.code ? err.code : 'WORKFLOW_LOAD_ERROR';
      const firstLine = String(err?.message || 'Unable to load workflow').split(/\r?\n/)[0].slice(0, 240);
      throw fail(code, `Failed to load workflow (${path.basename(filename)}): ${firstLine}`);
    }
    data = await runWorkflow(workflowFn, options);
    if (data.status === 'unverified') process.exitCode = 2;
  } else {
    throw fail('INVALID_ARGS', 'Unknown command; run help for supported commands');
  }
  process.stdout.write(JSON.stringify({ ok: true, command, data }) + '\n');
}

if (require.main === module) {
  const controller = new AbortController();
  const cancel = () => controller.abort(fail('ABORTED', 'Task interrupted; inspect any dispatched operation before retrying', { delivery: 'unknown', retry: 'unsafe' }));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  main(process.argv.slice(2), controller.signal).catch(error => {
    process.stdout.write(JSON.stringify({ ok: false, error: serializeError(error), ...(error.report ? { report: error.report } : {}) }) + '\n');
    process.exitCode = error.report?.status === 'unverified' ? 2 : 1;
  }).finally(() => {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  });
}

module.exports = { main, parse };
