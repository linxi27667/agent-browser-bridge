const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { createAutomation, doctor, runWorkflow, exclusiveLock, loadLocalConfig } = require('./index');
const { fail, normalizeOptions, serializeError } = require('./errors');
const appRegistry = require('../desktop/appRegistry');
const pkg = require('../../package.json');

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_HTTP_PORT = 19235;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readJsonArg(args, key) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return args[key];
}

function buildServerOptions(baseOptions = {}, overrides = {}, signal) {
  const loaded = loadLocalConfig({
    ...baseOptions,
    ...overrides,
  });
  return normalizeOptions({
    ...loaded.options,
    configInfo: loaded.config,
    signal,
  });
}

function enforceWriteMode(options, actionName, { requireExclusive = false } = {}) {
  if (options.readOnly) {
    throw fail('READ_ONLY_BLOCKED', `${actionName} requires server --write authorization`);
  }
  if (requireExclusive && options.mode !== 'exclusive') {
    throw fail('DESKTOP_FOREGROUND_REQUIRED', `${actionName} requires exclusive mode`);
  }
}

function buildToolDefinitions() {
  return [
    {
      name: 'desktop_doctor',
      description: 'Inspect Windows desktop session (isInteractiveDefaultDesktop, threadDesktop), OCR readiness, agent-desktop status, and browser bridge readiness.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const opts = buildServerOptions(baseOptions, { timeoutMs: readJsonArg(args, 'timeoutMs') }, signal);
        return doctor(opts);
      },
    },
    {
      name: 'desktop_apps',
      description: 'Discover supported Windows desktop app aliases (wecom, wechat, qq, feishu, dingtalk, notepad, explorer, calc, mspaint) and running apps.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string', description: 'Optional app alias or process name to resolve.' },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const opts = buildServerOptions(baseOptions, { timeoutMs: readJsonArg(args, 'timeoutMs') }, signal);
        return exclusiveLock(opts, async (_assertHeld, leaseSignal) => {
          const desktop = createAutomation({ ...opts, signal: leaseSignal }).desktop;
          const running = await desktop.adListApps().catch(() => []);
          const appName = readJsonArg(args, 'app');
          const known = appName ? [appRegistry.resolveAppSpec(appName)] : appRegistry.listKnownApps();
          return { knownApps: known, runningApps: running };
        });
      },
    },
    {
      name: 'desktop_windows',
      description: 'List visible desktop windows, optionally filtered by app alias/process, windowId, or title substring.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string' },
          exePath: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const opts = buildServerOptions(baseOptions, {
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        return exclusiveLock(opts, async (_assertHeld, leaseSignal) => {
          const desktop = createAutomation({ ...opts, signal: leaseSignal }).desktop;
          const found = await appRegistry.findMatchingWindows(desktop, readJsonArg(args, 'app'), {
            windowId: opts.windowId,
            titleIncludes: readJsonArg(args, 'titleIncludes'),
            exePath: readJsonArg(args, 'exePath'),
            signal: leaseSignal,
            timeoutMs: opts.timeoutMs,
          });
          return { count: found.windows.length, windows: found.windows };
        });
      },
    },
    {
      name: 'desktop_capabilities',
      description: 'Inspect window accessibility capabilities (uia_semantic vs custom_ui_visual) and separate writable vs read-only edit boxes.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          preferFocused: { type: 'boolean' },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const opts = buildServerOptions(baseOptions, {
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        return exclusiveLock(opts, (_assertHeld, leaseSignal) => (
          createAutomation({ ...opts, signal: leaseSignal }).desktop.adInspectCapabilities(
            readJsonArg(args, 'app'),
            {
              windowId: opts.windowId,
              titleIncludes: readJsonArg(args, 'titleIncludes'),
              preferFocused: Boolean(readJsonArg(args, 'preferFocused')),
            },
          )
        ));
      },
    },
    {
      name: 'desktop_ocr',
      description: 'Capture a window region via PrintWindow and run Windows.Media.Ocr (zh-Hans-CN) without stealing foreground focus.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          region: { type: 'string', description: 'full | header | sidebar | messages | composer | x,y,w,h' },
          find: { type: 'string', description: 'Optional target text to locate.' },
          scale: { type: 'number', minimum: 1, maximum: 4 },
          lang: { type: 'string' },
          outputPath: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const opts = buildServerOptions(baseOptions, {
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        const outArg = readJsonArg(args, 'outputPath');
        return exclusiveLock(opts, (_assertHeld, leaseSignal) => (
          createAutomation({ ...opts, signal: leaseSignal }).desktop.adOcrWindow(readJsonArg(args, 'app'), {
            windowId: opts.windowId,
            titleIncludes: readJsonArg(args, 'titleIncludes'),
            region: readJsonArg(args, 'region'),
            find: readJsonArg(args, 'find'),
            scale: readJsonArg(args, 'scale'),
            lang: readJsonArg(args, 'lang'),
            outputPath: outArg ? path.resolve(outArg) : undefined,
            signal: leaseSignal,
            timeoutMs: opts.timeoutMs,
          })
        ));
      },
    },
    {
      name: 'desktop_shot',
      description: 'Capture a PNG screenshot of a target desktop window or screen.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          screen: { type: 'integer', minimum: 0 },
          outPath: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 60000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const opts = buildServerOptions(baseOptions, {
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        return exclusiveLock(opts, async (_assertHeld, leaseSignal) => {
          const cdp = require('../cdp');
          const desktop = createAutomation({ ...opts, signal: leaseSignal }).desktop;
          const outArg = readJsonArg(args, 'outPath');
          const outPath = outArg
            ? path.resolve(outArg)
            : path.join(cdp.artifactsDir(), `desktop-shot-${cdp.formatTimestamp()}.png`);
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          const screen = readJsonArg(args, 'screen');
          if (screen !== undefined) {
            await desktop.adScreenshot(undefined, outPath, { screen: Number(screen) });
            return { screen: Number(screen), outPath };
          }
          const found = await appRegistry.findMatchingWindows(desktop, readJsonArg(args, 'app'), {
            windowId: opts.windowId,
            titleIncludes: readJsonArg(args, 'titleIncludes'),
            signal: leaseSignal,
            timeoutMs: opts.timeoutMs,
          });
          if (!found.windows.length) throw fail('WINDOW_NOT_FOUND', 'Target window for screenshot was not found');
          const targetWin = found.windows[0];
          await desktop.adScreenshot(undefined, outPath, { windowId: targetWin.id });
          return { windowId: targetWin.id, title: targetWin.title, bounds: targetWin.bounds, outPath };
        });
      },
    },
    {
      name: 'desktop_open_app',
      description: 'Open or wake a tray-hidden Windows desktop application (such as wecom, wechat, qq, notepad) and bring it ready in exclusive mode.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['app'],
        properties: {
          app: { type: 'string', description: 'App alias or process name, e.g. wecom, wechat, qq, notepad.' },
          exePath: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          focus: { type: 'boolean', default: true },
          restoreIfMinimized: { type: 'boolean', default: true },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const opts = buildServerOptions(baseOptions, {
          mode: 'exclusive',
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        enforceWriteMode(opts, 'desktop_open_app', { requireExclusive: true });
        return exclusiveLock(opts, (_assertHeld, leaseSignal) => {
          const automation = createAutomation({ ...opts, signal: leaseSignal });
          const focusArg = readJsonArg(args, 'focus');
          return automation.scenes.ensureWindowReady(
            automation.desktop,
            {
              app: readJsonArg(args, 'app'),
              exePath: readJsonArg(args, 'exePath'),
              windowId: opts.windowId,
              titleIncludes: readJsonArg(args, 'titleIncludes'),
              preferFocused: true,
            },
            {
              focus: focusArg === undefined ? 'auto' : Boolean(focusArg),
              restoreIfMinimized: readJsonArg(args, 'restoreIfMinimized') !== false,
              launchIfMissing: true,
              signal: leaseSignal,
              timeoutMs: opts.timeoutMs,
            },
          );
        });
      },
    },
    {
      name: 'desktop_ensure_ready',
      description: 'Restore a minimized window, check usable size, and optionally focus or launch it.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          app: { type: 'string' },
          exePath: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          focus: { type: 'boolean' },
          launchIfMissing: { type: 'boolean', default: false },
          restoreIfMinimized: { type: 'boolean', default: true },
          preferFocused: { type: 'boolean', default: false },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const focusArg = readJsonArg(args, 'focus');
        const launchIfMissing = Boolean(readJsonArg(args, 'launchIfMissing'));
        const needsWrite = launchIfMissing || focusArg === true;
        const opts = buildServerOptions(baseOptions, {
          ...(needsWrite ? { mode: 'exclusive' } : {}),
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        if (needsWrite) enforceWriteMode(opts, 'desktop_ensure_ready', { requireExclusive: true });
        return exclusiveLock(opts, (_assertHeld, leaseSignal) => {
          const automation = createAutomation({ ...opts, signal: leaseSignal });
          return automation.scenes.ensureWindowReady(
            automation.desktop,
            {
              app: readJsonArg(args, 'app'),
              exePath: readJsonArg(args, 'exePath'),
              windowId: opts.windowId,
              titleIncludes: readJsonArg(args, 'titleIncludes'),
              preferFocused: readJsonArg(args, 'preferFocused') ? true : undefined,
            },
            {
              focus: focusArg === undefined ? 'auto' : Boolean(focusArg),
              restoreIfMinimized: readJsonArg(args, 'restoreIfMinimized') !== false,
              launchIfMissing,
              signal: leaseSignal,
              timeoutMs: opts.timeoutMs,
            },
          );
        });
      },
    },
    {
      name: 'desktop_click_text',
      description: 'Locate visible label text in a window region using WinRT OCR and click its center in exclusive mode.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          app: { type: 'string' },
          exePath: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          text: { type: 'string' },
          region: { type: 'string' },
          index: { type: 'integer', minimum: 0, default: 0 },
          button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
          doubleClick: { type: 'boolean', default: false },
          launchIfMissing: { type: 'boolean', default: false },
          restoreIfMinimized: { type: 'boolean', default: true },
          scale: { type: 'number', minimum: 1, maximum: 4, default: 2 },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const opts = buildServerOptions(baseOptions, {
          mode: 'exclusive',
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        enforceWriteMode(opts, 'desktop_click_text', { requireExclusive: true });
        return exclusiveLock(opts, (_assertHeld, leaseSignal) => {
          const automation = createAutomation({ ...opts, signal: leaseSignal });
          return automation.scenes.clickTextVerified(
            automation.desktop,
            {
              app: readJsonArg(args, 'app'),
              exePath: readJsonArg(args, 'exePath'),
              windowId: opts.windowId,
              titleIncludes: readJsonArg(args, 'titleIncludes'),
              text: readJsonArg(args, 'text'),
              region: readJsonArg(args, 'region'),
              index: readJsonArg(args, 'index') ?? 0,
              button: readJsonArg(args, 'button'),
              scale: readJsonArg(args, 'scale') ?? 2,
              doubleClick: Boolean(readJsonArg(args, 'doubleClick')),
              launchIfMissing: Boolean(readJsonArg(args, 'launchIfMissing')),
              restoreIfMinimized: readJsonArg(args, 'restoreIfMinimized') !== false,
            },
            { signal: leaseSignal, timeoutMs: opts.timeoutMs },
          );
        });
      },
    },
    {
      name: 'desktop_chat_send',
      description: 'Open/wake IM window (e.g. wecom, wechat, qq), verify exact header OCR target match (CHAT_TARGET_UNVERIFIED gate), and send text/image/sticker/file items in one verified batch.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionName'],
        properties: {
          app: { type: 'string', default: 'wecom' },
          exePath: { type: 'string' },
          windowId: { type: 'string' },
          titleIncludes: { type: 'string' },
          sessionName: { type: 'string', description: 'Exact chat session title, e.g. 文件传输助手.' },
          launchIfMissing: { type: 'boolean', default: true },
          restoreIfMinimized: { type: 'boolean', default: true },
          searchShortcut: { type: 'boolean', default: true },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['text', 'image', 'sticker', 'file'] },
                text: { type: 'string' },
                path: { type: 'string' },
              },
            },
          },
          messages: {
            type: 'array',
            items: { type: 'string' },
          },
          timeoutMs: { type: 'integer', minimum: 2000, maximum: 180000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const opts = buildServerOptions(baseOptions, {
          mode: 'exclusive',
          windowId: readJsonArg(args, 'windowId'),
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        enforceWriteMode(opts, 'desktop_chat_send', { requireExclusive: true });
        return exclusiveLock(opts, (_assertHeld, leaseSignal) => {
          const automation = createAutomation({ ...opts, signal: leaseSignal });
          return automation.scenes.deliverChatSessionVerified(
            automation.desktop,
            {
              app: readJsonArg(args, 'app') || 'wecom',
              exePath: readJsonArg(args, 'exePath'),
              windowId: opts.windowId,
              titleIncludes: readJsonArg(args, 'titleIncludes'),
              sessionName: readJsonArg(args, 'sessionName'),
              launchIfMissing: readJsonArg(args, 'launchIfMissing') !== false,
              restoreIfMinimized: readJsonArg(args, 'restoreIfMinimized') !== false,
              searchShortcut: readJsonArg(args, 'searchShortcut') !== false,
              ...(readJsonArg(args, 'items') ? { items: readJsonArg(args, 'items') } : {}),
              ...(readJsonArg(args, 'messages') ? { messages: readJsonArg(args, 'messages') } : {}),
            },
            { signal: leaseSignal, timeoutMs: opts.timeoutMs },
          );
        });
      },
    },
    {
      name: 'desktop_deliver',
      description: 'Deliver multiple text messages to a standard uia_semantic desktop window using single-process batching and readback verification.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['spec', 'messages'],
        properties: {
          spec: { type: 'object' },
          messages: { type: 'array', items: { type: 'string' }, minItems: 1 },
          mode: { type: 'string', enum: ['cooperative', 'exclusive'], default: 'cooperative' },
          timeoutMs: { type: 'integer', minimum: 2000, maximum: 180000 },
        },
      },
      async execute(args, baseOptions, signal) {
        const opts = buildServerOptions(baseOptions, {
          mode: readJsonArg(args, 'mode') || baseOptions.mode,
          windowId: readJsonArg(args, 'spec')?.windowId,
          timeoutMs: readJsonArg(args, 'timeoutMs'),
        }, signal);
        enforceWriteMode(opts, 'desktop_deliver', { requireExclusive: false });
        return exclusiveLock(opts, (_assertHeld, leaseSignal) => {
          const automation = createAutomation({ ...opts, signal: leaseSignal });
          return automation.scenes.deliverMessagesVerified(
            automation.desktop,
            readJsonArg(args, 'spec'),
            readJsonArg(args, 'messages'),
            { signal: leaseSignal, timeoutMs: opts.timeoutMs },
          );
        });
      },
    },
  ];
}

function jsonRpcSuccess(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function createMcpDispatcher(serverOptions = {}) {
  const tools = buildToolDefinitions();
  const toolMap = new Map(tools.map(t => [t.name, t]));
  const normalizedBase = { ...serverOptions };
  if (normalizedBase.readOnly === undefined) normalizedBase.readOnly = true;
  if (!normalizedBase.mode) normalizedBase.mode = 'cooperative';

  const listPayload = () => ({
    tools: tools.map(({ name, description, annotations, inputSchema }) => ({
      name,
      description,
      annotations,
      inputSchema,
    })),
  });

  async function handleMessage(msg, signal) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return jsonRpcError(null, -32600, 'Invalid Request: expected JSON-RPC object');
    }
    const hasId = Object.hasOwn(msg, 'id') && msg.id !== undefined && msg.id !== null;
    const method = msg.method;
    if (typeof method !== 'string') {
      return hasId ? jsonRpcError(msg.id, -32600, 'Invalid Request: missing method') : null;
    }

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null;
    }
    if (!hasId) {
      return null;
    }

    if (method === 'initialize') {
      const requested = msg.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return jsonRpcSuccess(msg.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-browser-bridge-desktop', version: pkg.version },
        instructions: [
          'Call desktop_doctor first to check isInteractiveDefaultDesktop.',
          'For WeCom/WeChat/QQ zero-UIA windows, call desktop_chat_send directly instead of probing UIA trees.',
          'Never automatically retry after delivered_unverified or CHAT_TARGET_UNVERIFIED; inspect via desktop_ocr or desktop_shot first.',
        ].join(' '),
      });
    }

    if (method === 'ping') {
      return jsonRpcSuccess(msg.id, {});
    }

    if (method === 'tools/list') {
      return jsonRpcSuccess(msg.id, listPayload());
    }

    if (method === 'tools/call') {
      const name = msg.params?.name;
      const tool = toolMap.get(name);
      if (!tool) {
        return jsonRpcError(msg.id, -32602, `Unknown MCP tool: ${String(name || '')}`);
      }
      try {
        const data = await tool.execute(msg.params?.arguments || {}, normalizedBase, signal);
        return jsonRpcSuccess(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name, data }) }],
          structuredContent: { ok: true, tool: name, data },
          isError: false,
        });
      } catch (err) {
        const serialized = serializeError(err);
        return jsonRpcSuccess(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, tool: name, error: serialized }) }],
          structuredContent: { ok: false, tool: name, error: serialized },
          isError: true,
        });
      }
    }

    return jsonRpcError(msg.id, -32601, `Method not found: ${method}`);
  }

  return { handleMessage, listPayload };
}

