const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMcpDispatcher, reloadModulesIfChanged, startHttpServer } = require('../lib/automation/mcpServer');
const { parseMcpArgs, buildMcpConfigSnippet } = require('../cli/mcp.cjs');

test('MCP dispatcher handles initialize, tools/list, and unknown tool safely', async () => {
  const dispatcher = createMcpDispatcher({ readOnly: true });
  const initRes = await dispatcher.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1.0' } },
  });
  assert.equal(initRes.result.protocolVersion, '2025-03-26');
  assert.equal(initRes.result.serverInfo.name, 'agent-browser-bridge-desktop');

  const notifRes = await dispatcher.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notifRes, null);

  const listRes = await dispatcher.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = listRes.result.tools.map(t => t.name);
  assert.ok(names.includes('desktop_doctor'));
  assert.ok(names.includes('desktop_apps'));
  assert.ok(names.includes('desktop_ocr'));
  assert.ok(names.includes('desktop_chat_send'));

  const unknownRes = await dispatcher.handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'desktop_missing', arguments: {} },
  });
  assert.equal(unknownRes.error.code, -32602);
});

test('MCP read-only mode blocks desktop_chat_send and desktop_open_app before touching OS', async () => {
  const dispatcher = createMcpDispatcher({ readOnly: true });
  const chatRes = await dispatcher.handleMessage({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'desktop_chat_send',
      arguments: { app: 'wecom', sessionName: 'File Helper', messages: ['hello'] },
    },
  });
  assert.equal(chatRes.result.isError, true);
  assert.equal(chatRes.result.structuredContent.error.code, 'READ_ONLY_BLOCKED');

  const openRes = await dispatcher.handleMessage({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'desktop_open_app', arguments: { app: 'wecom' } },
  });
  assert.equal(openRes.result.isError, true);
  assert.equal(openRes.result.structuredContent.error.code, 'READ_ONLY_BLOCKED');
});

