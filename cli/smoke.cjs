#!/usr/bin/env node
// Isolated about:blank fixture only; never reads or submits a business website.
const assert = require('node:assert/strict');
const cdp = require('../lib/cdp');
(async () => {
  await cdp.identity.verify();
  const browser = cdp.connectBrowser();
  let target, page;
  try {
    target = await browser.send('Target.createTarget', { url: 'about:blank', background: true });
    const targets = await cdp.listTargets(browser);
    const fixture = cdp.requireTarget(targets, { id: target.targetId });
    page = await cdp.attachTarget(browser, fixture.id);
    await page.send('Page.enable');
    const tree = await page.send('Page.getFrameTree');
    await page.send('Page.setDocumentContent', { frameId: tree.frameTree.frame.id, html: '<title>AgentBrowserBridge-isolated-smoke</title><input id="value"><button id="submit">Save</button><output id="result"></output><script>document.querySelector("#submit").onclick=()=>document.querySelector("#result").textContent=document.querySelector("#value").value;</script>' });
    const guard = 'location.href === "about:blank" && document.title === "AgentBrowserBridge-isolated-smoke"';
    const text = '浏览器验收 "quote" 2026-10-12';
    await cdp.fillNative(page, '#value', text, guard);
    await page.evalChecked('document.querySelector("#submit").click()');
    assert.equal(await page.evalChecked('document.querySelector("#result").textContent'), text);
    await assert.rejects(page.evalChecked('throw new Error("fixture error")'), /evaluation failed/);
    await assert.rejects(cdp.fillNative(page, '#value', 'wrong', 'false'), /guard/);
    console.log(JSON.stringify({ ok: true, version: cdp.version, fixture: 'isolated about:blank', checks: ['exact-target', 'native-Chinese-input', 'fixture-submit-readback', 'page-exception-rejected', 'wrong-context-rejected'], businessWrites: 0 }));
  } finally {
    if (page) page.close();
    if (target) await browser.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
    browser.close();
  }
})().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
