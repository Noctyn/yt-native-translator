// Browser verification. patchright's addInitScript only fires on a page's first
// navigation, so each step opens a fresh page instead of re-navigating one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'yt-native-translator.user.js'), 'utf8');
const VID = process.argv[2] || 'dQw4w9WgXcQ';
const OUT = path.join(HERE, 'verify');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const cookies = [];
for (const part of fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim().split(/;\s*/)) {
  const eq = part.indexOf('=');
  if (eq <= 0) continue;
  for (const domain of ['.youtube.com', '.google.com']) cookies.push({ name: part.slice(0, eq), value: part.slice(eq + 1), domain, path: '/', secure: part.slice(0, eq).startsWith('__Secure-'), sameSite: 'None' });
}

const report = { errors: [], steps: [] };
const step = (name, data) => { report.steps.push({ name, ...data }); console.log(`\n### ${name}\n` + JSON.stringify(data, null, 1).slice(0, 1600)); };

const context = await chromium.launchPersistentContext(path.join(HERE, 'profile4'), {
  headless: !process.argv.includes('--headed'),
  viewport: { width: 1320, height: 900 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  args: ['--lang=zh-CN', '--disable-features=Translate'],
});
await context.addCookies(cookies);
await context.addInitScript({ content: SCRIPT });

let apiCalls = 0;

async function openWatch({ seed } = {}) {
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push('console: ' + m.text().slice(0, 180)); });
  page.on('pageerror', (e) => report.errors.push('pageerror: ' + String(e.message).slice(0, 180)));
  page.on('request', (req) => { if (/perform_comment_action/.test(req.url())) apiCalls++; });
  if (seed) {
    await page.goto('https://www.youtube.com/?persist_configs=1', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.evaluate((cfg) => localStorage.setItem('ytn_config_v1', JSON.stringify(cfg)), seed);
    await page.evaluate(() => localStorage.removeItem('ytn_cache_v1'));
    await page.close();
    const p2 = await context.newPage();
    p2.on('console', (m) => { if (m.type() === 'error') report.errors.push('console: ' + m.text().slice(0, 180)); });
    p2.on('pageerror', (e) => report.errors.push('pageerror: ' + String(e.message).slice(0, 180)));
    p2.on('request', (req) => { if (/perform_comment_action/.test(req.url())) apiCalls++; });
    return openOn(p2);
  }
  return openOn(page);
}

