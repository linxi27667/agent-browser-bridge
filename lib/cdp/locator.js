// AgentBrowserBridge - 统一语义定位器与可交互性引擎 (Locator & Actionability Engine)
// 融合 citrolabs/ego-lite (element-resolver.ts / action-target.ts) 与 vercel-labs/agent-browser (element.rs)
// 支持：@e1 / @1 快照引用、role:button[name="..."]、text="..."、:has-text()、:text-is()、
// loc=href:...、xpath=...、>> nth=N、Open Shadow DOM 穿透、遮挡检测 (Hit-Test) 与候选诊断。

class ElementResolutionError extends Error {
  constructor(message, kind = 'transient', code = 'CDP_ELEMENT_NOT_FOUND', diagnostics = undefined) {
    super(message);
    this.name = 'ElementResolutionError';
    this.kind = kind; // 'transient' (可等待/重试) | 'permanent' (选择器歧义或语法错误，不可盲目重试)
    this.code = code;
    if (diagnostics) this.diagnostics = diagnostics;
  }
}

class RefMap {
  constructor({ allowFallback = true } = {}) {
    this.map = new Map();
    this.documents = new Map();
    this.allowFallback = allowFallback;
    this.nextRefNum = 1;
  }

  normalizeRefKey(refId) {
    const parsed = parseRef(refId);
    return parsed || String(refId || '').trim();
  }

  add(refId, backendNodeId, role, name, nth = undefined, extra = {}) {
    return this.addWithFrame(refId, backendNodeId, role, name, nth, undefined, extra);
  }

  addWithFrame(refId, backendNodeId, role, name, nth = undefined, frameId = undefined, extra = {}) {
    const key = this.normalizeRefKey(refId);
    const numKey = key.startsWith('e') ? key.slice(1) : key;
    const entry = {
      refId: key.startsWith('e') ? key : `e${key}`,
      backendNodeId: backendNodeId ?? undefined,
      role: String(role || ''),
      name: String(name || ''),
      nth: nth ?? undefined,
      frameId: frameId ?? undefined,
      loc: extra.loc ?? undefined,
      selector: extra.selector ?? undefined,
      allowFallback: extra.allowFallback !== false,
    };
    this.map.set(entry.refId, entry);
    if (numKey && /^\d+$/.test(numKey)) {
      this.map.set(numKey, entry);
    }
    return entry;
  }

  get(refId) {
    const key = this.normalizeRefKey(refId);
    if (!key) return undefined;
    return this.map.get(key) || (key.startsWith('e') ? this.map.get(key.slice(1)) : this.map.get(`e${key}`));
  }

  clear() {
    this.map.clear();
  }

  observeDocument(sessionKey = 'main', loaderId = '') {
    if (!loaderId) {
      this.documents.delete(sessionKey);
      return false;
    }
    const prev = this.documents.get(sessionKey);
    if (!prev || prev.loaderId !== loaderId) {
      this.documents.set(sessionKey, { loaderId, refsByBackendId: new Map() });
    }
    return true;
  }

  durableRef(sessionKey = 'main', backendNodeId) {
    const doc = this.documents.get(sessionKey);
    if (!doc || backendNodeId === undefined || backendNodeId === null) return undefined;
    return doc.refsByBackendId.get(backendNodeId);
  }

  rememberDurableRef(sessionKey = 'main', backendNodeId, refId) {
    const doc = this.documents.get(sessionKey);
    if (doc && backendNodeId !== undefined && backendNodeId !== null) {
      doc.refsByBackendId.set(backendNodeId, refId);
    }
  }

  allocateRef(sessionKey = 'main', backendNodeId = undefined, documentIsKnown = false) {
    if (documentIsKnown && backendNodeId !== undefined && backendNodeId !== null) {
      const existing = this.durableRef(sessionKey, backendNodeId);
      if (existing) return existing;
      const allocated = `e${this.nextRefNum++}`;
      this.rememberDurableRef(sessionKey, backendNodeId, allocated);
      return allocated;
    }
    return `e${this.nextRefNum++}`;
  }

  entriesSorted() {
    const seen = new Set();
    const out = [];
    for (const entry of this.map.values()) {
      if (seen.has(entry.refId)) continue;
      seen.add(entry.refId);
      out.push(entry);
    }
    out.sort((a, b) => {
      const na = Number(String(a.refId).replace(/^e/, '')) || 0;
      const nb = Number(String(b.refId).replace(/^e/, '')) || 0;
      return na - nb;
    });
    return out;
  }
}

