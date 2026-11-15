#!/usr/bin/env node
// AgentBrowserBridge / GcWebAuto - Code-First 批量执行器 CLI (cli/run.cjs)
// 用法：
//   node cli/run.cjs --scene k3 --code "return await cdp.listTargets()"
//   node cli/run.cjs --scene k3-admin --file path/to/snippet.js
//   Get-Content snippet.js | node cli/run.cjs --scene k3
//   node cli/run.cjs --validate-learnings

const fs = require('node:fs');
const path = require('node:path');
const sceneMod = require('../lib/cdp/scene');

function parseArgs(argv) {
  const args = {
    scene: '',
    port: 0,
    code: '',
    file: '',
    validateLearnings: false,
    listLearnings: false,
    maxOutputLength: 20000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--scene' || arg === '-s') {
      args.scene = argv[++i] || '';
    } else if (arg === '--port' || arg === '-p') {
      args.port = Number(argv[++i]) || 0;
    } else if (arg === '--code' || arg === '-e') {
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
  if (
    !parsed.validateLearnings
    && !parsed.listLearnings
    && fs.existsSync(path.join(__dirname, 'agent.cjs'))
    && !process.env.NODE_TEST_CONTEXT
    && process.env.ABB_QUIET_LEGACY !== '1'
  ) {
    process.stderr.write('[legacy-cli] Prefer unified entry "node cli/agent.cjs run --file <workflow.cjs>" (enforces step postcondition verifiers, policy, and exclusive locks; set ABB_QUIET_LEGACY=1 to silence).\n');
  }
  if (parsed.scene || parsed.port) {
    sceneMod.applySceneToEnv({
      scene: parsed.scene || undefined,
      port: parsed.port || undefined,
    });
  }
  const cdp = require('../lib/cdp');

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
    console.error('Usage: node cli/run.cjs [--scene <name>] --code "<async js>" | --file <file.js> | --validate-learnings');
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
  process.exitCode = 1;
});
