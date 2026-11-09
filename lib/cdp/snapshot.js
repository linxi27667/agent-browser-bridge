// AgentBrowserBridge - 混合无障碍与可交互 DOM 快照引擎 (Hybrid AX + Cursor-Interactive Snapshot Engine)
// 融合 vercel-labs/agent-browser (snapshot.rs / diff.rs) 与 citrolabs/ego-lite (snapshot-result.ts)
// 核心特性：
// 1. 强制校验 guardExpression 上下文门禁
// 2. 提取 ARIA 语义树 + 自动补齐 cursor:pointer / onclick / tabindex / contenteditable 的非标准交互节点
// 3. 自动将隐藏 radio/checkbox (0x0 / opacity:0) 提升绑定到外层可见 <label> / 组件容器
// 4. 生成稳定的 @e1 引用（同时写入 DOM data-abb-ref 与 RefMap 的 role/name/nth/loc 回退元数据）
// 5. 支持 interactiveOnly / compact / maxDepth / selector 子树截取 / SnapshotResult.find() / diffSnapshots()

const {
  BROWSER_LOCATOR_HELPERS_JS,
  ensurePageRefMap,
} = require('./locator');

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
  'iframe',
]);

const CONTENT_ROLES = new Set([
  'heading',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'listitem',
  'article',
  'region',
  'main',
  'navigation',
  'img',
  'paragraph',
  'label',
]);

class SnapshotResult {
  constructor({ text, url = '', title = '', refs = [], nodes = [], truncated = false }) {
    this.text = String(text || '');
    this.url = String(url || '');
    this.title = String(title || '');
    this.refs = Array.isArray(refs) ? refs : [];
    this.nodes = Array.isArray(nodes) ? nodes : [];
    this.truncated = Boolean(truncated);
  }

  get tree() {
    return this.text;
  }

  toString() {
    return this.text;
  }

  /**
   * 在快照行中按子串或正则检索（复刻 ego-lite SnapshotResult.find）。
   */
  find(query, options = {}) {
    const context = Math.max(0, Number(options.context) || 0);
    const maxMatches = Math.max(1, Number(options.maxMatches) || 25);
    const lines = this.text.split(/\r?\n/);
    const matcher = query instanceof RegExp
      ? (line) => query.test(line)
      : (line) => line.toLowerCase().includes(String(query || '').toLowerCase());

    const hitIndices = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (matcher(lines[i])) {
        hitIndices.push(i);
        if (hitIndices.length >= maxMatches) break;
      }
    }
    if (hitIndices.length === 0) return '(no matches)';
    if (context === 0) {
      return hitIndices.map((idx) => lines[idx]).join('\n');
    }
    const included = new Set();
    for (const idx of hitIndices) {
      const start = Math.max(0, idx - context);
      const end = Math.min(lines.length - 1, idx + context);
      for (let k = start; k <= end; k += 1) included.add(k);
    }
    return [...included].sort((a, b) => a - b).map((idx) => lines[idx]).join('\n');
  }
}

function resolveGuardAndOptions(guardOrOptions, maybeOptions) {
  if (typeof guardOrOptions === 'string') {
    return {
      guardExpression: guardOrOptions,
      options: maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {},
    };
  }
  if (guardOrOptions && typeof guardOrOptions === 'object') {
    return {
      guardExpression: guardOrOptions.guardExpression || guardOrOptions.guard || '',
      options: guardOrOptions,
    };
  }
  return { guardExpression: '', options: {} };
}

/**
 * 构建在浏览器页面内执行的混合快照采集脚本：
 * - 遍历 DOM + Open Shadow DOM
 * - 识别标准 ARIA / HTML 语义角色
 * - 补齐 cursor:pointer / onclick / tabindex / contenteditable 的自定义交互元素（如 TDesign / ElementUI / 金蝶网格）
 * - 将隐藏的 radio/checkbox 提升绑定至外层可见 label 或组件容器
 */