function ensurePageRefMap(cdp) {
  if (!cdp) return new RefMap();
  if (!cdp._refMap || !(cdp._refMap instanceof RefMap)) {
    cdp._refMap = new RefMap();
  }
  return cdp._refMap;
}

/**
 * 解析快照引用：支持 @e1、@1、ref=e1、ref=1、e1（注意避免把普通标签如 em/embed 误判为 ref）。
 */
function parseRef(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('@')) {
    const body = trimmed.slice(1).trim();
    if (/^e?\d+$/.test(body)) return body.startsWith('e') ? body : `e${body}`;
  }
  if (trimmed.startsWith('ref=')) {
    const body = trimmed.slice(4).trim();
    if (/^e?\d+$/.test(body)) return body.startsWith('e') ? body : `e${body}`;
  }
  if (/^e\d+$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function normalizeRole(role) {
  const r = String(role || '').trim();
  if (r === 'IframePresentational') return 'Iframe';
  return r.toLowerCase();
}

function unquoteLocatorString(raw) {
  const s = String(raw || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const quote = s[0];
    const inner = s.slice(1, -1);
    return inner.replace(new RegExp('\\\\([' + quote + '\\\\])', 'g'), '$1');
  }
  return s;
}

function topLevelTokenPositions(value, token) {
  const positions = [];
  let quote;
  let escaped = false;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') { bracketDepth += 1; continue; }
    if (ch === ']') { bracketDepth = Math.max(0, bracketDepth - 1); continue; }
    if (ch === '(') { parenDepth += 1; continue; }
    if (ch === ')') { parenDepth = Math.max(0, parenDepth - 1); continue; }
    if (bracketDepth === 0 && parenDepth === 0 && value.startsWith(token, i)) {
      positions.push(i);
    }
  }
  return positions;
}

function parseTerminalNth(value) {
  const separators = topLevelTokenPositions(value, '>>');
  if (separators.length === 0) return undefined;
  if (separators.length !== 1) return { valid: false };
  const pos = separators[0];
  const base = value.slice(0, pos).trim();
  const tail = value.slice(pos + 2).trim();
  const match = /^nth=(-?\d+)$/.exec(tail);
  if (!base || !match) return { valid: false };
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index < -1) return { valid: false };
  return { valid: true, base, index };
}

function parseTerminalCssText(selector) {
  const pseudos = [
    { token: ':has-text(', mode: 'substring' },
    { token: ':text-is(', mode: 'exact' },
  ];
  let quote;
  let escaped = false;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[') { bracketDepth += 1; continue; }
    if (ch === ']') { bracketDepth = Math.max(0, bracketDepth - 1); continue; }
    if (ch === '(') { parenDepth += 1; continue; }
    if (ch === ')') { parenDepth = Math.max(0, parenDepth - 1); continue; }
    if (bracketDepth !== 0 || parenDepth !== 0) continue;

    const pseudo = pseudos.find(({ token }) => selector.startsWith(token, i));
    if (!pseudo) continue;
    const open = i + pseudo.token.length - 1;
    // find matching close paren
    let pQuote;
    let pEsc = false;
    let depth = 0;
    let close = -1;
    for (let j = open; j < selector.length; j += 1) {
      const c = selector[j];
      if (pQuote) {
        if (pEsc) pEsc = false;
        else if (c === '\\') pEsc = true;
        else if (c === pQuote) pQuote = undefined;
        continue;
      }
      if (c === '"' || c === "'") { pQuote = c; continue; }
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) { close = j; break; }
      }
    }
    if (close === -1 || selector.slice(close + 1).trim()) {
      return { valid: false };
    }
    const base = selector.slice(0, i).trim();
    const arg = selector.slice(open + 1, close).trim();
    if (!base) return { valid: false };
    const text = unquoteLocatorString(arg);
    if (!text) return { valid: false };
    return { valid: true, selector: base, mode: pseudo.mode, text };
  }
  return undefined;
}

/**
 * 解析语义定位器（兼容 ego-lite 与 agent-browser 语法）：
 * - @e1 / @1 / ref=e1
 * - loc=role:button[name="确认"] / role:button[name*="下载"]
 * - text="精确文本" / text=模糊子串 / loc=text:...
 * - loc=href:/path / href:/path
 * - xpath=//button
 * - button:has-text("查询") / .t-select-option:text-is("取得发票")
 * - <locator> >> nth=0 / >> nth=-1
 * - 标准 CSS 选择器
 */
