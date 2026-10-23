const { resolveBrowserWsUrl } = require('../cdp/client');

async function attachExistingPlaywright() {
  let playwright;
  try {
    playwright = require('playwright-core');
  } catch {
    throw new Error('缺少 playwright-core。请先执行 npm i -D playwright-core');
  }
  const wsUrl = resolveBrowserWsUrl();
  const browser = await playwright.chromium.connectOverCDP(wsUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error('Playwright 未拿到已有浏览器上下文');
  return {
    browser,
    context,
    wsUrl,
    async newIsolatedPage(url = 'about:blank') {
      const page = await context.newPage();
      await page.goto(url);
      return page;
    },
    disconnect() {
      // Never call browser.close(): it can quit the user's daily Edge.
      const connection = browser._connection;
      if (connection && typeof connection.close === 'function') connection.close();
    }
  };
}

module.exports = { attachExistingPlaywright };