function buildInPageSnapshotExpression(guardExpression, options = {}) {
  const cfg = {
    interactiveOnly: Boolean(options.interactiveOnly || options.interactive),
    compact: options.compact !== false,
    maxDepth: Number.isFinite(Number(options.maxDepth ?? options.depth))
      ? Number(options.maxDepth ?? options.depth)
      : 14,
    selector: typeof options.selector === 'string' && options.selector.trim() ? options.selector.trim() : '',
    startRefNum: Math.max(1, Number(options.startRefNum) || 1),
  };

  return `(() => {
    if (!(${guardExpression})) throw new Error("Context guard failed before snapshot");
    ${BROWSER_LOCATOR_HELPERS_JS}
    const cfg = ${JSON.stringify(cfg)};
    const INTERACTIVE = new Set(${JSON.stringify([...INTERACTIVE_ROLES])});
    const CONTENT = new Set(${JSON.stringify([...CONTENT_ROLES])});
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', ' SVG', 'PATH', 'DEFS', 'SYMBOL', 'TEMPLATE']);

    // 清理旧的 data-abb-ref 标记，避免跨次快照冲突
    for (const oldEl of __abbQueryAllOpenShadow('[data-abb-ref]')) {
      try { oldEl.removeAttribute('data-abb-ref'); } catch {}
    }

    let rootEl = document.body || document.documentElement;
    if (cfg.selector) {
      const found = __abbQueryAllOpenShadow(cfg.selector);
      if (!found.length) throw new Error("Snapshot root selector not found: " + cfg.selector);
      rootEl = found[0];
    }

    function isHiddenInputPromotable(el) {
      if (!el || el.tagName !== 'INPUT') return null;
      const type = String(el.type || '').toLowerCase();
      if (type !== 'radio' && type !== 'checkbox') return null;
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const isHiddenBox = r.width < 4 || r.height < 4 || style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none';
      if (!isHiddenBox) return null;
      const wrapper = el.closest('label, .t-checkbox, .t-radio, .el-checkbox, .el-radio, .ant-checkbox-wrapper, .ant-radio-wrapper');
      if (wrapper && __abbIsVisible(wrapper)) return wrapper;
      if (el.id) {
        const forLbl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']');
        if (forLbl && __abbIsVisible(forLbl)) return forLbl;
      }
      return null;
    }

    // 预先扫描被外层容器代理的隐藏 radio/checkbox
    const promotedMap = new Map();
    const skippedHiddenInputs = new Set();
    for (const inputEl of __abbQueryAllOpenShadow('input[type="radio"], input[type="checkbox"]')) {
      const wrapper = isHiddenInputPromotable(inputEl);
      if (wrapper && !promotedMap.has(wrapper)) {
        promotedMap.set(wrapper, inputEl);
        skippedHiddenInputs.add(inputEl);
      }
    }

    function detectRoleAndInteractive(el, elStyle, parentCursor) {
      if (promotedMap.has(el)) {
        const inputEl = promotedMap.get(el);
        const type = String(inputEl.type || 'checkbox').toLowerCase();
        return {
          role: type === 'radio' ? 'radio' : 'checkbox',
          interactive: true,
          checked: Boolean(inputEl.checked),
          disabled: __abbIsDisabled(inputEl) || __abbIsDisabled(el),
        };
      }
      let role = __abbImplicitRole(el);
      const tag = String(el.tagName || '').toUpperCase();
      if (!role) {
        if (tag === 'MAIN') role = 'main';
        else if (tag === 'NAV') role = 'navigation';
        else if (tag === 'HEADER') role = 'banner';
        else if (tag === 'FOOTER') role = 'contentinfo';
        else if (tag === 'SECTION' || tag === 'ARTICLE') role = 'region';
        else if (tag === 'UL' || tag === 'OL') role = 'list';
        else if (tag === 'TABLE') role = 'table';
        else if (tag === 'FORM') role = 'form';
        else if (tag === 'DIALOG') role = 'dialog';
        else if (tag === 'P') role = 'paragraph';
        else if (tag === 'LABEL') role = 'label';
      }

      let interactive = INTERACTIVE.has(role);
      if (!interactive) {
        const hasOnClick = el.hasAttribute?.('onclick') || typeof el.onclick === 'function';
        const tabIdx = el.getAttribute?.('tabindex');
        const hasTabIndex = tabIdx !== null && tabIdx !== '-1';
        const isEditable = el.getAttribute?.('contenteditable') === 'true';
        let hasPointer = false;
        if (!hasOnClick && !hasTabIndex && !isEditable && (tag === 'DIV' || tag === 'SPAN' || tag === 'LI' || tag === 'TD' || tag === 'A' || tag === 'LABEL')) {
          if (elStyle && elStyle.cursor === 'pointer') {
            if (parentCursor !== 'pointer' || /(?:btn|button|option|item|tab|menu|link|card|close|trigger)/i.test(String(el.className || ''))) {
              hasPointer = true;
            }
          }
        }
        if (hasOnClick || hasTabIndex || isEditable || hasPointer) {
          interactive = true;
          if (!role) role = isEditable ? 'textbox' : 'button';
        }
      }

      let checked = undefined;
      if (role === 'checkbox' || role === 'radio' || role === 'switch') {
        if ('checked' in el) checked = Boolean(el.checked);
        else if (el.getAttribute?.('aria-checked') === 'true' || /(?:is-checked|t-is-checked|ant-checkbox-checked|ant-radio-checked)/.test(String(el.className || ''))) checked = true;
        else if (el.getAttribute?.('aria-checked') === 'false') checked = false;
      }

      return {
        role: role || 'generic',
        interactive,
        checked,
        disabled: __abbIsDisabled(el),
      };
    }

    function buildStableLocHint(el, role, name) {
      const id = String(el.id || '').trim();
      if (id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
        try {
          if (document.querySelectorAll('#' + id).length === 1) return 'css:#' + id;
        } catch {}
      }
      const testId = el.getAttribute?.('data-testid') || el.getAttribute?.('data-test') || el.getAttribute?.('data-qa');
      if (testId) return 'css:[data-testid=' + JSON.stringify(testId) + ']';
      if (el.tagName === 'A') {
        const href = el.getAttribute?.('href');
        if (href && !href.startsWith('javascript:')) return 'href:' + href;
      }
      if (role && role !== 'generic' && name) {
        return 'role:' + role + '[name=' + JSON.stringify(name) + ']';
      }
      if (name && name.length <= 48) {
        return 'text=' + JSON.stringify(name);
      }
      return undefined;
    }

    let nextRef = cfg.startRefNum;
    const roleNameCounts = new Map();
    const refs = [];
    const lines = [];

    function getDirectText(el) {
      const parts = [];
      for (const child of el.childNodes || []) {
        if (child.nodeType === 3) {
          const t = __abbNormalizeText(child.nodeValue);
          if (t) parts.push(t);
        }
      }
      return parts.join(' ');
    }

    function walk(el, depth, parentCursor) {
      if (!el || el.nodeType !== 1) return;
      if (skippedHiddenInputs.has(el)) return;
      const tag = String(el.tagName || '').toUpperCase();
      if (SKIP_TAGS.has(tag)) return;
      if (el.hasAttribute?.('hidden') || el.hasAttribute?.('inert') || el.getAttribute?.('aria-hidden') === 'true') return;
      if (depth > cfg.maxDepth) return;

      const elStyle = window.getComputedStyle(el);
      if (!elStyle || elStyle.display === 'none') return;
      const curCursor = elStyle.cursor || '';
      const rect = el.getBoundingClientRect();
      const vis = elStyle.visibility !== 'hidden' && Number(elStyle.opacity) !== 0 && rect.width > 0 && rect.height > 0;
      const { role, interactive, checked, disabled } = detectRoleAndInteractive(el, elStyle, parentCursor);
      if (interactive && !vis) return;

      let name = '';
      if (interactive || CONTENT.has(role) || role === 'heading') {
        name = __abbAccessibleName(el);
      } else {
        name = getDirectText(el);
      }
      if (name.length > 120) name = name.slice(0, 117) + '...';

      let value = undefined;
      if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && 'value' in el) {
        const inputType = String(el.type || '').toLowerCase();
        if (inputType !== 'password' && inputType !== 'button' && inputType !== 'submit' && inputType !== 'checkbox' && inputType !== 'radio') {
          const v = __abbNormalizeText(el.value);
          if (v && v !== name) value = v.slice(0, 80);
        }
      }

      const shouldAssignRef = interactive && vis;
      let refId = undefined;
      let nth = undefined;
      if (shouldAssignRef) {
        refId = 'e' + (nextRef++);
        try { el.setAttribute('data-abb-ref', refId); } catch {}
        const rnKey = role + '::' + name;
        nth = roleNameCounts.get(rnKey) || 0;
        roleNameCounts.set(rnKey, nth + 1);
        const loc = buildStableLocHint(el, role, name);
        refs.push({
          refId,
          role,
          name,
          nth,
          loc,
          selector: '[data-abb-ref=' + JSON.stringify(refId) + ']',
          disabled,
          checked,
          value,
        });
      }

      const isMeaningfulContent = vis && (CONTENT.has(role) || Boolean(name));
      const shouldEmitLine = cfg.interactiveOnly
        ? shouldAssignRef
        : (shouldAssignRef || (isMeaningfulContent && (role !== 'generic' || Boolean(name))));

      let nextDepth = depth;
      if (shouldEmitLine) {
        const indent = '  '.repeat(cfg.interactiveOnly ? 0 : Math.min(depth, 10));
        let line = indent + '- ' + role;
        if (name) line += ' ' + JSON.stringify(name);
        if (tag && /^H[1-6]$/.test(tag)) line += ' [level=' + tag.slice(1) + ']';
        if (checked === true) line += ' [checked]';
        if (disabled) line += ' [disabled]';
        if (value !== undefined) line += ' [value=' + JSON.stringify(value) + ']';
        if (refId) line += ' [ref=' + refId + ']';
        lines.push(line);
        nextDepth = depth + 1;
      }

      // 若当前节点是叶子级交互控件（如 button / a / option），且名字已完整包含子文本，则不再重复展开纯文本子节点
      const skipChildrenForLeafInteractive = shouldAssignRef && (role === 'button' || role === 'link' || role === 'option' || role === 'radio' || role === 'checkbox' || role === 'tab' || role === 'menuitem') &&
        !el.querySelector?.('button, a[href], input, select, textarea, [role]');

      if (!skipChildrenForLeafInteractive) {
        const children = [];
        if (el.shadowRoot) children.push(...el.shadowRoot.children);
        children.push(...(el.children || []));
        for (const child of children) {
          walk(child, nextDepth, curCursor);
        }
      }
    }

    walk(rootEl, 0, '');

    // 对具有多于 1 个同名同角色的 ref 保留 nth，唯一时省去 nth
    for (const r of refs) {
      const rnKey = r.role + '::' + r.name;
      if ((roleNameCounts.get(rnKey) || 0) <= 1) {
        delete r.nth;
      }
    }

    return {
      url: String(location.href || ''),
      title: String(document.title || ''),
      lines,
      refs,
    };
  })()`;
}

