// Exercise paths the main suite misses: hotkeys, error state + retry,
// SPA navigation reset, cache clear, cross-tab config listener.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = fs.readFileSync(path.join(HERE, '..', 'yt-native-translator.user.js'), 'utf8');
const cookies = [];
for (const part of fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim().split(/;\s*/)) {
  const eq = part.indexOf('=');
  if (eq <= 0) continue;
  for (const domain of ['.youtube.com', '.google.com']) cookies.push({ name: part.slice(0, eq), value: part.slice(eq + 1), domain, path: '/', secure: part.slice(0, eq).startsWith('__Secure-'), sameSite: 'None' });
}

const out = [];
const log = (k, v) => { out.push({ k, v }); console.log(k + ': ' + JSON.stringify(v)); };

const context = await chromium.launchPersistentContext(path.join(HERE, 'profile8'), { headless: true, viewport: { width: 1280, height: 860 }, locale: 'zh-CN', args: ['--lang=zh-CN'] });
await context.addCookies(cookies);
await context.addInitScript({ content: SCRIPT });
const page = await context.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error' && !/about:blank|ERR_TIMED_OUT|net::/.test(m.text())) errs.push('console ' + m.text().slice(0, 160)); });

await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ&hl=zh-CN', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.evaluate(() => { localStorage.setItem('ytn_config_v1', JSON.stringify({ autoTranslate: false, hover: false, mode: 'bilingual', targetLang: 'zh-CN' })); localStorage.removeItem('ytn_cache_v1'); });
await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ&hl=zh-CN', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
await page.waitForTimeout(3000);
// second page because addInitScript only runs on a page's first navigation
const page2 = await context.newPage();
page2.on('pageerror', (e) => errs.push('p2 ' + String(e.message).slice(0, 160)));
await page2.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ&hl=zh-CN', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page2.waitForTimeout(3000);
await page2.evaluate(() => document.querySelector('ytd-comments#comments')?.scrollIntoView({ block: 'start' }));
for (let i = 0; i < 6; i++) { await page2.mouse.wheel(0, 1300); await page2.waitForTimeout(700); }
await page2.waitForTimeout(2000);
log('init with hover+auto off', await page2.evaluate(() => ({ init: document.documentElement.hasAttribute('data-ytn-loaded'), boxes: document.querySelectorAll('.ytn-box').length })));

// Alt+Shift+A -> translate visible
await page2.keyboard.down('Alt'); await page2.keyboard.down('Shift');
await page2.keyboard.press('KeyA');
await page2.keyboard.up('Shift'); await page2.keyboard.up('Alt');
await page2.waitForTimeout(5000);
log('Alt+Shift+A', await page2.evaluate(() => ({
  boxes: document.querySelectorAll('.ytn-box').length,
  done: document.querySelectorAll('.ytn-box[data-state="done"]').length,
  toast: [...document.querySelectorAll('.ytn-toast')].map((t) => t.textContent),
})));

// Alt+Shift+T -> cycle view mode
await page2.keyboard.down('Alt'); await page2.keyboard.down('Shift');
await page2.keyboard.press('KeyT');
await page2.keyboard.up('Shift'); await page2.keyboard.up('Alt');
await page2.waitForTimeout(800);
log('Alt+Shift+T', await page2.evaluate(() => ({
  views: [...new Set([...document.querySelectorAll('.ytn-box')].map((b) => b.dataset.view))],
  hidden: document.querySelectorAll('ytd-comment-view-model.ytn-hide-source').length,
  toast: [...document.querySelectorAll('.ytn-toast')].map((t) => t.textContent).slice(-1),
})));

// Alt+Shift+P -> toggle auto translate
await page2.keyboard.down('Alt'); await page2.keyboard.down('Shift');
await page2.keyboard.press('KeyP');
await page2.keyboard.up('Shift'); await page2.keyboard.up('Alt');
await page2.waitForTimeout(1200);
log('Alt+Shift+P', await page2.evaluate(() => ({
  stored: JSON.parse(localStorage.getItem('ytn_config_v1') || '{}').autoTranslate,
  toast: [...document.querySelectorAll('.ytn-toast')].map((t) => t.textContent).slice(-1),
})));

