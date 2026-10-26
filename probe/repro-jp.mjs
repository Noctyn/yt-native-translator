// Reproduce the "endpoint changed" error on a Japanese video and capture the
// exact perform_comment_action requests/responses.
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

function readVarint(b, i) {
  let r = 0n, shift = 1n;
  for (;;) {
    const c = b[i];
    if (c === undefined) throw new Error('truncated');
    i++;
    r |= BigInt(c & 0x7f) * shift;
    if (!(c & 0x80)) break;
    shift <<= 7n;
  }
  return [r, i];
}

function fields(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    let key; [key, i] = readVarint(b, i);
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (wire === 0) { let v; [v, i] = readVarint(b, i); out.push({ field, wire, v }); }
    else if (wire === 2) { let len; [len, i] = readVarint(b, i); const n = Number(len); out.push({ field, wire, bytes: b.subarray(i, i + n) }); i += n; }
    else throw new Error('wire ' + wire);
  }
  return out;
}

function decodeAction(token) {
  try {
    const b64 = decodeURIComponent(token).replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='), 'base64');
    const top = fields(buf);
    const f31 = top.find((f) => f.field === 31);
    if (!f31) return { error: 'no f31' };
    const inner = fields(f31.bytes);
    const commentId = (inner.find((f) => f.field === 2) || {}).bytes;
    const f3 = (inner.find((f) => f.field === 3) || {}).bytes;
    const dst = (inner.find((f) => f.field === 4) || {}).bytes;
    let text = null;
    if (f3) {
      const a = fields(f3).find((f) => f.field === 1);
      if (a) {
        const b = fields(a.bytes).find((f) => f.field === 1);
        if (b) text = b.bytes.toString('utf8');
      }
    }
    return {
      commentId: commentId && commentId.toString('utf8'),
      lang: dst && dst.toString('utf8'),
      text: text && text.slice(0, 50),
      textBytes: text ? Buffer.byteLength(text) : 0,
    };
  } catch (e) { return { error: String(e.message) }; }
}

const context = await chromium.launchPersistentContext(path.join(HERE, 'profile-jp'), {
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
const seen = [];
page.on('request', (req) => {
  if (!/perform_comment_action/.test(req.url())) return;
  const body = req.postData();
  if (body) { try { seen.push({ kind: 'req', action: decodeAction(JSON.parse(body).actions[0]) }); } catch (e) { /* ignore */ } }
});
page.on('response', async (res) => {
  if (!/perform_comment_action/.test(res.url())) return;
  const rec = { kind: 'res', status: res.status() };
  try { rec.body = (await res.text()).slice(0, 400); } catch (e) { rec.body = 'ERR ' + e.message; }
  seen.push(rec);
  console.log('RESP', rec.status, rec.body.replace(/\s+/g, ' ').slice(0, 240));
});
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });

await page.goto(`https://www.youtube.com/watch?v=${VID}&hl=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.querySelector('ytd-comments#comments')?.scrollIntoView({ block: 'start' }));
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 1000); await page.waitForTimeout(800); }
await page.waitForTimeout(4000);

const state = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.ytn-box')];
  return {
    vms: document.querySelectorAll('ytd-comment-view-model').length,
    boxes: boxes.length,
    done: boxes.filter((b) => b.dataset.state === 'done').length,
    error: boxes.filter((b) => b.dataset.state === 'error').length,
    errTexts: [...new Set(boxes.filter((b) => b.dataset.state === 'error').map((b) => b.querySelector('.ytn-text')?.textContent))].slice(0, 4),
    cjk: boxes.filter((b) => b.dataset.state === 'done' && /[一-鿿]/.test(b.querySelector('.ytn-text')?.textContent || '')).length,
    samples: [...document.querySelectorAll('ytd-comment-view-model')].slice(0, 3).map((vm) => ({
      text: (vm.querySelector('#content-text')?.textContent || '').slice(0, 40),
      lc: [...vm.querySelectorAll('a[href*="lc="]')].map((a) => a.getAttribute('href')).slice(0, 1),
    })),
  };
});
console.log('STATE', JSON.stringify(state));
console.log('TRAFFIC');
for (const r of seen) console.log(JSON.stringify(r).slice(0, 400));
fs.writeFileSync(path.join(HERE, 'repro-jp.json'), JSON.stringify({ vid: VID, state, seen }, null, 1));
await context.close();
