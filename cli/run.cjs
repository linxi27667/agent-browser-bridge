#!/usr/bin/env node
// AgentBrowserBridge - Code-First 批量执行器 CLI (cli/run.cjs)
// 用法：
//   node cli/run.cjs --code "return await cdp.listSiteLearnings()"
//   node cli/run.cjs --file path/to/snippet.js
//   Get-Content snippet.js | node cli/run.cjs
//   node cli/run.cjs --validate-learnings

const fs = require('node:fs');
const path = require('node:path');
const cdp = require('../lib/cdp');

function parseArgs(argv) {
  const args = {
    code: '',
    file: '',
    validateLearnings: false,
    listLearnings: false,
    maxOutputLength: 20000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--code' || arg === '-e') {
      args.code = argv[++i] || '';
    } else if (arg === '--file' || arg === '-f') {
      args.file = argv[++i] || '';
    } else if (arg === '--validate-learnings') {
      args.validateLearnings = true;
    } else if (arg === '--list-learnings') {
      args.listLearnings = true;
    } else if (arg === '--max-output') {
      args.maxOutputLength = Number(argv[++i]) || 20000;
    }
  }
  return args;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.validateLearnings) {
    const report = cdp.validateSiteLearnings();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exit(1);
    return;
  }
  if (parsed.listLearnings) {
    const sites = cdp.listSiteLearnings();
    console.log(JSON.stringify(sites, null, 2));
    return;
  }

  let code = parsed.code;
  if (!code && parsed.file) {
    code = fs.readFileSync(path.resolve(parsed.file), 'utf8');
  }
  if (!code) {
    code = await readStdin();
  }
  if (!code || !code.trim()) {
    console.error('Usage: node cli/run.cjs --code "<async js>" | --file <file.js> | --validate-learnings');
    process.exit(1);
  }

  const res = await cdp.runScript(code, {
    maxOutputLength: parsed.maxOutputLength,
  });
  if (res.output) {
    console.log(res.output);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
