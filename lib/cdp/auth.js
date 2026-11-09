const fs = require('node:fs');
const path = require('node:path');
const { sleep } = require('./client');
const { isClickableRect } = require('./window');
const { isPlainCssSelector, buildFindElementsExpression } = require('./locator');
const { emitHudNonBlocking } = require('./hud');

function requireGuard(guardExpression, action) {
  if (typeof guardExpression !== 'string' || !guardExpression.trim()) throw new Error(action + ' requires context guard');
}

function requireSelectorAndGuard(selector, guardExpression, action) {
  if (typeof selector !== 'string' || !selector.trim()) throw new Error(action + ' requires selector and context guard');
  requireGuard(guardExpression, action);
}

function selectorQuerySource(cdp, selector) {
  if (isPlainCssSelector(selector)) {
    return '(()=>{const raw=[...document.querySelectorAll(' + JSON.stringify(selector) + ')];if(raw.length<=1)return raw;const vis=raw.filter(e=>{if(!e||!e.isConnected)return false;if(e.closest&&e.closest("[hidden],[inert],[aria-hidden=\\"true\\"]"))return false;const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;const s=window.getComputedStyle?window.getComputedStyle(e):null;return !s||(s.display!=="none"&&s.visibility!=="hidden"&&Number(s.opacity)!==0)});return vis.length===1?vis:raw})()';
  }
  return buildFindElementsExpression(cdp, selector);
}

function visibleCountSource(cdp, selector) {
  const querySrc = selectorQuerySource(cdp, selector);
  return '(function(){const es=' + querySrc + ';let n=0;for(const e of es){const r=e.getBoundingClientRect();if(r.width>=8&&r.height>=8)n++}return n})()';
}

async function inspectAuth(cdp, options = {}) {
  const { guardExpression, loginSelector, captchaSelector, readySelector } = options;
  requireGuard(guardExpression, 'Auth inspect');
  if (!loginSelector && !captchaSelector && !readySelector) throw new Error('Auth inspect requires login, captcha or ready selector');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before auth inspect');
  const login = loginSelector ? visibleCountSource(cdp, loginSelector) : '0';
  const captcha = captchaSelector ? visibleCountSource(cdp, captchaSelector) : '0';
  const ready = readySelector ? visibleCountSource(cdp, readySelector) : '0';
  return cdp.evalChecked('(()=>{if(!(' + guardExpression + '))throw Error("Context guard failed before auth inspect");const login=' + login + ';const captcha=' + captcha + ';const ready=' + ready + ';if(login>1||captcha>1||ready>1)throw Error("Auth selector must be unique");return {loginVisible:login===1,captchaVisible:captcha===1,ready:ready===1,blocked:login===1||captcha===1,businessWrites:0}})()');
}

async function waitForUserAuth(cdp, options = {}) {
  const { guardExpression, readySelector, timeoutMs = 120000, intervalMs = 500, onWait } = options;
  requireGuard(guardExpression, 'User auth wait');
  if (typeof readySelector !== 'string' || !readySelector.trim()) throw new Error('User auth wait requires ready selector');
  if (timeoutMs < 1 || timeoutMs > 300000 || intervalMs < 1) throw new Error('Invalid auth wait bounds');
  const message = '需要在可见浏览器中完成登录或验证码，桥接不会填写或保存密码。';
  emitHudNonBlocking(cdp, { badge: '人工验证', tone: 'warn', text: message, durationMs: Math.min(timeoutMs, 15000) });
  if (typeof onWait === 'function') onWait(message);
  else process.stderr.write(message + '\n');
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await inspectAuth(cdp, options);
    if (state.ready && !state.blocked) return state;
    await sleep(intervalMs);
  } while (Date.now() < deadline);
  throw new Error('User auth timed out; login or captcha still blocking');
}

async function capturePagePng(cdp, outPath, guardExpression) {
  if (typeof guardExpression === 'string' && guardExpression.trim()) {
    if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before image capture');
  }
  if (cdp && cdp.targetId && cdp.browser && typeof cdp.browser.send === 'function') {
    try { await cdp.browser.send('Target.activateTarget', { targetId: cdp.targetId }); } catch {}
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (!shot || typeof shot.data !== 'string') throw new Error('Screenshot capture failed');
  const png = Buffer.from(shot.data, 'base64');
  if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50) throw new Error('Capture did not return PNG');
  if (typeof outPath === 'string' && outPath.trim()) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, png);
  }
  return { png, outPath: outPath || undefined };
}

async function captureUniquePng(cdp, selector, guardExpression, outPath) {
  requireSelectorAndGuard(selector, guardExpression, 'Unique image capture');
  if (!await cdp.evalChecked(guardExpression)) throw new Error('Context guard failed before image capture');
  // 兼容 3 参数全页截图调用：captureUniquePng(page, destPngPath, guardExpression)
  if (outPath === undefined && /\.png$/i.test(selector.trim()) && (selector.includes('/') || selector.includes('\\'))) {
    return capturePagePng(cdp, selector, guardExpression);
  }
  if (cdp && cdp.targetId && cdp.browser && typeof cdp.browser.send === 'function') {
    try { await cdp.browser.send('Target.activateTarget', { targetId: cdp.targetId }); } catch {}
  }
  const querySrc = selectorQuerySource(cdp, selector);
  const rect = await cdp.evalChecked('(()=>{const es=' + querySrc + ';if(es.length!==1)throw Error("Capture target must be unique");const r=es[0].getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
  if (!isClickableRect(rect)) throw new Error('Capture target rect is not clickable');
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
  });
  if (!shot || typeof shot.data !== 'string') throw new Error('Screenshot capture failed');
  const png = Buffer.from(shot.data, 'base64');
  if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50) throw new Error('Capture did not return PNG');
  if (typeof outPath === 'string' && outPath.trim()) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, png);
  }
  return { png, width: rect.width, height: rect.height, outPath: outPath || undefined };
}

module.exports = { inspectAuth, waitForUserAuth, captureUniquePng, capturePagePng };