function defaultTokenFilePath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'AgentBrowserBridge', 'mcp-token.json');
}

function ensureHttpToken({ token, tokenFile } = {}) {
  if (token) return String(token);
  const filePath = path.resolve(tokenFile || defaultTokenFilePath());
  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (existing && typeof existing.token === 'string' && existing.token.length >= 24) {
      return existing.token;
    }
  } catch {}
  const generated = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ token: generated, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return generated;
}

function serveStdio(options = {}) {
  const dispatcher = createMcpDispatcher(options);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set();

  const writeResponse = (obj) => {
    if (!obj) return;
    process.stdout.write(JSON.stringify(obj) + '\n');
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeResponse(jsonRpcError(null, -32700, 'Parse error: invalid JSON'));
      return;
    }
    const p = (async () => {
      if (Array.isArray(parsed)) {
        const results = (await Promise.all(parsed.map(item => dispatcher.handleMessage(item)))).filter(Boolean);
        if (results.length) writeResponse(results);
        return;
      }
      const res = await dispatcher.handleMessage(parsed);
      writeResponse(res);
    })().catch((err) => {
      writeResponse(jsonRpcError(parsed?.id ?? null, -32603, err?.message || 'Internal error'));
    });
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
  });

  return new Promise((resolve) => {
    rl.on('close', async () => {
      await Promise.allSettled([...inFlight]);
      resolve();
    });
  });
}

function constantTimeTokenMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function readHttpBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(fail('INVALID_ARGS', 'MCP HTTP request body exceeds 2 MiB limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function startHttpServer(options = {}) {
  const host = DEFAULT_HTTP_HOST;
  const port = options.port === undefined ? DEFAULT_HTTP_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw fail('INVALID_ARGS', 'MCP HTTP port must be an integer between 0 and 65535');
  }
  const token = ensureHttpToken({ token: options.token, tokenFile: options.tokenFile });
  const dispatcher = createMcpDispatcher(options);
  const sessionId = crypto.randomUUID();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.origin) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'FORBIDDEN_ORIGIN', message: 'Browser origins are not allowed on local MCP desktop endpoint' }));
        return;
      }

      const authHeader = String(req.headers.authorization || '');
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!constantTimeTokenMatch(bearer, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Valid Bearer token is required' }));
        return;
      }

      const reqPath = String(req.url || '').split('?')[0];
      if (reqPath !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'Use /mcp for Streamable HTTP MCP traffic' }));
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        res.writeHead(req.method === 'GET' ? 405 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: req.method === 'DELETE', message: req.method === 'GET' ? 'SSE stream not required; POST /mcp' : 'Session acknowledged' }));
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }));
        return;
      }

      const raw = await readHttpBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error: invalid JSON')));
        return;
      }

      const ac = new AbortController();
      req.once('close', () => ac.abort());

      if (Array.isArray(parsed)) {
        const replies = (await Promise.all(parsed.map(item => dispatcher.handleMessage(item, ac.signal)))).filter(Boolean);
        if (!replies.length) {
          res.writeHead(202, { 'Mcp-Session-Id': sessionId });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId });
        res.end(JSON.stringify(replies));
        return;
      }

      const reply = await dispatcher.handleMessage(parsed, ac.signal);
      if (!reply) {
        res.writeHead(202, { 'Mcp-Session-Id': sessionId });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId });
      res.end(JSON.stringify(reply));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(null, -32603, err?.message || 'Internal server error')));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  return {
    server,
    host,
    port: addr.port,
    url: `http://${host}:${addr.port}/mcp`,
    token,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

module.exports = {
  createMcpDispatcher,
  serveStdio,
  startHttpServer,
  ensureHttpToken,
  defaultTokenFilePath,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
};