function parseSelectorOrLocator(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new ElementResolutionError('Selector or locator must be a non-empty string', 'permanent', 'CDP_INVALID_LOCATOR');
  }
  const raw = input.trim();
  const refId = parseRef(raw);
  if (refId) {
    return { kind: 'ref', refId, raw };
  }

  let value = raw.startsWith('loc=') ? raw.slice(4).trim() : raw;
  const nthInfo = parseTerminalNth(value);
  if (nthInfo && !nthInfo.valid) {
    throw new ElementResolutionError(`Invalid nth locator syntax: ${raw}`, 'permanent', 'CDP_INVALID_LOCATOR');
  }
  if (nthInfo && nthInfo.valid) {
    const inner = parseCoreLocator(nthInfo.base, raw);
    return { kind: 'nth', inner, index: nthInfo.index, raw };
  }
  return parseCoreLocator(value, raw);
}

function parseCoreLocator(value, raw) {
  if (value.startsWith('xpath=')) {
    const xpath = value.slice(6).trim();
    if (!xpath) throw new ElementResolutionError(`Invalid XPath locator: ${raw}`, 'permanent', 'CDP_INVALID_LOCATOR');
    return { kind: 'xpath', xpath, raw };
  }
  if (value.startsWith('href:')) {
    const href = value.slice(5).trim();
    if (!href) throw new ElementResolutionError(`Invalid href locator: ${raw}`, 'permanent', 'CDP_INVALID_LOCATOR');
    return { kind: 'href', href: unquoteLocatorString(href), raw };
  }
  if (value.startsWith('text=') || value.startsWith('text:')) {
    const body = value.slice(5).trim();
    if (!body) throw new ElementResolutionError(`Invalid text locator: ${raw}`, 'permanent', 'CDP_INVALID_LOCATOR');
    const quoted = (body.startsWith('"') && body.endsWith('"')) || (body.startsWith("'") && body.endsWith("'"));
    const text = unquoteLocatorString(body);
    return { kind: 'text', mode: quoted ? 'exact' : 'substring', text, raw };
  }
  const roleMatch = /^role:([A-Za-z0-9_-]+)(?:\[name(\*=|=)(.+)\])?$/.exec(value);
  if (roleMatch) {
    const role = normalizeRole(roleMatch[1]);
    const nameMode = roleMatch[2] === '*=' ? 'substring' : 'exact';
    const name = roleMatch[3] !== undefined ? unquoteLocatorString(roleMatch[3]) : '';
    return { kind: 'role', role, name, nameMode, hasNameFilter: roleMatch[3] !== undefined, raw };
  }
  const cssBody = value.startsWith('css:') || value.startsWith('css=') ? value.slice(4).trim() : value;
  const cssText = parseTerminalCssText(cssBody);
  if (cssText && !cssText.valid) {
    throw new ElementResolutionError(`Invalid CSS text pseudo locator: ${raw}`, 'permanent', 'CDP_INVALID_LOCATOR');
  }
  if (cssText && cssText.valid) {
    return {
      kind: 'cssText',
      selector: cssText.selector,
      mode: cssText.mode,
      text: cssText.text,
      raw,
    };
  }
  return { kind: 'css', selector: cssBody, raw };
}

/**
 * 判断是否为传统纯 CSS 选择器（无语义前缀、无伪类扩展、无 @ref），
 * 以保证现有单元测试对轻量 mock evalChecked 的 100% 兼容。
 */
function isPlainCssSelector(input) {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (!trimmed || parseRef(trimmed)) return false;
  if (
    trimmed.startsWith('loc=') ||
    trimmed.startsWith('role:') ||
    trimmed.startsWith('text=') ||
    trimmed.startsWith('text:') ||
    trimmed.startsWith('href:') ||
    trimmed.startsWith('xpath=') ||
    trimmed.startsWith('css:') ||
    trimmed.startsWith('css=') ||
    trimmed.includes(':has-text(') ||
    trimmed.includes(':text-is(') ||
    trimmed.includes('>>')
  ) {
    return false;
  }
  return true;
}

