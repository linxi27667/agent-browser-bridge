const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMcpDispatcher, startHttpServer } = require('../lib/automation/mcpServer');
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
