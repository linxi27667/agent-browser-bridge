#!/usr/bin/env node
const cdp = require('../lib/cdp');

(async () => {
  await cdp.identity.verify();
  const wsUrl = cdp.resolveBrowserWsUrl();
  const bridge = cdp.connectBrowser();
  let created;
  try {
    const version = await bridge.send('Browser.getVersion');
    if (!/Edg\//i.test(version.product || '')) throw new Error('桥接未确认到 Edge: ' + (version.product || ''));
    created = await bridge.send('Target.createTarget', { url: 'about:blank', background: true });
    const page = await cdp.attachTarget(bridge, created.targetId);
    await page.send('Page.enable');
    const tree = await page.send('Page.getFrameTree');
    await page.send('Page.setDocumentContent', {
      frameId: tree.frameTree.frame.id,
      html: '<title>combined-bridge</title>'
    });
    const bridgeTitle = await page.evalChecked('document.title');
    page.close();

    const attached = await require('../lib/playwright/attachExisting').attachExistingPlaywright();
    const pwPage = await attached.newIsolatedPage('about:blank');
    await pwPage.setContent('<title>combined-playwright</title>');
    const playwrightTitle = await pwPage.title();
    await pwPage.close();
    attached.disconnect();

    console.log(JSON.stringify({
      ok: true,
      bridge: { product: version.product, title: bridgeTitle },
      playwright: { title: playwrightTitle },
      sharedEndpoint: wsUrl.replace(/[0-9a-f-]{8,}$/i, '<browser-id>'),
      note: 'Official chrome-devtools-mcp still uses HTTP /json on default Edge and is not required for this check.',
      businessWrites: 0
    }));
    process.exit(0);
  } finally {
    if (created) await bridge.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
    bridge.close();
  }
})().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
