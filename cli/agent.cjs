#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createAutomation, routeTask, doctor, runWorkflow, exclusiveLock, loadLocalConfig } = require('../lib/automation');
const { fail, normalizeOptions, serializeError } = require('../lib/automation/errors');

const HELP = `Agent Browser Bridge task entry (trusted local code, not a sandbox)

node cli/agent.cjs doctor
node cli/agent.cjs route --url https://example.com
node cli/agent.cjs desktop snapshot --app explorer.exe
node cli/agent.cjs run --file trusted-workflow.cjs

Task options: --write, --mode cooperative|exclusive, --timeout-ms N,
              --binary ABSOLUTE_PATH, --expected-version VERSION, --config PATH,
              --target-window WINDOW_ID (coordinate input target preflight)
Default: read-only, cooperative. Physical input and shared-resource changes
need exclusive mode. Text for desktop type/set-value/clipboard-set uses --stdin.
run --file executes trusted CommonJS exporting async ({desktop,browser,step}) => ...
step(name, action, verify) requires verify to return true to report verified.
No automatic retry. Exit 0: success/verified; 1: failure; 2: unverified workflow.
`;

function parse(argv) {
  const options = {};
  const rest = [];
  const values = { '--mode': 'mode', '--timeout-ms': 'timeoutMs', '--binary': 'binaryPath', '--expected-version': 'expectedVersion', '--config': 'configPath', '--target-window': 'windowId' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') {
      if (options.readOnly !== undefined) throw fail('INVALID_ARGS', 'Repeated task option');
      options.readOnly = false;
    }
    else if (values[arg]) {
      if (options[values[arg]] !== undefined) throw fail('INVALID_ARGS', 'Repeated task option');
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw fail('INVALID_ARGS', `Missing value for ${arg}`);
      options[values[arg]] = arg === '--timeout-ms' ? Number(value) : value;
    } else rest.push(arg);
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

async function main(argv, signal) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
    process.stdout.write(HELP);
    return;
  }
  const parsed = parse(argv);
  const loaded = loadLocalConfig(parsed.options);
  const options = normalizeOptions({ ...loaded.options, configInfo: loaded.config, signal });
  const rest = parsed.rest;
  const [command, ...args] = rest;
  let data;
  if (command === 'doctor') {
    if (args.length) throw fail('INVALID_ARGS', 'doctor takes no positional arguments');
    data = await doctor(options);
  } else if (command === 'route') {
    const values = pairs(args.filter(a => !['--api', '--visual'].includes(a)), ['--url', '--app', '--file']);
    data = routeTask({ url: values['--url'], app: values['--app'], file: values['--file'], api: args.includes('--api'), visual: args.includes('--visual') });
  } else if (command === 'desktop') {
    if (!args.length) throw fail('INVALID_ARGS', 'desktop requires a command');
    const input = args.includes('--stdin') ? await stdinText() : undefined;
    data = await exclusiveLock(options, (_assertHeld, leaseSignal) => createAutomation({ ...options, signal: leaseSignal }).desktop.adRaw(args, { input, windowId: options.windowId }));
  } else if (command === 'run') {
    const values = pairs(args, ['--file']);
    if (!values['--file']) throw fail('INVALID_ARGS', 'run requires --file');
    const filename = path.resolve(values['--file']);
    if (!fs.statSync(filename).isFile()) throw fail('INVALID_ARGS', 'Workflow path must be a file');
    data = await runWorkflow(require(filename), options);
    if (data.status === 'unverified') process.exitCode = 2;
  } else throw fail('INVALID_ARGS', 'Unknown command; run help for supported commands');
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