/**
 * 尝试通过 CDP Accessibility.getFullAXTree 增补后端节点 backendNodeId 映射（若当前会话支持）。
 */
async function tryEnrichBackendNodesViaAxTree(cdp, refs) {
  if (!cdp || typeof cdp.send !== 'function' || !Array.isArray(refs) || refs.length === 0) {
    return;
  }
  try {
    const tree = await cdp.send('Accessibility.getFullAXTree', {});
    if (!tree || !Array.isArray(tree.nodes)) return;
    const byKey = new Map();
    for (const node of tree.nodes) {
      if (node.ignored || !node.backendDOMNodeId) continue;
      const role = String(node.role?.value || '').trim().toLowerCase();
      const name = String(node.name?.value || '').replace(/\s+/g, ' ').trim();
      if (!role) continue;
      const key = `${role}::${name}`;
      const list = byKey.get(key) || [];
      list.push(node.backendDOMNodeId);
      byKey.set(key, list);
    }
    const usedIdx = new Map();
    for (const ref of refs) {
      const key = `${ref.role}::${ref.name}`;
      const list = byKey.get(key);
      if (!list || !list.length) continue;
      const idx = usedIdx.get(key) || 0;
      if (idx < list.length) {
        ref.backendNodeId = list[idx];
        usedIdx.set(key, idx + 1);
      }
    }
  } catch {
    // 轻量连接或测试桩不支持 Accessibility 域时静默跳过，依赖 DOM + RefMap 回退
  }
}

