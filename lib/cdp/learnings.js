// AgentBrowserBridge - 站点知识库与预置工具引擎 (Site Learnings & Reusable Tools Engine)
// 借鉴 citrolabs/ego-lite/package/ego-browser/src/learning 架构，为高频企业站点
//（如金蝶云星空 k3cloud、广东电子税务局 etax-gd）沉淀可校验的 manifest.json、
// 经验笔记 notes/*.md 与可复用脚本工具 tools/*.cjs。
// 安全红线：严禁在 learnings 中存放任何密码、Cookie、Token 或会话存储状态。

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LEARNINGS_ROOT = path.resolve(__dirname, '..', '..', 'learnings');

function resolveLearningsRoot(customRoot) {
  if (customRoot && typeof customRoot === 'string') return path.resolve(customRoot);
  if (process.env.BROWSER_BRIDGE_LEARNINGS_DIR) {
    return path.resolve(process.env.BROWSER_BRIDGE_LEARNINGS_DIR);
  }
  return DEFAULT_LEARNINGS_ROOT;
}

function validateManifestObject(manifest, siteDir) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return ['manifest must be a JSON object'];
  }
  if (typeof manifest.site !== 'string' || !manifest.site.trim()) {
    errors.push('manifest.site must be a non-empty string');
  }
  if (!Array.isArray(manifest.domains) || manifest.domains.length === 0) {
    errors.push('manifest.domains must be a non-empty string array');
  }
  if (manifest.notes !== undefined) {
    if (!Array.isArray(manifest.notes)) {
      errors.push('manifest.notes must be an array');
    } else {
      for (const note of manifest.notes) {
        if (!note || typeof note.path !== 'string' || !note.path.trim()) {
          errors.push('note entry requires path');
          continue;
        }
        const absNote = path.resolve(siteDir, note.path);
        if (!absNote.startsWith(siteDir) || !fs.existsSync(absNote)) {
          errors.push(`missing note file: ${note.path}`);
        }
      }
    }
  }
  if (manifest.tools !== undefined) {
    if (!Array.isArray(manifest.tools)) {
      errors.push('manifest.tools must be an array');
    } else {
      for (const tool of manifest.tools) {
        if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) {
          errors.push('tool entry requires name');
        }
        if (!tool || typeof tool.entry !== 'string' || !tool.entry.trim()) {
          errors.push(`tool ${tool?.name || '(unknown)'} requires entry path`);
          continue;
        }
        const absTool = path.resolve(siteDir, tool.entry);
        if (!absTool.startsWith(siteDir) || !fs.existsSync(absTool)) {
          errors.push(`missing tool entry file: ${tool.entry}`);
        }
      }
    }
  }
  return errors;
}

function listSiteLearnings(options = {}) {
  const root = resolveLearningsRoot(options.root);
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const sites = [];
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const siteDir = path.join(root, dirent.name);
    const manifestPath = path.join(siteDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const errors = validateManifestObject(manifest, siteDir);
      sites.push({
        site: manifest.site || dirent.name,
        title: manifest.title || manifest.site || dirent.name,
        summary: manifest.summary || '',
        domains: Array.isArray(manifest.domains) ? manifest.domains : [],
        defaultGuard: manifest.defaultGuard || '',
        notes: Array.isArray(manifest.notes) ? manifest.notes : [],
        tools: Array.isArray(manifest.tools) ? manifest.tools : [],
        dir: siteDir,
        valid: errors.length === 0,
        errors,
      });
    } catch (err) {
      sites.push({
        site: dirent.name,
        title: dirent.name,
        summary: '',
        domains: [],
        defaultGuard: '',
        notes: [],
        tools: [],
        dir: siteDir,
        valid: false,
        errors: [`invalid manifest.json: ${err.message}`],
      });
    }
  }
  return sites.sort((a, b) => a.site.localeCompare(b.site));
}

function matchDomainPattern(hostname, pathAndUrl, pattern) {
  const pat = String(pattern || '').trim().toLowerCase();
  if (!pat) return false;
  const host = String(hostname || '').trim().toLowerCase();
  const full = String(pathAndUrl || '').trim().toLowerCase();
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(2);
    return host === suffix || host.endsWith('.' + suffix);
  }
  if (pat.includes('/')) {
    return full.includes(pat);
  }
  return host === pat || host.endsWith('.' + pat) || host.includes(pat);
}

function findSiteLearningForUrl(urlOrSite, options = {}) {
  const query = String(urlOrSite || '').trim();
  if (!query) return null;
  const sites = listSiteLearnings(options);
  const direct = sites.find((s) => s.site.toLowerCase() === query.toLowerCase());
  if (direct) return direct;

  let hostname = query;
  try {
    const parsed = new URL(query);
    hostname = parsed.hostname;
  } catch {}

  for (const site of sites) {
    for (const pattern of site.domains) {
      if (matchDomainPattern(hostname, query, pattern)) {
        return site;
      }
    }
  }
  return null;
}

function loadSiteLearning(siteIdOrUrl, options = {}) {
  const site = findSiteLearningForUrl(siteIdOrUrl, options);
  if (!site) return null;
  const loadedNotes = {};
  for (const note of site.notes) {
    if (!note || typeof note.path !== 'string') continue;
    const absPath = path.resolve(site.dir, note.path);
    if (absPath.startsWith(site.dir) && fs.existsSync(absPath)) {
      loadedNotes[note.path] = fs.readFileSync(absPath, 'utf8');
    }
  }
  return {
    ...site,
    noteContents: loadedNotes,
  };
}

async function runSiteTool(siteIdOrUrl, toolName, args = {}, context = {}, options = {}) {
  const site = findSiteLearningForUrl(siteIdOrUrl, options);
  if (!site) {
    throw new Error(`Site learning not found for: ${siteIdOrUrl}`);
  }
  if (!site.valid) {
    throw new Error(`Site learning "${site.site}" is invalid: ${site.errors.join('; ')}`);
  }
  const toolSpec = site.tools.find((t) => t.name === toolName);
  if (!toolSpec) {
    const available = site.tools.map((t) => t.name).join(', ') || '(none)';
    throw new Error(`Tool "${toolName}" not found in site "${site.site}". Available: ${available}`);
  }
  const absTool = path.resolve(site.dir, toolSpec.entry);
  if (!absTool.startsWith(site.dir) || !fs.existsSync(absTool)) {
    throw new Error(`Tool entry file missing: ${toolSpec.entry}`);
  }
  const mod = require(absTool);
  const runner = typeof mod === 'function' ? mod : (mod.run || mod.default);
  if (typeof runner !== 'function') {
    throw new Error(`Tool "${toolName}" in site "${site.site}" must export a function or { run }`);
  }
  return runner(args, {
    ...context,
    site,
    defaultGuard: site.defaultGuard,
  });
}

function validateSiteLearnings(options = {}) {
  const sites = listSiteLearnings(options);
  const invalid = sites.filter((s) => !s.valid);
  return {
    ok: invalid.length === 0,
    total: sites.length,
    validCount: sites.length - invalid.length,
    invalidCount: invalid.length,
    sites,
  };
}

module.exports = {
  DEFAULT_LEARNINGS_ROOT,
  resolveLearningsRoot,
  listSiteLearnings,
  findSiteLearningForUrl,
  loadSiteLearning,
  runSiteTool,
  validateSiteLearnings,
};