test('MCP Streamable HTTP server enforces origin, bearer auth, and JSON-RPC round-trip', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-mcp-'));
  const tokenFile = path.join(tmpDir, 'token.json');
  const started = await startHttpServer({ port: 0, readOnly: true, tokenFile });
  try {
    const unauth = await fetch(started.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(unauth.status, 401);

    const originBlocked = await fetch(started.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${started.token}`,
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(originBlocked.status, 403);

    const listResp = await fetch(started.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${started.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(listResp.status, 200);
    assert.ok(listResp.headers.get('mcp-session-id'));
    const body = await listResp.json();
    assert.ok(Array.isArray(body.result.tools));
    assert.ok(body.result.tools.some(t => t.name === 'desktop_chat_send'));

    const notifResp = await fetch(started.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${started.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(notifResp.status, 202);
  } finally {
    await started.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('MCP stdio CLI responds cleanly over stdin/stdout without stray logs', async () => {
  const repoRoot = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, [path.join(repoRoot, 'cli', 'mcp.cjs')], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString('utf8'); });
  child.stderr.on('data', d => { stderr += d.toString('utf8'); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  child.stdin.end();
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 0);
  assert.equal(stderr.trim(), '');
  const lines = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].result.serverInfo.name, 'agent-browser-bridge-desktop');
  assert.ok(lines[1].result.tools.some(t => t.name === 'desktop_doctor'));
});

test('MCP CLI config generator produces valid stdio and http snippets without local leaks', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-mcp-cfg-'));
  try {
    const stdioOpts = parseMcpArgs(['--write']);
    const stdioCfg = buildMcpConfigSnippet(stdioOpts);
    assert.ok(Array.isArray(stdioCfg.mcpServers['windows-desktop'].args));
    assert.ok(stdioCfg.mcpServers['windows-desktop'].args.includes('--write'));

    const httpOpts = parseMcpArgs(['--http', '--port', '19235', '--write', '--token-file', path.join(tmpDir, 'tok.json')]);
    const httpCfg = buildMcpConfigSnippet(httpOpts);
    assert.equal(httpCfg.mcpServers['windows-desktop'].url, 'http://127.0.0.1:19235/mcp');
    assert.match(httpCfg.mcpServers['windows-desktop'].headers.Authorization, /^Bearer [0-9a-f]{48}$/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('MCP exposes desktop_snapshot, desktop_query, desktop_act with auto cooperative/exclusive escalation and hot-reload', async () => {
  const fixture = path.join(__dirname, 'fixtures', 'agent-desktop-fixture.cjs');
  const tmpLock = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-mcp-act-'));
  const isoCfg = path.join(tmpLock, 'automation.json');
  fs.writeFileSync(isoCfg, '{}', 'utf8');
  try {
    const roDispatcher = createMcpDispatcher({
      readOnly: true,
      configPath: isoCfg,
      binaryPath: process.execPath,
      binaryArgs: [fixture, 'cap-uia'],
      lockDir: tmpLock,
    });
    const listRes = await roDispatcher.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const toolNames = listRes.result.tools.map(t => t.name);
    assert.equal(toolNames.length, 14);
    for (const expected of ['desktop_snapshot', 'desktop_query', 'desktop_act']) {
      assert.ok(toolNames.includes(expected), `Expected ${expected} in MCP tools`);
    }

    // Compact capabilities omits raw snapshot by default (~90% smaller)
    const capCompact = await roDispatcher.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'desktop_capabilities', arguments: { windowId: 'w-123' } },
    });
    assert.equal(capCompact.result.isError, false);
    assert.equal(capCompact.result.structuredContent.data.snapshot, undefined);
    assert.equal(capCompact.result.structuredContent.data.mode, 'uia_semantic');

    // desktop_snapshot caps tree nodes when maxNodes is small
    const snapCapped = await roDispatcher.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'desktop_snapshot', arguments: { windowId: 'w-123', maxNodes: 2 } },
    });
    assert.equal(snapCapped.result.isError, false);
    assert.equal(snapCapped.result.structuredContent.data.truncatedNodes, 2);

    // desktop_query works in read-only mode
    const queryFind = await roDispatcher.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'desktop_query', arguments: { action: 'find', app: 'fixture.exe', role: 'button', first: true } },
    });
    assert.equal(queryFind.result.isError, false);
    assert.ok(queryFind.result.structuredContent.data.args.includes('--first'));

    // Read-only blocks desktop_act mutations and custom file-output paths on shot/ocr
    const blockedAct = await roDispatcher.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'desktop_act', arguments: { command: 'click', ref: '@suia1:e3' } },
    });
    assert.equal(blockedAct.result.isError, true);
    assert.equal(blockedAct.result.structuredContent.error.code, 'READ_ONLY_BLOCKED');

    const blockedShotOut = await roDispatcher.handleMessage({
      jsonrpc: '2.0',
      id: 51,
      method: 'tools/call',
      params: { name: 'desktop_shot', arguments: { windowId: 'w-123', outPath: path.join(tmpLock, 'overwrite.png') } },
    });
    assert.equal(blockedShotOut.result.isError, true);
    assert.equal(blockedShotOut.result.structuredContent.error.code, 'READ_ONLY_BLOCKED');

    const roShotArtifact = await roDispatcher.handleMessage({
      jsonrpc: '2.0',
      id: 52,
      method: 'tools/call',
      params: { name: 'desktop_shot', arguments: { windowId: 'w-123' } },
    });
    assert.equal(roShotArtifact.result.isError, false);
    assert.ok(fs.existsSync(roShotArtifact.result.structuredContent.data.outPath));
    try { fs.unlinkSync(roShotArtifact.result.structuredContent.data.outPath); } catch {}

    // Writable dispatcher runs pure UIA steps in cooperative mode and foreground steps in exclusive mode
    const rwDispatcher = createMcpDispatcher({
      readOnly: false,
      mode: 'cooperative',
      configPath: isoCfg,
      binaryPath: process.execPath,
      binaryArgs: [fixture, 'batch-stdin-normal'],
      lockDir: tmpLock,
    });
    const coopAct = await rwDispatcher.handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'desktop_act',
        arguments: {
          steps: [
            { command: 'set-value', ref: '@suia1:e2', value: 'hello world' },
            { command: 'select', ref: '@suia1:e2', value: 'Item 1' },
            { command: 'check', ref: '@suia1:e2' },
            { command: 'click', ref: '@suia1:e3' },
          ],
        },
      },
    });
    assert.equal(coopAct.result.isError, false);
    assert.equal(coopAct.result.structuredContent.data.mode, 'cooperative');
    assert.equal(coopAct.result.structuredContent.data.completed_entries, 4);

    // Foreground step auto-escalates to exclusive mode
    const exclAct = await rwDispatcher.handleMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'desktop_act',
        arguments: {
          windowId: 'w-123',
          steps: [
            { command: 'resize-window', windowId: 'w-123', width: 800, height: 600 },
            { command: 'press', combo: 'return', windowId: 'w-123' },
          ],
        },
      },
    });
    assert.equal(exclAct.result.isError, false);
    assert.equal(exclAct.result.structuredContent.data.mode, 'exclusive');

    // Partial-batch failure marks retry:'unsafe' when an earlier step already mutated UI, and preserves error.details!
    const comboDispatcher = createMcpDispatcher({
      readOnly: false,
      mode: 'cooperative',
      configPath: isoCfg,
      binaryPath: process.execPath,
      binaryArgs: [fixture, 'batch-stdin-select-unsupported'],
      lockDir: tmpLock,
    });
    // Single-step select auto-falls back to set-value
    const singleSelect = await comboDispatcher.handleMessage({
      jsonrpc: '2.0',
      id: 71,
      method: 'tools/call',
      params: { name: 'desktop_act', arguments: { command: 'select', ref: '@suia1:e2', value: 'Urgent' } },
    });
    assert.equal(singleSelect.result.isError, false);
    assert.equal(singleSelect.result.structuredContent.data.transport, 'fallback-set-value');

    // Multi-step batch where Step 0 mutated UI and Step 1 failed preflight -> MUST report retry:'unsafe' + details.failedStepIndex=1
    const partialBatch = await comboDispatcher.handleMessage({
      jsonrpc: '2.0',
      id: 72,
      method: 'tools/call',
      params: {
        name: 'desktop_act',
        arguments: {
          steps: [
            { command: 'set-value', ref: '@suia1:e2', value: 'already-mutated' },
            { command: 'select', ref: '@suia1:e2', value: 'Urgent' },
          ],
        },
      },
    });
    assert.equal(partialBatch.result.isError, true);
    assert.deepEqual(partialBatch.result.structuredContent.error.disposition, { delivery: 'unknown', retry: 'unsafe' });
    assert.equal(partialBatch.result.structuredContent.error.details.failedStepIndex, 1);
    assert.equal(partialBatch.result.structuredContent.error.details.completedEntries, 2);

    // Hot-reload detects touched module mtime and increments reloadCount in desktop_doctor
    const targetJs = path.resolve(__dirname, '..', 'lib', 'desktop', 'appRegistry.js');
    const origStat = fs.statSync(targetJs);
    const bumpedTime = new Date(Date.now() + 2000);
    fs.utimesSync(targetJs, bumpedTime, bumpedTime);
    try {
      const reloaded = reloadModulesIfChanged({ force: true });
      assert.equal(reloaded, true);
      const docRes = await rwDispatcher.handleMessage({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'desktop_doctor', arguments: {} },
      });
      assert.equal(docRes.result.isError, false);
      assert.ok(docRes.result.structuredContent.data.mcpRuntime.reloadCount >= 1);
    } finally {
      try { fs.utimesSync(targetJs, origStat.atime, origStat.mtime); } catch {}
    }
  } finally {
    fs.rmSync(tmpLock, { recursive: true, force: true });
  }
});