/**
 * 生成当前页面混合语义快照，并将 @e1, @e2... 注册到 cdp 关联的 RefMap 中。
 * @param {object} cdp - connectTarget / withDedicatedTab 返回的页面客户端
 * @param {string|object} guardOrOptions - 上下文门禁表达式（必填）或包含 guardExpression 的配置对象
 * @param {object} [maybeOptions] - { interactiveOnly, compact, maxDepth, selector, maxResultLength, enrichAx }
 * @returns {Promise<SnapshotResult>}
 */
async function snapshot(cdp, guardOrOptions, maybeOptions = {}) {
  const { guardExpression, options } = resolveGuardAndOptions(guardOrOptions, maybeOptions);
  if (typeof guardExpression !== 'string' || !guardExpression.trim()) {
    throw new Error('Snapshot requires context guard');
  }
  if (!await cdp.evalChecked(guardExpression)) {
    throw new Error('Context guard failed before snapshot');
  }

  const refMap = ensurePageRefMap(cdp);
  if (options.resetRefs !== false) {
    refMap.clear();
    refMap.nextRefNum = 1;
  }

  const raw = await cdp.evalChecked(buildInPageSnapshotExpression(guardExpression, {
    ...options,
    startRefNum: refMap.nextRefNum,
  }));

  if (!raw || !Array.isArray(raw.lines)) {
    throw new Error('Snapshot evaluation returned invalid payload');
  }

  if (options.enrichAx) {
    await tryEnrichBackendNodesViaAxTree(cdp, raw.refs);
  }
  const { emitHudNonBlocking } = require('./hud');
  emitHudNonBlocking(cdp, {
    badge: cdp.ownerTag || '语义快照',
    tone: 'info',
    text: `已采集页面快照 (${(raw.refs || []).length} 个交互控件)`,
    durationMs: 1800,
  });

  for (const r of raw.refs || []) {
    refMap.add(r.refId, r.backendNodeId, r.role, r.name, r.nth, {
      loc: r.loc,
      selector: r.selector,
    });
    const num = Number(String(r.refId).replace(/^e/, '')) || 0;
    if (num >= refMap.nextRefNum) {
      refMap.nextRefNum = num + 1;
    }
  }

  const header = `[Page] ${raw.title ? JSON.stringify(raw.title) + ' ' : ''}(${raw.url || 'about:blank'})`;
  const body = raw.lines.length > 0 ? raw.lines.join('\n') : '(empty snapshot)';
  let fullText = `${header}\n${body}`;
  let truncated = false;

  const maxLen = Number(options.maxResultLength) || 0;
  if (maxLen > 0 && fullText.length > maxLen) {
    fullText = `${fullText.slice(0, maxLen)}\n... [truncated ${fullText.length - maxLen} chars]`;
    truncated = true;
  }

  return new SnapshotResult({
    text: fullText,
    url: raw.url,
    title: raw.title,
    refs: raw.refs || [],
    nodes: raw.lines,
    truncated,
  });
}

