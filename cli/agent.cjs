#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createAutomation, routeTask, doctor, runWorkflow, exclusiveLock, loadLocalConfig } = require('../lib/automation');
const { fail, normalizeOptions, serializeError } = require('../lib/automation/errors');
const sceneMod = require('../lib/cdp/scene');

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
  node cli/agent.cjs desktop capabilities --app notepad.exe [--window-id w-...] [--title-includes SUB]
  node cli/agent.cjs --write --mode exclusive desktop ensure-ready --app notepad.exe [--no-focus] [--no-restore]
  node cli/agent.cjs --write [--mode exclusive] desktop deliver --stdin
  node cli/agent.cjs --write [--mode exclusive] desktop batch --stdin
  node cli/agent.cjs desktop snapshot --app explorer.exe
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
  if (!args.length) {
    throw fail('INVALID_ARGS', 'browser requires a subcommand (scenes|tabs|snap|read|click|hover|hover-click|fill|type|select|wait|close|press|shot)');
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
  if (!args.length) throw fail('INVALID_ARGS', 'desktop requires a command');
  const sub = args[0];

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
    return exclusiveLock(options, (_assertHeld, leaseSignal) => {
      const automation = createAutomation({ ...options, signal: leaseSignal });
      const spec = {
        ...(payload.spec && typeof payload.spec === 'object' ? payload.spec : {}),
        ...(options.windowId && !payload.spec?.windowId ? { windowId: options.windowId } : {}),
      };
      return automation.scenes.deliverMessagesVerified(automation.desktop, spec, payload.messages, {
        signal: leaseSignal,
        timeoutMs: options.timeoutMs,
      });
    });
  }

  if (sub === 'ensure-ready') {
    const rest = args.slice(1);
    const boolFlags = new Set(['--prefer-focused', '--focus', '--no-focus', '--no-restore']);
    const kv = pairs(rest.filter(a => !boolFlags.has(a)), ['--app', '--window-id', '--title-includes']);
    const focusOpt = rest.includes('--no-focus') ? false : (rest.includes('--focus') ? true : 'auto');
    return exclusiveLock(options, (_assertHeld, leaseSignal) => {
      const automation = createAutomation({ ...options, signal: leaseSignal });
      return automation.scenes.ensureWindowReady(
        automation.desktop,
        {
          app: kv['--app'],
          windowId: kv['--window-id'] || options.windowId,
          titleIncludes: kv['--title-includes'],
          preferFocused: rest.includes('--prefer-focused') ? true : undefined,
        },
        {
          focus: focusOpt,
          restoreIfMinimized: !rest.includes('--no-restore'),
          signal: leaseSignal,
          timeoutMs: options.timeoutMs,
        },
      );
    });
  }

  if (sub === 'capabilities') {
    const rest = args.slice(1);
    const preferFocused = rest.includes('--prefer-focused');
    const kv = pairs(rest.filter(a => a !== '--prefer-focused'), ['--app', '--window-id', '--title-includes']);
    return exclusiveLock(options, (_assertHeld, leaseSignal) => (
      createAutomation({ ...options, signal: leaseSignal }).desktop.adInspectCapabilities(kv['--app'], {
        windowId: kv['--window-id'] || options.windowId,
        titleIncludes: kv['--title-includes'],
        preferFocused,
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
  let data;
  if (command === 'doctor') {
    if (args.length) throw fail('INVALID_ARGS', 'doctor takes no positional arguments');
    data = await doctor(options);
  } else if (command === 'route') {
    const values = pairs(args.filter(a => !['--api', '--visual'].includes(a)), ['--url', '--app', '--file']);
    data = routeTask({ url: values['--url'], app: values['--app'], file: values['--file'], api: args.includes('--api'), visual: args.includes('--visual') });
  } else if (command === 'desktop') {
    data = await executeDesktopCommand(options, args);
  } else if (command === 'browser') {
    data = await executeBrowserCommand(options, args, sceneSpec);
  } else if (command === 'run') {
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
