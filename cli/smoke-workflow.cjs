#!/usr/bin/env node
// Real CDP -> local file -> native UIA verification. Never targets business data.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { loadLocalConfig } = require('../lib/automation/config');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function descendants(node) {
  if (!node) return [];
  return [node, ...(node.children || []).flatMap(descendants)];
}

async function awaitReady(filename, child, errors) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Native fixture exited: ' + errors());
    try { return JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await wait(100);
  }
  throw new Error('Native fixture did not become ready: ' + errors());
}

async function main() {
  if (process.platform !== 'win32') throw new Error('The native smoke fixture requires Windows');
  const loaded = loadLocalConfig();
  const cdp = require('../lib/cdp');
  const { runWorkflow } = require('../lib/automation');
  const artifactRoot = path.resolve(__dirname, '..', 'artifacts', 'workflow-smoke');
  await fs.mkdir(artifactRoot, { recursive: true });
  const runDir = await fs.mkdtemp(path.join(artifactRoot, 'run-'));
  const readyPath = path.join(runDir, 'ready.json');
  const stopPath = path.join(runDir, 'stop');
  const filePath = path.join(runDir, 'verified-result.json');
  const title = 'AgentBrowserBridge-workflow-' + crypto.randomUUID();
  let stderr = '';
  let fixture;
  let browser;
  let setupPage;
  let targetId;
  let report;
  try {
    // This test is pinned to the configured dedicated browser; it never starts one.
    const config = cdp.resolveConfig();
    assert.ok(config.strict && config.profile && config.browser && config.proxy, 'Strict browser identity is required');
    await cdp.identity.verify();
    browser = await cdp.connectBrowser();
    ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank', background: true }));
    setupPage = await cdp.attachTarget(browser, targetId);
    await setupPage.send('Page.enable');
    const frame = await setupPage.send('Page.getFrameTree');
    await setupPage.send('Page.setDocumentContent', {
      frameId: frame.frameTree.frame.id,
      html: '<title>' + title + '</title><input id="value"><button id="copy">Copy result</button><output id="result"></output><script>document.querySelector("#copy").onclick=()=>document.querySelector("#result").textContent=document.querySelector("#value").value;</script>',
    });
    setupPage.close();
    setupPage = null;
    fixture = spawn(process.env.BROWSER_BRIDGE_PWSH || 'pwsh', [
      '-NoProfile', '-STA', '-File', path.resolve(__dirname, '..', 'scripts', 'Show-WorkflowSmokeDialog.ps1'),
      '-ReadyPath', readyPath, '-StopPath', stopPath, '-WindowTitle', title,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let fixtureError;
    fixture.on('error', error => { fixtureError = error; });
    fixture.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const ready = await awaitReady(readyPath, fixture, () => fixtureError?.message || stderr);
    const expected = '跨工具验收：数量37 / quote " / $ & Unicode';
    const guard = 'location.href === "about:blank" && document.title === ' + JSON.stringify(title);
    let browserText;
    let nativeRef;
    let nativeReadback;
    report = await runWorkflow(async ({ browser: web, desktop, step }) => {
      browserText = await step('browser semantic write and readback', () => web.withLeasedTarget({ id: targetId }, async page => {
        await page.fillNative('#value', expected, guard);
        await page.clickNative('#copy', guard);
        return page.readUnique('#result', guard);
      }), value => value === expected);
      await step('file output and independent readback', async () => {
        await fs.writeFile(filePath, JSON.stringify({ text: browserText, quantity: 37 }), { encoding: 'utf8', flag: 'wx' });
      }, async () => {
        const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return value.text === expected && value.quantity === 37;
      });
      await step('native window scoped observation', async () => {
        const snapshot = await desktop.adSnapshot(undefined, { windowId: ready.windowId, timeoutMs: 15000 });
        const matches = descendants(snapshot.tree).filter(node => node.name === 'Workflow Result' && node.ref_id);
        assert.equal(matches.length, 1, 'The native textbox must be uniquely addressable');
        nativeRef = matches[0].ref_id;
        return snapshot;
      }, snapshot => snapshot.complete === true && Boolean(nativeRef));
      await step('native semantic write and readback', () => desktop.adSetValue(nativeRef, browserText), async () => {
        nativeReadback = await desktop.adGet(nativeRef, 'value');
        return nativeReadback === expected;
      });
    }, { ...loaded.options, readOnly: false, mode: 'cooperative', timeoutMs: 20000 });
    assert.equal(report.status, 'verified');
    report = { ...report, fixture: 'about:blank and own non-activating WinForms window', mode: 'cooperative', physicalInputCommands: 0, browserText, nativeReadback, file: filePath, config: loaded.config.path };
    await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, report: path.join(runDir, 'report.json'), data: report }));
  } catch (error) {
    await fs.writeFile(path.join(runDir, 'failure.json'), JSON.stringify({ code: error.code, message: error.message, report: error.report }, null, 2), 'utf8');
    throw error;
  } finally {
    if (setupPage) setupPage.close();
    if (browser) {
      // targetId belongs to this fresh scratch tab; existing tabs are untouched.
      if (targetId) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
      browser.close();
    }
    if (fixture && fixture.exitCode === null) {
      await fs.writeFile(stopPath, 'stop', 'utf8');
      await Promise.race([once(fixture, 'exit'), wait(4000)]);
      if (fixture.exitCode === null) fixture.kill();
    }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error.code || 'SMOKE_FAILED', message: error.message, report: error.report }));
  process.exitCode = 1;
});