// force an error branch through the settings panel (in-memory config), not storage
const errBranch = await page2.evaluate(async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', code: 'KeyS', altKey: true, shiftKey: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const overlay = document.querySelector('.ytn-overlay');
  overlay.querySelectorAll('.ytn-ptab')[2].click();
  const sel = overlay.querySelector('.ytn-select');
  sel.value = 'xx';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  overlay.querySelector('.ytn-close').click();
  await new Promise((r) => setTimeout(r, 600));
  const vm = [...document.querySelectorAll('ytd-comment-view-model')].find((v) => !v.querySelector('.ytn-box'));
  vm?.querySelector('.translate-button tp-yt-paper-button')?.click();
  await new Promise((r) => setTimeout(r, 6000));
  const box = vm?.querySelector('.ytn-box');
  return {
    state: box?.dataset.state,
    text: (box?.querySelector('.ytn-text')?.textContent || '').slice(0, 40),
    retryVisible: box ? getComputedStyle(box.querySelector('.ytn-retry')).display !== 'none' : null,
    langStored: JSON.parse(localStorage.getItem('ytn_config_v1') || '{}').targetLang,
  };
});
log('invalid lang -> error state', errBranch);
if (errBranch.retryVisible) {
  const retried = await page2.evaluate(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', code: 'KeyS', altKey: true, shiftKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const overlay = document.querySelector('.ytn-overlay');
    overlay.querySelectorAll('.ytn-ptab')[2].click();
    const sel = overlay.querySelector('.ytn-select');
    sel.value = 'zh-CN';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    overlay.querySelector('.ytn-close').click();
    await new Promise((r) => setTimeout(r, 400));
    const box = [...document.querySelectorAll('.ytn-box[data-state="error"]')][0];
    if (!box) return { skipped: 'error box disappeared after language change' };
    box.querySelector('.ytn-retry').click();
    await new Promise((r) => setTimeout(r, 6000));
    return { state: box.dataset.state, text: (box.querySelector('.ytn-text')?.textContent || '').slice(0, 60) };
  });
  log('retry after fixing language', retried);
}

// SPA navigation reset
log('yt-navigate-finish', await page2.evaluate(async () => {
  window.dispatchEvent(new Event('yt-navigate-finish'));
  await new Promise((r) => setTimeout(r, 600));
  return { boxesStillThere: document.querySelectorAll('.ytn-box').length, noLauncher: !document.querySelector('.ytn-launcher') };
}));

// clear cache via hotkey
const beforeClear = await page2.evaluate(() => {
  window.dispatchEvent(new Event('pagehide'));
  try { return JSON.parse(localStorage.getItem('ytn_cache_v1') || '[]').length; } catch (e) { return -1; }
});
await page2.keyboard.down('Alt'); await page2.keyboard.down('Shift');
await page2.keyboard.press('KeyC');
await page2.keyboard.up('Shift'); await page2.keyboard.up('Alt');
await page2.waitForTimeout(800);
log('Alt+Shift+C clears cache', { before: beforeClear, after: await page2.evaluate(() => { try { return JSON.parse(localStorage.getItem('ytn_cache_v1') || '[]').length; } catch (e) { return -1; } }) });

// network failure -> error state + retry (blocked endpoint, then released)
await page2.route('**/perform_comment_action*', (r) => r.abort());
const failState = await page2.evaluate(async () => {
  const vm = [...document.querySelectorAll('ytd-comment-view-model')].find((v) => !v.querySelector('.ytn-box'));
  vm?.querySelector('.translate-button tp-yt-paper-button')?.click();
  await new Promise((r) => setTimeout(r, 6000));
  const box = vm?.querySelector('.ytn-box');
  return {
    state: box?.dataset.state,
    text: (box?.querySelector('.ytn-text')?.textContent || '').slice(0, 40),
    retryVisible: box ? getComputedStyle(box.querySelector('.ytn-retry')).display !== 'none' : null,
    ariaBusy: box?.getAttribute('aria-busy'),
  };
});
log('network failure -> error state', failState);
await page2.unroute('**/perform_comment_action*');
const recovered = await page2.evaluate(async () => {
  const box = [...document.querySelectorAll('.ytn-box[data-state="error"]')][0];
  if (!box) return { skipped: 'no error box to retry' };
  box.querySelector('.ytn-retry').click();
  await new Promise((r) => setTimeout(r, 7000));
  return { state: box.dataset.state, text: (box.querySelector('.ytn-text')?.textContent || '').slice(0, 50) };
});
log('retry after network recovery', recovered);

await page2.screenshot({ path: path.join(HERE, 'verify', 'interactions.png') }).catch(() => {});
log('errors', errs.length ? errs : 'none');
fs.writeFileSync(path.join(HERE, 'verify', 'interactions.json'), JSON.stringify(out, null, 1));
await context.close();
