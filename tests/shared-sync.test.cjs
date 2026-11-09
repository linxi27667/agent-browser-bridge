// 两仓共享文件一致性：本仓里的共享文件必须与 shared-files.json 记录的指纹一致。
// 失败说明只改了一边。修法：在 AgentBrowserBridge-CrossBrowser 修改后运行 node scripts/sync-shared.cjs。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const manifestPath = path.join(ROOT, 'shared-files.json');

test('shared files match the cross-repo fingerprint manifest', () => {
  assert.ok(fs.existsSync(manifestPath), 'shared-files.json missing; run scripts/sync-shared.cjs in AgentBrowserBridge-CrossBrowser');
  const { files } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const drift = [];
  for (const [rel, expected] of Object.entries(files)) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { drift.push(rel + ' (missing)'); continue; }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    if (actual !== expected) drift.push(rel);
  }
  assert.deepEqual(drift, [], 'shared files drifted from the other repo: ' + drift.join(', ') + ' — edit in AgentBrowserBridge-CrossBrowser and run node scripts/sync-shared.cjs');
});