async function openOn(page) {
  await page.goto(`https://www.youtube.com/watch?v=${VID}&hl=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2500);
  for (const b of await page.$$('tp-yt-paper-dialog button, yt-button-shape button')) {
    const t = ((await b.textContent().catch(() => '')) || '').trim();
    if (/^(接受全部|我同意|Accept all|Reject all)$/i.test(t)) { await b.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(1000); }
  }
  await page.evaluate(() => document.querySelector('ytd-comments#comments')?.scrollIntoView({ block: 'start' }));
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 1300); await page.waitForTimeout(800); }
  return page;
}

const readState = (page) => page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.ytn-box')];
  const done = boxes.filter((b) => b.dataset.state === 'done');
  return {
    init: document.documentElement.hasAttribute('data-ytn-loaded'),
    theme: document.documentElement.getAttribute('data-ytn-theme'),
    styleAttr: document.documentElement.getAttribute('data-ytn-style'),
    noLauncher: !document.querySelector('.ytn-launcher'),
    vms: document.querySelectorAll('ytd-comment-view-model').length,
    boxes: boxes.length,
    done: done.length,
    loading: boxes.filter((b) => b.dataset.state === 'loading').length,
    error: boxes.filter((b) => b.dataset.state === 'error').length,
    errTexts: [...new Set(boxes.filter((b) => b.dataset.state === 'error').map((b) => (b.querySelector('.ytn-text')?.textContent || '').slice(0, 50)))],
    cjk: done.filter((b) => /[一-鿿]/.test(b.querySelector('.ytn-text')?.textContent || '')).length,
    cssApplied: done.length ? getComputedStyle(done[0]).borderLeftWidth + '/' + getComputedStyle(done[0]).position : null,
    samples: done.slice(0, 2).map((b) => {
      const vm = b.closest('ytd-comment-view-model');
      return {
        prevSibling: b.previousElementSibling?.id || b.previousElementSibling?.tagName,
        source: (vm?.querySelector('#content-text')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        translation: (b.querySelector('.ytn-text')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        tabs: [...b.querySelectorAll('.ytn-tab')].map((t) => t.textContent + (t.classList.contains('is-on') ? '*' : '')),
      };
    }),
  };
});

// 1. auto-translate on scroll
const p1 = await openWatch({ seed: { autoTranslate: true, hover: true, mode: 'bilingual', style: 'quote', takeoverNative: true } });
await p1.waitForFunction(() => document.querySelectorAll('.ytn-box[data-state="done"]').length >= 3, null, { timeout: 45000 }).catch(() => {});
await p1.waitForTimeout(2500);
step('1. 自动翻译（滚动触发）', { apiCalls, ...(await readState(p1)) });
await p1.screenshot({ path: path.join(OUT, '1-auto.png') });

// 2. view modes via tabs
const tabs = await p1.evaluate(() => {
  const box = document.querySelector('.ytn-box[data-state="done"]');
  const other = document.querySelectorAll('.ytn-box[data-state="done"]')[1];
  const vm = box.closest('ytd-comment-view-model');
  const out = {};
  box.querySelector('.ytn-tab[data-view="translation"]').click();
  out.translationMode = { view: box.dataset.view, hideClass: vm.classList.contains('ytn-hide-source'), expanderDisplay: getComputedStyle(vm.querySelector('#expander')).display, aria: box.querySelector('.ytn-tab[data-view="translation"]').getAttribute('aria-pressed') };
  out.otherBoxUnaffected = other ? other.dataset.view : null;
  box.querySelector('.ytn-tab[data-view="original"]').click();
  out.originalMode = { view: box.dataset.view, bodyRows: getComputedStyle(box.querySelector('.ytn-body-wrap')).gridTemplateRows, expanderDisplay: getComputedStyle(vm.querySelector('#expander')).display, tabsStillVisible: getComputedStyle(box.querySelector('.ytn-tabs')).display };
  box.querySelector('.ytn-tab[data-view="bilingual"]').click();
  out.back = { view: box.dataset.view, expanderDisplay: getComputedStyle(vm.querySelector('#expander')).display, globalStored: localStorage.getItem('ytn_mode_v1') };
  return out;
});
step('2. 译文/原文/双语 切换', tabs);
await p1.evaluate(() => document.querySelector('.ytn-tab[data-view="translation"]').click());
await p1.screenshot({ path: path.join(OUT, '2-translation.png') });
await p1.evaluate(() => document.querySelector('.ytn-tab[data-view="bilingual"]').click());

// 3. hover trigger on an untranslated comment
const hoverTest = await p1.evaluate(async () => {
  const vm = [...document.querySelectorAll('ytd-comment-view-model')].find((v) => !v.querySelector('.ytn-box') && !v.__ytnDone);
  if (!vm) return { skipped: 'no untranslated comment in view' };
  vm.scrollIntoView({ block: 'center' });
  const r = vm.getBoundingClientRect();
  window.__hoverTarget = { x: r.x + 40, y: r.y + 20 };
  return { ready: true, x: window.__hoverTarget.x, y: window.__hoverTarget.y };
});
if (hoverTest.ready) {
  await p1.mouse.move(hoverTest.x, hoverTest.y, { steps: 8 });
  await p1.waitForTimeout(3500);
  step('3. 悬停触发', { ...hoverTest, ...(await readState(p1)) });
} else step('3. 悬停触发', hoverTest);

// 4. native translate button is hidden while takeover is on
const nativeHidden = await p1.evaluate(() => {
  const btns = [...document.querySelectorAll('ytd-comments .translate-button')];
  return {
    attr: document.documentElement.hasAttribute('data-ytn-hide-native'),
    total: btns.length,
    visible: btns.filter((b) => getComputedStyle(b).display !== 'none').length,
    labels: [...new Set(btns.map((b) => (b.textContent || '').trim()).filter(Boolean))].slice(0, 3),
  };
});
step('4. 隐藏原生「翻译成…」', nativeHidden);

// 5. settings panel
const panel = await p1.evaluate(async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', code: 'KeyS', altKey: true, shiftKey: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  const overlay = document.querySelector('.ytn-overlay');
  if (!overlay) return { opened: false };
  const info = { opened: true, rows: overlay.querySelectorAll('.ytn-row').length, ptabs: [...overlay.querySelectorAll('.ytn-ptab')].map((t) => t.textContent), segs: overlay.querySelectorAll('.ytn-seg').length, switches: overlay.querySelectorAll('.ytn-switch').length, langOptions: overlay.querySelectorAll('.ytn-select option').length };
  const seg = [...overlay.querySelectorAll('.ytn-seg')].find((s) => /柔和卡片|色条引述/.test(s.textContent));
  seg.querySelectorAll('.ytn-seg-btn')[1].click();
  info.styleAfterClick = document.documentElement.getAttribute('data-ytn-style');
  info.storedStyle = JSON.parse(localStorage.getItem('ytn_config_v1') || '{}').style;
  info.previewHasBox = !!overlay.querySelector('.ytn-preview .ytn-box[data-state="done"]');
  overlay.querySelectorAll('.ytn-ptab')[1].click();
  info.triggerPageHasRange = !!overlay.querySelector('.ytn-page.is-on .ytn-range');
  overlay.querySelectorAll('.ytn-ptab')[2].click();
  info.behaviorPageHasSelect = !!overlay.querySelector('.ytn-page.is-on .ytn-select');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  info.closedAfterEsc = !document.querySelector('.ytn-overlay');
  return info;
});
step('5. 设置面板', panel);
await p1.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', code: 'KeyS', altKey: true, shiftKey: true, bubbles: true })));
await p1.waitForTimeout(600);
await p1.screenshot({ path: path.join(OUT, '3-panel.png') });
await p1.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

// 6. cache reuse: force the pagehide flush, then reopen and expect cache hits
const cacheEntries = await p1.evaluate(() => {
  window.dispatchEvent(new Event('pagehide'));
  try { return JSON.parse(localStorage.getItem('ytn_cache_v1') || '[]').length; } catch (e) { return -1; }
});
const callsBeforeReload = apiCalls;
const p2 = await openWatch();
await p2.waitForFunction(() => document.querySelectorAll('.ytn-box[data-state="done"]').length >= 2, null, { timeout: 40000 }).catch(() => {});
await p2.waitForTimeout(2000);
step('6. 缓存复用', { persistedEntries: cacheEntries, newApiCalls: apiCalls - callsBeforeReload, ...(await readState(p2)) });
await p2.screenshot({ path: path.join(OUT, '4-cached.png') });

// 7. non-Chinese target language + replies + card style on a fresh page
const p3 = await openWatch({ seed: { autoTranslate: true, hover: false, mode: 'translation', style: 'card', targetLang: 'ja', takeoverNative: false } });
await p3.waitForFunction(() => document.querySelectorAll('.ytn-box[data-state="done"]').length >= 2, null, { timeout: 40000 }).catch(() => {});
await p3.waitForTimeout(1500);
const japanese = await p3.evaluate(() => {
  const done = [...document.querySelectorAll('.ytn-box[data-state="done"]')];
  return {
    styleAttr: document.documentElement.getAttribute('data-ytn-style'),
    boxBg: done.length ? getComputedStyle(done[0]).backgroundColor : null,
    kana: done.filter((b) => /[぀-ヿ]/.test(b.querySelector('.ytn-text')?.textContent || '')).length,
    samples: done.slice(0, 2).map((b) => (b.querySelector('.ytn-text')?.textContent || '').slice(0, 50)),
    sourceHidden: done.filter((b) => b.closest('ytd-comment-view-model').classList.contains('ytn-hide-source')).length,
    nativeAttr: document.documentElement.hasAttribute('data-ytn-hide-native'),
    nativeVisible: [...document.querySelectorAll('ytd-comments .translate-button')].filter((b) => getComputedStyle(b).display !== 'none').length,
  };
});
step('7. 换目标语言(ja)+卡片外观', { apiCalls, ...japanese });
await p3.screenshot({ path: path.join(OUT, '5-ja-card.png') });

// 8. dark theme (YouTube follows prefers-color-scheme)
const p4 = await context.newPage();
await p4.emulateMedia({ colorScheme: 'dark' });
p4.on('pageerror', (e) => report.errors.push('pageerror(dark): ' + String(e.message).slice(0, 160)));
p4.on('request', (req) => { if (/perform_comment_action/.test(req.url())) apiCalls++; });
await p4.goto(`https://www.youtube.com/watch?v=${VID}&hl=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await p4.waitForTimeout(2500);
await p4.evaluate(() => document.querySelector('ytd-comments#comments')?.scrollIntoView({ block: 'start' }));
for (let i = 0; i < 6; i++) { await p4.mouse.wheel(0, 1300); await p4.waitForTimeout(800); }
await p4.waitForFunction(() => document.querySelectorAll('.ytn-box[data-state="done"]').length >= 2, null, { timeout: 40000 }).catch(() => {});
const darkState = await p4.evaluate(() => {
  const done = document.querySelector('.ytn-box[data-state="done"]');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', code: 'KeyS', altKey: true, shiftKey: true, bubbles: true }));
  const panel = document.querySelector('.ytn-panel');
  const out = {
    theme: document.documentElement.getAttribute('data-ytn-theme'),
    boxColor: done ? getComputedStyle(done).color : null,
    boxBorder: done ? getComputedStyle(done).borderLeftColor : null,
    panelBg: panel ? getComputedStyle(panel).backgroundColor : null,
    kana: null,
  };
  return out;
});
step('8. 深色主题', { ...darkState, cjk: await p4.evaluate(() => [...document.querySelectorAll('.ytn-box[data-state="done"] .ytn-text')].filter((t) => /[一-鿿]/.test(t.textContent)).length) });
await p4.screenshot({ path: path.join(OUT, '6-dark.png') });

report.errors = [...new Set(report.errors)];
report.apiCalls = apiCalls;
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
console.log('\n===== SUMMARY =====');
console.log('total perform_comment_action calls: ' + apiCalls);
console.log('errors: ' + (report.errors.length ? '\n  ' + report.errors.join('\n  ') : 'none'));
await context.close();
