#!/usr/bin/env node
// Isolated about:blank fixture only; never reads or submits a business website.
const assert = require('node:assert/strict');
const cdp = require('../lib/cdp');
(async () => {
  await cdp.identity.verify();
  const browser = await cdp.connectBrowser();
  let target, page;
  try {
    target = await browser.send('Target.createTarget', { url: 'about:blank', background: true });
    const targets = await cdp.listTargets(browser);
    const fixture = cdp.requireTarget(targets, { id: target.targetId });
    page = await cdp.attachTarget(browser, fixture.id);
    await page.send('Page.enable');
    const tree = await page.send('Page.getFrameTree');
    await page.send('Page.setDocumentContent', { frameId: tree.frameTree.frame.id, html: '<title>AgentBrowserBridge-isolated-smoke</title><input id="value"><button id="submit">Save</button><button id="alt">Alt</button><output id="result"></output><script>document.querySelector("#submit").onclick=()=>document.querySelector("#result").textContent=document.querySelector("#value").value;document.querySelector("#alt").onclick=()=>document.querySelector("#result").textContent="alt-ok";</script>' });
    const guard = 'location.href === "about:blank" && document.title === "AgentBrowserBridge-isolated-smoke"';
    const text = '浏览器验收 "quote" 2026-10-12';
    await cdp.waitForSelector(page, '#value', guard);
    await cdp.fillNative(page, '#value', text, guard);
    await cdp.clickNative(page, '#submit', guard);
    assert.equal(await cdp.readUnique(page, '#result', guard), text);
    await cdp.clickByBox(page, '#alt', guard);
    assert.equal(await cdp.readUnique(page, '#result', guard), 'alt-ok');
    await page.send('Page.setDocumentContent', { frameId: tree.frameTree.frame.id, html: '<title>AgentBrowserBridge-isolated-smoke</title><div id="captcha-box" style="width:120px;height:48px;background:#111;color:#fff;font:24px/48px monospace;text-align:center">A7</div><input id="captcha"><button id="login">Login</button><p id="ready" style="display:none;width:80px;height:24px">ok</p><script>document.querySelector("#login").onclick=()=>{if(document.querySelector("#captcha").value==="A7"){document.querySelector("#captcha-box").remove();document.querySelector("#login").remove();document.querySelector("#captcha").remove();const r=document.querySelector("#ready");r.style.display="block";}}</script>' });
    const auth = { guardExpression: guard, captchaSelector: '#captcha-box', readySelector: '#ready' };
    const blocked = await cdp.inspectAuth(page, auth);
    assert.equal(blocked.captchaVisible, true);
    assert.equal(blocked.ready, false);
    const shot = await cdp.captureUniquePng(page, '#captcha-box', guard);
    assert.ok(shot.png[0] === 0x89 && shot.png[1] === 0x50);
    await assert.rejects(cdp.waitForUserAuth(page, { ...auth, timeoutMs: 40, intervalMs: 10, onWait: () => {} }), /timed out/);
    await cdp.fillNative(page, '#captcha', 'A7', guard);
    await cdp.clickNative(page, '#login', guard);
    const ready = await cdp.waitForUserAuth(page, { ...auth, timeoutMs: 3000, intervalMs: 50, onWait: () => {} });
    assert.equal(ready.ready, true);
    assert.equal(ready.blocked, false);
    await assert.rejects(page.evalChecked('throw new Error("fixture error")'), /evaluation failed/);
    await assert.rejects(cdp.fillNative(page, '#value', 'wrong', 'false'), /guard/);
    console.log(JSON.stringify({ ok: true, version: cdp.version, fixture: 'isolated about:blank', checks: ['exact-target', 'selector-wait', 'native-Chinese-input', 'native-click-readback', 'box-click-readback', 'captcha-image-capture', 'user-auth-wait', 'page-exception-rejected', 'wrong-context-rejected'], businessWrites: 0 }));
  } finally {
    if (page) page.close();
    if (target) await browser.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
    browser.close();
  }
})().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