// 注入到页面侧的 DOM + Open Shadow DOM + 语义角色/文本查询 + 可交互性检测辅助代码
const BROWSER_LOCATOR_HELPERS_JS = `
  function __abbNormalizeText(val) {
    return String(val ?? '').replace(/[\\u200b\\u00ad\\ufeff]/g, '').replace(/\\s+/g, ' ').trim();
  }
  function __abbQueryAllOpenShadow(selector) {
    const matches = [];
    const roots = [document];
    while (roots.length) {
      const root = roots.pop();
      try {
        matches.push(...root.querySelectorAll(selector));
      } catch (err) {
        if (root === document) throw err;
      }
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].id === '__abb_hud_host' || all[i].hasAttribute?.('data-abb-ignore')) continue;
        if (all[i].shadowRoot) roots.push(all[i].shadowRoot);
      }
    }
    return matches;
  }
  function __abbImplicitRole(el) {
    const explicit = String(el.getAttribute?.('role') || '').trim().toLowerCase().split(/\\s+/)[0];
    if (explicit) return explicit;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'A' && el.hasAttribute?.('href')) return 'link';
    if (tag === 'TEXTAREA' || el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'OPTION') return 'option';
    if (tag === 'IMG') return 'img';
    if (tag === 'IFRAME') return 'iframe';
    if (tag === 'LI') return 'listitem';
    if (tag === 'TR') return 'row';
    if (tag === 'TD') return 'cell';
    if (tag === 'TH') return 'columnheader';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'INPUT') {
      const t = String(el.type || 'text').toLowerCase();
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      if (t === 'number') return 'spinbutton';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    if (el.classList?.contains('t-checkbox') || el.classList?.contains('el-checkbox') || el.classList?.contains('ant-checkbox-wrapper')) return 'checkbox';
    if (el.classList?.contains('t-radio') || el.classList?.contains('el-radio') || el.classList?.contains('ant-radio-wrapper')) return 'radio';
    if (el.classList?.contains('t-button') || el.classList?.contains('el-button') || el.classList?.contains('ant-btn')) return 'button';
    return '';
  }
  function __abbAccessibleName(el) {
    if (!el) return '';
    const ariaLabel = el.getAttribute?.('aria-label');
    if (ariaLabel && __abbNormalizeText(ariaLabel)) return __abbNormalizeText(ariaLabel);
    const labelledBy = String(el.getAttribute?.('aria-labelledby') || '').trim();
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').filter(Boolean);
      if (parts.length) return __abbNormalizeText(parts.join(' '));
    }
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const t = String(el.type || '').toLowerCase();
      if (t === 'button' || t === 'submit' || t === 'reset') return __abbNormalizeText(el.value);
      if (el.id) {
        const lbl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']');
        if (lbl && __abbNormalizeText(lbl.textContent)) return __abbNormalizeText(lbl.textContent);
      }
      const parentLbl = el.closest?.('label');
      if (parentLbl && __abbNormalizeText(parentLbl.textContent)) return __abbNormalizeText(parentLbl.textContent);
      const ph = el.getAttribute?.('placeholder') || el.getAttribute?.('title') || el.getAttribute?.('name');
      if (ph) return __abbNormalizeText(ph);
    }
    const title = el.getAttribute?.('title') || el.getAttribute?.('alt');
    if (title && !__abbNormalizeText(el.innerText || el.textContent)) return __abbNormalizeText(title);
    return __abbNormalizeText(el.innerText ?? el.textContent ?? '');
  }
  function __abbIsVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest?.('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function __abbIsDisabled(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.disabled === true || cur.getAttribute?.('aria-disabled') === 'true') return true;
      if (/(?:^|\\s)(?:t-is-disabled|is-disabled|ant-btn-disabled|disabled)(?:\\s|$)/.test(String(cur.className || ''))) return true;
      cur = cur.parentElement;
    }
    return false;
  }
`;

