// Inspect the DOM around the native "Translate to …" button inside comments.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VID = process.argv[2] || 'x8VYWazR5mE';
const cookies = [];
for (const part of fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim().split(/;\s*/)) {
  const eq = part.indexOf('=');
  if (eq <= 0) continue;
  for (const domain of ['.youtube.com', '.google.com']) cookies.push({ name: part.slice(0, eq), value: part.slice(eq + 1), domain, path: '/', secure: part.slice(0, eq).startsWith('__Secure-'), sameSite: 'None' });
}

const context = await chromium.launchPersistentContext(path.join(HERE, 'profile-inspect'), {
  headless: true,
  viewport: { width: 1320, height: 900 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  args: ['--lang=zh-CN', '--disable-features=Translate'],
});
await context.addCookies(cookies);
const page = await context.newPage();
await page.goto(`https://www.youtube.com/watch?v=${VID}&hl=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.querySelector('ytd-comments#comments')?.scrollIntoView({ block: 'start' }));
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(700); }
await page.waitForTimeout(3000);

const out = await page.evaluate(() => {
  const hits = [];
  const walker = document.createTreeWalker(document.querySelector('ytd-comments') || document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = (n.textContent || '').trim();
    if (!/^翻译成/.test(t)) continue;
    let el = n.parentElement;
    const chain = [];
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
      chain.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: String(el.className || '').slice(0, 120),
        role: el.getAttribute('role') || '',
        aria: el.getAttribute('aria-label') || '',
      });
    }
    let host = n.parentElement;
    for (let i = 0; host && !host.matches('ytd-comment-view-model, ytd-comment-renderer'); i++) host = host.parentElement;
    hits.push({ text: t, chain, host: host ? host.localName : null, hostId: host ? host.getAttribute('id') : null, outer: (n.parentElement.closest('button, ytd-button-renderer, yt-button-shape, ytd-tri-state-button-view-model') || n.parentElement).outerHTML.slice(0, 500) });
    if (hits.length >= 3) break;
  }
  return { vms: document.querySelectorAll('ytd-comment-view-model').length, hits };
});
console.log(JSON.stringify(out, null, 1));
await context.close();
