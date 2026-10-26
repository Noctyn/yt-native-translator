// Long-comment chunking: inflate one comment's DOM text past CHUNK_CHARS and
// check the assembled translation keeps the whole content.
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

const context = await chromium.launchPersistentContext(path.join(HERE, 'profile9'), { headless: true, viewport: { width: 1280, height: 860 }, locale: 'zh-CN', args: ['--lang=zh-CN'] });
await context.addCookies(cookies);
await context.addInitScript({ content: SCRIPT });
const seeder = await context.newPage();
await seeder.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded', timeout: 90000 });
await seeder.evaluate(() => localStorage.setItem('ytn_config_v1', JSON.stringify({ autoTranslate: false, hover: false, mode: 'bilingual', targetLang: 'zh-CN', persistCache: false })));

const page = await context.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
let calls = 0;
page.on('request', (r) => { if (/perform_comment_action/.test(r.url())) calls++; });
await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ&hl=zh-CN', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.querySelector('ytd-comments#comments')?.scrollIntoView({ block: 'start' }));
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 1300); await page.waitForTimeout(700); }

const prepared = await page.evaluate(() => {
  const vm = [...document.querySelectorAll('ytd-comment-view-model')].find((v) => !v.querySelector('.ytn-box'));
  const node = vm.querySelector('#content-text');
  const para = (n) => `Paragraph ${n}: this video is a classic, every time it shows up in my feed I stop and watch it to the end.`;
  const text = Array.from({ length: 14 }, (_, i) => para(i + 1) + ` END${i + 1}`).join('\n');
  const span = node.querySelector('span') || node;
  span.textContent = text;
  vm.dataset.ytnTestTarget = '1';
  return { chars: text.length, markerLastLine: text.split('\n').pop().slice(-8) };
});
await page.evaluate(() => {
  const vm = document.querySelector('ytd-comment-view-model[data-ytn-test-target="1"]');
  vm.querySelector('.translate-button tp-yt-paper-button')?.click();
});
await page.waitForTimeout(12000);

const result = await page.evaluate(() => {
  const vm = document.querySelector('ytd-comment-view-model[data-ytn-test-target="1"]');
  const box = vm.querySelector('.ytn-box');
  const t = box?.querySelector('.ytn-text')?.textContent || '';
  return {
    state: box?.dataset.state,
    outChars: t.length,
    sentences: (t.match(/[。！？]/g) || []).length,
    digits: [...new Set((t.match(/[1-8]/g) || []))].sort().join(''),
    head: t.slice(0, 50),
    tail: t.slice(-50),
  };
});
console.log('input:', JSON.stringify(prepared));
console.log('output:', JSON.stringify(result), 'apiCalls=' + calls);
console.log('errors:', errs.length ? errs : 'none');
await page.screenshot({ path: path.join(HERE, 'verify', 'long-comment.png') }).catch(() => {});
await context.close();
