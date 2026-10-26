// UI/UX regression: no floating launcher, native translate button hidden,
// footer view switch scoped per comment, settings via Alt+Shift+S.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'yt-native-translator.user.js'), 'utf8');
const VID = process.argv[2] || 'x8VYWazR5mE';
const OUT = path.join(HERE, 'ui-check');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const cookies = [];
for (const part of fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim().split(/;\s*/)) {
  const eq = part.indexOf('=');
  if (eq <= 0) continue;
  for (const domain of ['.youtube.com', '.google.com']) cookies.push({ name: part.slice(0, eq), value: part.slice(eq + 1), domain, path: '/', secure: part.slice(0, eq).startsWith('__Secure-'), sameSite: 'None' });
}

const context = await chromium.launchPersistentContext(path.join(HERE, 'profile-ui'), {
  headless: true,
  viewport: { width: 1320, height: 1000 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  args: ['--lang=zh-CN', '--disable-features=Translate'],
});
await context.addCookies(cookies);
await context.addInitScript({ content: SCRIPT });

const seed = await context.newPage();
await seed.goto('https://www.youtube.com/?persist_configs=1', { waitUntil: 'domcontentloaded', timeout: 90000 });
await seed.evaluate(() => {
  localStorage.setItem('ytn_config_v1', JSON.stringify({ autoTranslate: true, hover: false, mode: 'bilingual', style: 'quote', targetLang: 'zh-CN', takeoverNative: true }));
  localStorage.removeItem('ytn_cache_v1');
  localStorage.removeItem('ytn_mode_v1');
});
await seed.close();

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
await page.goto(`https://www.youtube.com/watch?v=${VID}&hl=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(2500);
await page.evaluate(() => document.querySelector('ytd-comments#comments')?.scrollIntoView({ block: 'start' }));
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(700); }
await page.waitForFunction(() => document.querySelectorAll('.ytn-box[data-state="done"]').length >= 3, null, { timeout: 45000 }).catch(() => {});
await page.waitForTimeout(1500);

const layout = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.ytn-box[data-state="done"]')];
  const b = boxes[0];
  const note = b?.querySelector('.ytn-note');
  const tabs = b?.querySelector('.ytn-tabs');
  const native = [...document.querySelectorAll('ytd-comments .translate-button')];
  const br = note?.querySelector('.ytn-brand')?.getBoundingClientRect();
  const tr = tabs?.getBoundingClientRect();
  return {
    noLauncher: !document.querySelector('.ytn-launcher'),
    nativeTotal: native.length,
    nativeVisible: native.filter((x) => getComputedStyle(x).display !== 'none').length,
    boxes: boxes.length,
    noteRows: b ? getComputedStyle(b).display + '/' + getComputedStyle(note).display : null,
    tabsInNote: !!tabs && tabs.parentElement === note,
    tabsVisible: tabs ? getComputedStyle(tabs).display !== 'none' : null,
    tabsInline: br && tr ? tr.left - br.right >= 0 && tr.left - br.right <= 24 : null,
    tabLabels: tabs ? [...tabs.querySelectorAll('.ytn-tab')].map((t) => t.textContent) : [],
    brand: note?.querySelector('.ytn-brand')?.textContent || null,
  };
});

const scoped = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.ytn-box[data-state="done"]')];
  const a = boxes[0];
  const b = boxes[1];
  a.querySelector('.ytn-tab[data-view="translation"]').click();
  const out = {
    aView: a.dataset.view,
    aHidden: a.closest('ytd-comment-view-model').classList.contains('ytn-hide-source'),
    aAria: a.querySelector('.ytn-tab[data-view="translation"]').getAttribute('aria-pressed'),
    bView: b.dataset.view,
    stored: localStorage.getItem('ytn_mode_v1'),
  };
  a.querySelector('.ytn-tab[data-view="bilingual"]').click();
  out.aBack = a.dataset.view;
  return out;
});

await page.evaluate(() => {
  const b = document.querySelector('.ytn-box[data-state="done"]');
  b.querySelector('.ytn-tab[data-view="original"]').click();
  b.scrollIntoView({ block: 'center' });
});
await page.waitForTimeout(350);
await page.screenshot({ path: path.join(OUT, 'original.png') });
await page.evaluate(() => document.querySelector('.ytn-box[data-state="done"] .ytn-tab[data-view="bilingual"]').click());

let panel = { opened: false };
await page.evaluate(() => document.body.focus());
await page.keyboard.down('Alt');
await page.keyboard.down('Shift');
await page.keyboard.press('KeyS');
await page.keyboard.up('Shift');
await page.keyboard.up('Alt');
await page.waitForTimeout(500);
panel = await page.evaluate(() => {
  const overlay = document.querySelector('.ytn-overlay');
  if (!overlay) return { opened: false };
  const row = [...overlay.querySelectorAll('.ytn-row')].find((r) => /隐藏原生/.test(r.textContent));
  const before = [...document.querySelectorAll('ytd-comments .translate-button')].filter((x) => getComputedStyle(x).display !== 'none').length;
  row?.querySelector('.ytn-switch')?.click();
  const off = [...document.querySelectorAll('ytd-comments .translate-button')].filter((x) => getComputedStyle(x).display !== 'none').length;
  row?.querySelector('.ytn-switch')?.click();
  const on = [...document.querySelectorAll('ytd-comments .translate-button')].filter((x) => getComputedStyle(x).display !== 'none').length;
  return { opened: true, label: row?.querySelector('.ytn-row-name')?.textContent || '', before, off, on };
});
await page.screenshot({ path: path.join(OUT, 'panel.png') });
await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
await page.waitForTimeout(400);

const first = await page.evaluate(() => {
  const b = document.querySelector('.ytn-box[data-state="done"]');
  b?.scrollIntoView({ block: 'center' });
  return !!b;
});
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'comments.png') });

const ok = layout.noLauncher && layout.nativeTotal > 0 && layout.nativeVisible === 0 && layout.tabsInNote && layout.tabsVisible && layout.tabsInline && layout.tabLabels.length === 3 &&
  scoped.aView === 'translation' && scoped.aHidden && scoped.aAria === 'true' && scoped.bView === 'bilingual' && scoped.aBack === 'bilingual' &&
  panel.opened && panel.off > 0 && panel.on === 0 && first;
console.log('layout  ', JSON.stringify(layout));
console.log('scoped  ', JSON.stringify(scoped));
console.log('panel   ', JSON.stringify(panel));
console.log('errors  ', JSON.stringify(errors));
console.log(ok ? 'PASS' : 'FAIL');
await context.close();
process.exit(ok ? 0 : 1);
