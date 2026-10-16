// AgentBrowserBridge - CDP target（页面/标签）发现工具
// 选择页面时必须提供明确且唯一的目标条件。

const { getJson, strictInstance } = require('./client');

// 列出当前 Chrome 所有可调试 target（页面、worker 等）。
// 严格模式下先做实例身份校验（G1），失败直接抛错。
async function listTargets() {
  // getJson performs the strict identity check; avoid a second process query.
  return getJson('/json/list');
}

// 找到第一个满足谓词的页面 target；不传谓词则返回第一个页面。
function findFirstPage(targets, predicate = null) {
  return targets.find((item) => item.type === 'page' && (!predicate || predicate(item)));
}

// 按 URL 子串 / 精确 URL / 标题关键词查找页面。
// 优先级：精确 url > url 子串 > 标题关键词。
function findPageByUrl(targets, { exactUrl = '', urlIncludes = '', titleIncludes = '' } = {}) {
  if (exactUrl) {
    const exact = findFirstPage(targets, (item) => item.url === exactUrl);
    if (exact) return exact;
  }
  if (urlIncludes) {
    const bySub = findFirstPage(targets, (item) => item.url && item.url.includes(urlIncludes));
    if (bySub) return bySub;
  }
  if (titleIncludes) {
    return findFirstPage(
      targets,
      (item) => (item.title && item.title.includes(titleIncludes))
    );
  }
  return null;
}

module.exports = { listTargets, findFirstPage, findPageByUrl };
