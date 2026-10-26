// Deterministic check of the dark-theme branch: force the sampled comment text
// color to white, then re-probe by opening the panel.
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

const context = await chromium.launchPersistentContext(path.join(HERE, 'profile7'), { headless: true, viewport: { width: 1280, height: 860 }, locale: 'zh-CN', args: ['--lang=zh-CN'] });
await context.addCookies(cookies);
await context.addInitScript({ content: SCRIPT });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + String(e.message).slice(0, 200)));
await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ&hl=zh-CN', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.querySelector('ytd-comments#comments')?.scrollIntoView({ block: 'start' }));
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 1300); await page.waitForTimeout(800); }
await page.waitForFunction(() => document.querySelectorAll('.ytn-box').length > 0, null, { timeout: 40000 }).catch(() => {});

const before = await page.evaluate(() => ({ theme: document.documentElement.getAttribute('data-ytn-theme'), fg: getComputedStyle(document.documentElement).getPropertyValue('--ytn-fg').trim() }));

const after = await page.evaluate(async () => {
  const st = document.createElement('style');
  st.textContent = 'ytd-comment-view-model #content-text, ytd-comment-view-model{color:#fff!important} ytd-comments#comments{background:#0f0f0f!important}';
  document.head.appendChild(st);
  await new Promise((r) => setTimeout(r, 1300));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', code: 'KeyS', altKey: true, shiftKey: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const panel = document.querySelector('.ytn-panel');
  const box = document.querySelector('.ytn-box[data-state="done"]');
  return {
    theme: document.documentElement.getAttribute('data-ytn-theme'),
    fg: getComputedStyle(document.documentElement).getPropertyValue('--ytn-fg').trim(),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--ytn-accent').trim(),
    panelBg: panel ? getComputedStyle(panel).backgroundColor : null,
    panelColor: panel ? getComputedStyle(panel).color : null,
    boxColor: box ? getComputedStyle(box).color : null,
    tabColor: panel ? getComputedStyle(panel.querySelector('.ytn-seg-btn.is-on')).color : null,
  };
});
console.log('light (before forcing):', JSON.stringify(before));
console.log('after forcing white text:', JSON.stringify(after));
await page.screenshot({ path: path.join(HERE, 'verify', 'theme-dark-branch.png') }).catch(() => {});
await context.close();
