// AgentBrowserBridge - 页面级 CDP 操作
// 页面导航、文本读取与截图辅助函数。产物默认落到 artifacts/，可通过 BROWSER_BRIDGE_ARTIFACTS 覆盖。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { sleep } = require('./client');

// 默认产物目录：优先环境变量，其次项目 artifacts/，再次系统临时目录。
function artifactsDir() {
  if (process.env.BROWSER_BRIDGE_ARTIFACTS) return process.env.BROWSER_BRIDGE_ARTIFACTS;
  const projectDir = path.resolve(__dirname, '..', '..', 'artifacts');
  try {
    fs.mkdirSync(projectDir, { recursive: true });
    return projectDir;
  } catch {
    return os.tmpdir();
  }
}

function formatTimestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// 把任意字符串清洗为安全的文件名片段。
function sanitizeSegment(value) {
  return String(value || 'capture')
    .replace(/[\\/:*?"<>|#\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'capture';
}

// 导航到 url 并固定等待。注意：固定等待是兜底，复杂页面应改用事件/轮询等待具体元素。
async function navigateAndWait(cdp, url, waitMs = 8000) {
  await cdp.send('Page.navigate', { url });
  await sleep(waitMs);
}

// 取页面标题、URL 和正文文本（截断到 limit 字符，避免无界塞入上下文）。
async function evaluatePageText(cdp, limit = 15000) {
  const result = await cdp.eval(`(() => ({
    title: document.title,
    url: location.href,
    text: document.body ? document.body.innerText.substring(0, ${limit}) : ''
  }))()`);
  return result.result.value;
}

// 截图并落盘，返回文件路径（不把图片塞入 AI 上下文，由调用方决定是否读取）。
async function saveScreenshot(cdp, prefix = 'shot', { fullPage = false, dir = artifactsDir() } = {}) {
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
  const outputPath = path.join(dir, `${sanitizeSegment(prefix)}-${formatTimestamp()}.png`);
  fs.writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'));
  return outputPath;
}

module.exports = {
  artifactsDir,
  formatTimestamp,
  sanitizeSegment,
  navigateAndWait,
  evaluatePageText,
  saveScreenshot,
};