function buildSpecElementsJs(spec) {
  switch (spec.kind) {
    case 'css':
      return `__abbQueryAllOpenShadow(${JSON.stringify(spec.selector)})`;
    case 'xpath':
      return `(() => {
        const res = document.evaluate(${JSON.stringify(spec.xpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return Array.from({ length: res.snapshotLength }, (_, i) => res.snapshotItem(i));
      })()`;
    case 'href':
      return `__abbQueryAllOpenShadow('a[href]').filter(el => {
        try {
          const u = new URL(el.href, location.href);
          const p = u.pathname + u.search + u.hash;
          return p === ${JSON.stringify(spec.href)} || u.href === ${JSON.stringify(spec.href)} || (el.getAttribute('href') || '').includes(${JSON.stringify(spec.href)});
        } catch { return false; }
      })`;
    case 'cssText':
      return `__abbQueryAllOpenShadow(${JSON.stringify(spec.selector)}).filter(el => {
        const expected = __abbNormalizeText(${JSON.stringify(spec.text)});
        const full = __abbNormalizeText(el.innerText ?? el.textContent ?? el.value ?? '');
        if (${JSON.stringify(spec.mode)} === 'exact') {
          const imm = __abbNormalizeText([...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join(' '));
          return full === expected || imm === expected;
        }
        return full.toLowerCase().includes(expected.toLowerCase());
      })`;
    case 'text':
      return `(() => {
        const expected = __abbNormalizeText(${JSON.stringify(spec.text)});
        const mode = ${JSON.stringify(spec.mode)};
        const skipTags = new Set(['HTML', 'HEAD', 'BODY', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);
        const all = __abbQueryAllOpenShadow('*').filter(el => !skipTags.has(el.tagName));
        const matched = all.filter(el => {
          const type = String(el.getAttribute?.('type') || '').toLowerCase();
          if (el.tagName === 'INPUT' && (type === 'button' || type === 'submit')) {
            const v = __abbNormalizeText(el.value);
            return mode === 'exact' ? v === expected : v.toLowerCase().includes(expected.toLowerCase());
          }
          const imm = __abbNormalizeText([...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join(' '));
          const full = __abbNormalizeText(el.innerText ?? el.textContent ?? '');
          if (mode === 'exact') return imm === expected || (el.children.length === 0 && full === expected);
          return full.toLowerCase().includes(expected.toLowerCase());
        });
        return matched.filter(el => !matched.some(other => other !== el && el.contains(other)));
      })()`;
    case 'role': {
      const ROLE_FAST_SELECTORS = {
        button: 'button, summary, input[type="button"], input[type="submit"], input[type="reset"], [role="button"], .t-button, .el-button, .ant-btn',
        link: 'a[href], [role="link"]',
        textbox: 'input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
        searchbox: 'input[type="search"], [role="searchbox"]',
        checkbox: 'input[type="checkbox"], [role="checkbox"], .t-checkbox, .el-checkbox, .ant-checkbox-wrapper',
        radio: 'input[type="radio"], [role="radio"], .t-radio, .el-radio, .ant-radio-wrapper',
        combobox: 'select, [role="combobox"]',
        option: 'option, [role="option"]',
        heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
        img: 'img, [role="img"]',
        row: 'tr, [role="row"]',
        cell: 'td, [role="cell"], [role="gridcell"]',
        columnheader: 'th, [role="columnheader"]',
        listitem: 'li, [role="listitem"]',
        iframe: 'iframe, [role="iframe"]',
      };
      const fastSel = ROLE_FAST_SELECTORS[spec.role] || `[role=${JSON.stringify(spec.role)}]`;
      return `(() => {
        const wantRole = ${JSON.stringify(spec.role)};
        const wantName = __abbNormalizeText(${JSON.stringify(spec.name)});
        const hasName = ${JSON.stringify(Boolean(spec.hasNameFilter))};
        const nameMode = ${JSON.stringify(spec.nameMode)};
        function filterPool(pool) {
          const matched = pool.filter(el => {
            const r = __abbImplicitRole(el);
            if (r !== wantRole) return false;
            if (!hasName) return true;
            const n = __abbAccessibleName(el);
            return nameMode === 'exact' ? n === wantName : n.toLowerCase().includes(wantName.toLowerCase());
          });
          return matched.filter(el => !matched.some(other => other !== el && el.contains(other) && __abbImplicitRole(other) === wantRole));
        }
        const fastPool = __abbQueryAllOpenShadow(${JSON.stringify(fastSel)});
        const fastRes = filterPool(fastPool);
        if (fastRes.length > 0) return fastRes;
        return filterPool(__abbQueryAllOpenShadow('*'));
      })()`;
    }
    case 'nth':
      return `(() => {
        const list = Array.from(${buildSpecElementsJs(spec.inner)} || []);
        const visibleList = list.filter(__abbIsVisible);
        const pool = visibleList.length > 0 ? visibleList : list;
        const idx = ${spec.index} === -1 ? pool.length - 1 : ${spec.index};
        return idx >= 0 && idx < pool.length ? [pool[idx]] : [];
      })()`;
    default:
      throw new ElementResolutionError(`Unsupported locator kind: ${spec.kind}`, 'permanent', 'CDP_INVALID_LOCATOR');
  }
}

