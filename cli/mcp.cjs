#!/usr/bin/env node
const path = require('node:path');
const {
  serveStdio,
  startHttpServer,
  ensureHttpToken,
  DEFAULT_HTTP_PORT,
} = require('../lib/automation/mcpServer');

const HELP = `Agent Browser Bridge Windows Desktop MCP Server

Usage:
  node cli/mcp.cjs [--stdio] [--write] [--config PATH] [--timeout-ms N]
  node cli/mcp.cjs --http [--port 19235] [--write] [--token TOKEN] [--token-file PATH]
  node cli/mcp.cjs --print-config [--http] [--port 19235] [--write]

Transports:
  --stdio   Standard input/output JSON-RPC 2.0 MCP server (default)
  --http    Loopback-only Streamable HTTP MCP server on http://127.0.0.1:<port>/mcp

Security:
  - Read-only by default; pass --write to allow desktop_open_app, desktop_click_text,
    desktop_chat_send, and desktop_deliver.
  - --http binds strictly to 127.0.0.1, rejects browser Origin headers, and requires
    Authorization: Bearer <token> from %LOCALAPPDATA%\\AgentBrowserBridge\\mcp-token.json.
`;

function parseMcpArgs(argv) {
  const opts = {
    transport: 'stdio',
    readOnly: true,
    mode: 'cooperative',
    port: DEFAULT_HTTP_PORT,
    printConfig: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      opts.help = true;
    } else if (arg === '--stdio') {
      opts.transport = 'stdio';
    } else if (arg === '--http') {
      opts.transport = 'http';
    } else if (arg === '--write') {
      opts.readOnly = false;
    } else if (arg === '--print-config') {
      opts.printConfig = true;
    } else if (arg === '--port') {
      opts.port = Number(argv[++i]);
    } else if (arg === '--timeout-ms') {
      opts.timeoutMs = Number(argv[++i]);
    } else if (arg === '--config') {
      opts.configPath = argv[++i];
    } else if (arg === '--binary') {
      opts.binaryPath = argv[++i];
    } else if (arg === '--expected-version') {
      opts.expectedVersion = argv[++i];
    } else if (arg === '--token') {
      opts.token = argv[++i];
    } else if (arg === '--token-file') {
      opts.tokenFile = argv[++i];
    } else {
      throw new Error(`Unknown MCP option: ${arg}`);
    }
  }
  return opts;
}

function buildMcpConfigSnippet(opts) {
  if (opts.transport === 'http') {
    const token = ensureHttpToken({ token: opts.token, tokenFile: opts.tokenFile });
    return {
      mcpServers: {
        'windows-desktop': {
          url: `http://127.0.0.1:${opts.port}/mcp`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    };
  }
  const scriptPath = path.resolve(__filename);
  const args = [scriptPath];
  if (!opts.readOnly) args.push('--write');
  return {
    mcpServers: {
      'windows-desktop': {
        command: process.execPath,
        args,
      },
    },
  };
}

async function main() {
  const opts = parseMcpArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.printConfig) {
    process.stdout.write(JSON.stringify(buildMcpConfigSnippet(opts), null, 2) + '\n');
    return;
  }
  if (opts.transport === 'http') {
    const started = await startHttpServer(opts);
    const banner = {
      ok: true,
      transport: 'streamable-http',
      url: started.url,
      readOnly: opts.readOnly,
      auth: 'Bearer (loopback-only)',
    };
    process.stdout.write(JSON.stringify(banner) + '\n');
    await new Promise((resolve) => {
      const shutdown = () => started.close().then(resolve, resolve);
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
    return;
  }
  await serveStdio(opts);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ ok: false, error: err?.message || String(err) }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { parseMcpArgs, buildMcpConfigSnippet };
