// Error state must stay readable even when the global view is "original"
// (body collapsed) — tabs hide on error, retry stays visible.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'yt-native-translator.user.js'), 'utf8');
const VID = process.argv[2] || 'x8VYWazR5mE';
const OUT = path.join(HERE, 'ui-check');

const cookies = [];
for (const part of fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim().split(/;\s*/)) {
  const eq = part.indexOf('=');
  if (eq <= 0) continue;
  for (const domain of ['.youtube.com', '.google.com']) cookies.push({ name: part.slice(0, eq), value: part.slice(eq + 1), domain, path: '/', secure: part.slice(0, eq).startsWith('__Secure-'), sameSite: 'None' });
}

const context = await chromium.launchPersistentContext(path.join(HERE, 'profile-error-ui'), {
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
  localStorage.setItem('ytn_config_v1', JSON.stringify({ autoTranslate: true, hover: false, mode: 'original', style: 'quote', targetLang: 'zh-CN', takeoverNative: true }));
  localStorage.removeItem('ytn_cache_v1');
  localStorage.removeItem('ytn_mode_v1');
});
await seed.close();

const page = await context.newPage();
await page.route(/perform_comment_action/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":404}}' }));
await page.goto(`https://www.youtube.com/watch?v=${VID}&hl=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(2500);
await page.evaluate(() => document.querySelector('ytd-comments#comments')?.scrollIntoView({ block: 'start' }));
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(700); }
await page.waitForFunction(() => document.querySelectorAll('.ytn-box[data-state="error"]').length > 0, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(800);

const state = await page.evaluate(() => {
  const box = document.querySelector('.ytn-box[data-state="error"]');
  if (!box) return { found: false };
  box.scrollIntoView({ block: 'center' });
  const text = box.querySelector('.ytn-text');
  const tabs = box.querySelector('.ytn-tabs');
  const retry = box.querySelector('.ytn-retry');
  const wrap = box.querySelector('.ytn-body-wrap');
  return {
    found: true,
    view: box.dataset.view,
    bodyRows: getComputedStyle(wrap).gridTemplateRows,
    text: text?.textContent,
    textHeight: text?.getBoundingClientRect().height,
    tabsDisplay: tabs ? getComputedStyle(tabs).display : null,
    retryDisplay: retry ? getComputedStyle(retry).display : null,
  };
});
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, 'error-original.png') });
const ok = state.found && state.view === 'original' && state.bodyRows !== '0px' && state.textHeight > 0 && state.tabsDisplay === 'none' && state.retryDisplay !== 'none';
console.log(JSON.stringify(state));
console.log(ok ? 'PASS' : 'FAIL');
await context.close();
process.exit(ok ? 0 : 1);