/**
 * 直接返回快照纯文本（适合直接返回给大模型或 CLI 打印）。
 */
async function snapshotText(cdp, guardOrOptions, maybeOptions = {}) {
  const res = await snapshot(cdp, guardOrOptions, maybeOptions);
  return res.text;
}

/**
 * 对比两次快照文本的行级差异（复刻 vercel-labs/agent-browser diff.rs 的 LCS 增量快照对比）。
 * 在点击或填写表单后调用，仅向模型展示新增/移除/变更的状态行，大幅降低 Token 消耗。
 */
function diffSnapshots(beforeInput, afterInput) {
  const beforeStr = typeof beforeInput === 'string' ? beforeInput : String(beforeInput?.text || '');
  const afterStr = typeof afterInput === 'string' ? afterInput : String(afterInput?.text || '');
  if (beforeStr === afterStr) {
    const lineCount = beforeStr ? beforeStr.split(/\r?\n/).length : 0;
    return {
      changed: false,
      identical: true,
      additions: 0,
      removals: 0,
      unchanged: lineCount,
      diff: '(no changes)',
    };
  }

  const beforeLines = beforeStr ? beforeStr.split(/\r?\n/) : [];
  const afterLines = afterStr ? afterStr.split(/\r?\n/) : [];
  const m = beforeLines.length;
  const n = afterLines.length;

  // LCS 动态规划表
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const ops = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
      ops.push({ type: ' ', line: beforeLines[i - 1] });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: '+', line: afterLines[j - 1] });
      j -= 1;
    } else {
      ops.push({ type: '-', line: beforeLines[i - 1] });
      i -= 1;
    }
  }
  ops.reverse();

  let additions = 0;
  let removals = 0;
  let unchanged = 0;
  const diffLines = [];
  for (const op of ops) {
    if (op.type === '+') {
      additions += 1;
      diffLines.push(`+ ${op.line}`);
    } else if (op.type === '-') {
      removals += 1;
      diffLines.push(`- ${op.line}`);
    } else {
      unchanged += 1;
    }
  }

  return {
    changed: additions > 0 || removals > 0,
    identical: additions === 0 && removals === 0,
    additions,
    removals,
    unchanged,
    diff: diffLines.join('\n'),
  };
}

module.exports = {
  INTERACTIVE_ROLES,
  CONTENT_ROLES,
  SnapshotResult,
  snapshot,
  snapshotText,
  diffSnapshots,
};
