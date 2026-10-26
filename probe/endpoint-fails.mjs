// Force perform_comment_action to 404 and verify:
//  1) one failure no longer pauses everything for 30 minutes
//  2) per-comment error text is the new friendly one
//  3) 3 consecutive failures trip a 2-minute pause (toast + queue stops)
//  4) clicking 重试 resets the breaker and retries
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'yt-native-translator.user.js'), 'utf8');
const VID = process.argv[2] || 'x8VYWazR5mE';
const EXPECT = '原生翻译接口暂时不可用，点「重试」或稍后自动恢复';

const cookies = [];
for (const part of fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim().split(/;\s*/)) {
  const eq = part.indexOf('=');
  if (eq <= 0) continue;
  for (const domain of ['.youtube.com', '.google.com']) cookies.push({ name: part.slice(0, eq), value: part.slice(eq + 1), domain, path: '/', secure: part.slice(0, eq).startsWith('__Secure-'), sameSite: 'None' });
}

const context = await chromium.launchPersistentContext(path.join(HERE, 'profile-edge'), {
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
let reqs = 0;
await page.route(/perform_comment_action/, (route) => {
  reqs++;
  return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":404,"message":"Requested entity was not found."}}' });
});
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 180)); });

await page.goto(`https://www.youtube.com/watch?v=${VID}&hl=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.evaluate(() => {
  window.__toasts = [];
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && n.classList && n.classList.contains('ytn-toast')) window.__toasts.push(n.textContent);
    }
  }).observe(document.body, { childList: true, subtree: true });
});
await page.waitForTimeout(2500);
await page.evaluate(() => document.querySelector('ytd-comments#comments')?.scrollIntoView({ block: 'start' }));
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(700); }
await page.waitForTimeout(5000);

const snap = () => page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.ytn-box')];
  return {
    boxes: boxes.length,
    done: boxes.filter((b) => b.dataset.state === 'done').length,
    error: boxes.filter((b) => b.dataset.state === 'error').length,
    errTexts: [...new Set(boxes.filter((b) => b.dataset.state === 'error').map((b) => b.querySelector('.ytn-text')?.textContent))],
    toasts: window.__toasts || [],
  };
});

const phase1 = await snap();
const reqsPaused = reqs;
await page.waitForTimeout(3000);
const reqsAfterWait = reqs;
const pausedHolds = reqsAfterWait === reqsPaused;

const clicked = await page.evaluate(() => {
  const btn = document.querySelector('.ytn-box[data-state="error"] .ytn-retry');
  if (!btn) return false;
  btn.click();
  return true;
});
await page.waitForTimeout(1500);
const phase2 = await snap();

console.log('phase1', JSON.stringify({ ...phase1, reqs }));
console.log('pause  held=' + pausedHolds, 'reqs=' + reqsAfterWait);
console.log('phase2', JSON.stringify({ ...phase2, reqs, clicked }));

const errOk = phase1.errTexts.length === 1 && phase1.errTexts[0] === EXPECT;
const toastOk = phase1.toasts.some((t) => /连续失败/.test(t));
const retryOk = clicked && reqs > reqsAfterWait && phase2.error >= 1;
const pass = errOk && phase1.error >= 1 && toastOk && pausedHolds && retryOk;
console.log('CHECK errText=' + errOk + ' toast=' + toastOk + ' pauseHeld=' + pausedHolds + ' retry=' + retryOk);
console.log(pass ? 'PASS' : 'FAIL');
await context.close();
process.exit(pass ? 0 : 1);