/**
 * 将 @ref 或语义定位器转换为可在浏览器端求值的元素查找 JS 表达式（返回匹配的 Element 数组）。
 * 若页面有多余隐藏副本但仅 1 个可见副本，优先收敛到唯一可见元素。
 */
function buildFindElementsExpression(cdp, selectorOrLocator) {
  const parsed = parseSelectorOrLocator(selectorOrLocator);
  let targetSpec = parsed;
  if (parsed.kind === 'ref') {
    const refMap = ensurePageRefMap(cdp);
    const entry = refMap.get(parsed.refId);
    if (!entry) {
      throw new ElementResolutionError(
        `Unknown ref: @${parsed.refId}. Take a snapshot first before acting on a ref.`,
        'transient',
        'CDP_STALE_REF'
      );
    }
    const primaryJs = entry.selector
      ? buildSpecElementsJs(parseSelectorOrLocator(entry.selector))
      : `__abbQueryAllOpenShadow(${JSON.stringify(`[data-abb-ref="${entry.refId}"]`)})`;

    let fallbackSpec = null;
    if (entry.allowFallback !== false) {
      if (entry.role) {
        const baseRole = {
          kind: 'role',
          role: normalizeRole(entry.role),
          name: entry.name || '',
          nameMode: 'exact',
          hasNameFilter: Boolean(entry.name),
          raw: `@${parsed.refId}`,
        };
        fallbackSpec = entry.nth !== undefined
          ? { kind: 'nth', inner: baseRole, index: entry.nth, raw: `@${parsed.refId}` }
          : baseRole;
      } else if (entry.loc) {
        fallbackSpec = parseSelectorOrLocator(entry.loc);
      }
    }

    const fallbackJs = fallbackSpec ? buildSpecElementsJs(fallbackSpec) : '[]';
    return `(() => {
      ${BROWSER_LOCATOR_HELPERS_JS}
      let rawMatches = Array.from(${primaryJs} || []);
      if (rawMatches.length === 0) {
        rawMatches = Array.from(${fallbackJs} || []);
      }
      if (rawMatches.length <= 1) return rawMatches;
      const visibleMatches = rawMatches.filter(__abbIsVisible);
      return visibleMatches.length === 1 ? visibleMatches : rawMatches;
    })()`;
  }

  // 对纯 CSS 选择器保持最简表达式以兼容现有 mock 测试，同时在真实 DOM 中支持唯一可见元素收敛
  const queryJs = buildSpecElementsJs(targetSpec);
  return `(() => {
    ${BROWSER_LOCATOR_HELPERS_JS}
    const rawMatches = Array.from(${queryJs} || []);
    if (rawMatches.length <= 1) return rawMatches;
    const visibleMatches = rawMatches.filter(__abbIsVisible);
    return visibleMatches.length === 1 ? visibleMatches : rawMatches;
  })()`;
}

/**
 * 在页面中诊断选择器匹配情况（用于报错时提供可见/隐藏数量与前 3 个候选元素详情）。
 */
async function diagnoseSelectorMatches(cdp, selectorOrLocator) {
  try {
    const expr = buildFindElementsExpression(cdp, selectorOrLocator);
    return await cdp.evalChecked(`(() => {
      ${BROWSER_LOCATOR_HELPERS_JS}
      const list = ${expr};
      let visible = 0;
      const candidates = list.slice(0, 3).map(el => {
        const vis = __abbIsVisible(el);
        if (vis) visible++;
        return {
          tag: String(el.tagName || 'element').toLowerCase(),
          role: __abbImplicitRole(el) || undefined,
          name: __abbAccessibleName(el).slice(0, 60) || undefined,
          visible: vis,
          disabled: __abbIsDisabled(el),
        };
      });
      for (let i = 3; i < list.length; i++) {
        if (__abbIsVisible(list[i])) visible++;
      }
      return { total: list.length, visible, hidden: list.length - visible, candidates };
    })()`);
  } catch {
    return undefined;
  }
}

module.exports = {
  ElementResolutionError,
  RefMap,
  ensurePageRefMap,
  parseRef,
  parseSelectorOrLocator,
  isPlainCssSelector,
  BROWSER_LOCATOR_HELPERS_JS,
  buildFindElementsExpression,
  diagnoseSelectorMatches,
  normalizeRole,
};
