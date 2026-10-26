// Simulate the page client context being rejected (404 when visitorData is
// present) and verify the script retries once with the compat context and
// succeeds without showing any error box.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'yt-native-translator.user.js'), 'utf8');
const VID = process.argv[2] || 'x8VYWazR5mE';

const cookies = [];
for (const part of fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim().split(/;\s*/)) {
  const eq = part.indexOf('=');
  if (eq <= 0) continue;
  for (const domain of ['.youtube.com', '.google.com']) cookies.push({ name: part.slice(0, eq), value: part.slice(eq + 1), domain, path: '/', secure: part.slice(0, eq).startsWith('__Secure-'), sameSite: 'None' });
}

const context = await chromium.launchPersistentContext(path.join(HERE, 'profile-heal'), {
  headless: true,
  viewport: { width: 1320, height: 900 },
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
const log = [];
await page.route(/perform_comment_action/, (route) => {
  let visitor = '';
  try { visitor = (JSON.parse(route.request().postData()).context.client.visitorData || ''); } catch (e) { /* ignore */ }
  if (visitor) {
    log.push({ rejected: true });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":404,"message":"Requested entity was not found."}}' });
  }
  log.push({ rejected: false });
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ frameworkUpdates: { entityBatchUpdate: { mutations: [{ payload: { commentEntityPayload: { translatedContent: { content: '兼容上下文译文' } } } }] } } }),
  });
});

await page.goto(`https://www.youtube.com/watch?v=${VID}&hl=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(2500);
await page.evaluate(() => document.querySelector('ytd-comments#comments')?.scrollIntoView({ block: 'start' }));
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(700); }
await page.waitForTimeout(4000);

const state = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.ytn-box')];
  return {
    boxes: boxes.length,
    done: boxes.filter((b) => b.dataset.state === 'done').length,
    error: boxes.filter((b) => b.dataset.state === 'error').length,
    texts: [...new Set(boxes.map((b) => b.querySelector('.ytn-text')?.textContent))].slice(0, 3),
  };
});
const firstReject = log.findIndex((x) => !x.rejected);
const pass = state.boxes > 0 && state.done === state.boxes && state.error === 0 && state.texts[0] === '兼容上下文译文' && log.length > 1 && log[0].rejected && firstReject > 0;
console.log('requests', JSON.stringify(log.slice(0, 6)), 'total=' + log.length);
console.log('state', JSON.stringify(state));
console.log(pass ? 'PASS' : 'FAIL');
await context.close();
process.exit(pass ? 0 : 1);
