// Third pass: real mouse click on the native translate button, capture the
// perform_comment_action request/response and dump comment DOM structure.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'capture3');
const argv = process.argv.slice(2);
const VID = argv.find((a) => !a.startsWith('--')) || 'dQw4w9WgXcQ';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'bodies'), { recursive: true });

const cookies = [];
for (const part of fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim().split(/;\s*/)) {
  const eq = part.indexOf('=');
  if (eq <= 0) continue;
  for (const domain of ['.youtube.com', '.google.com']) cookies.push({ name: part.slice(0, eq), value: part.slice(eq + 1), domain, path: '/', secure: part.slice(0, eq).startsWith('__Secure-'), sameSite: 'None' });
}

const records = [];
const byUrl = new Map();
let seq = 0, marker = -1;

function decode(buf, headers) {
  if (!buf || !buf.length) return null;
  const enc = String(headers['content-encoding'] || '');
  try {
    if (/gzip/i.test(enc) || (buf[0] === 0x1f && buf[1] === 0x8b)) buf = zlib.gunzipSync(buf);
    else if (/br/i.test(enc)) buf = zlib.brotliDecompressSync(buf);
  } catch { /* raw */ }
  const s = buf.toString('utf8');
  return s[0] === '{' || s[0] === '[' ? s : `<binary ${buf.length}B ${buf.subarray(0, 6).toString('hex')} ${s.slice(0, 400)}>`;
}

const context = await chromium.launchPersistentContext(path.join(HERE, 'profile3'), {
  headless: !argv.includes('--headed'),
  viewport: { width: 1400, height: 950 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  args: ['--lang=zh-CN', '--disable-features=Translate'],
});
await context.addCookies(cookies);
const page = context.pages()[0] ?? (await context.newPage());

page.on('request', async (req) => {
  const url = req.url();
  const t = req.resourceType();
  if (!['xhr', 'fetch'].includes(t) && !/perform_comment_action/.test(url)) return;
  if (/log_event|generate_204|api\/stats|googlevideo|doubleclick/.test(url)) return;
  const headers = await req.allHeaders().catch(() => ({}));
  let buf = null;
  try { buf = await req.postDataBuffer(); } catch { buf = null; }
  const rec = { id: ++seq, method: req.method(), url, headers, postData: decode(buf, headers), afterClick: false };
  records.push(rec);
  byUrl.set(url, rec);
});

page.on('response', async (res) => {
  const rec = byUrl.get(res.url());
  if (!rec || rec.status) return;
  rec.status = res.status();
  try {
    const buf = await res.body().catch(() => null);
    if (!buf) return;
    rec.bodyBytes = buf.length;
    const text = buf.toString('utf8');
    const base = path.join(OUT, 'bodies', `${rec.id}`);
    if (text[0] === '{') fs.writeFileSync(`${base}.json`, JSON.stringify(JSON.parse(text), null, 1));
    else fs.writeFileSync(`${base}.txt`, text.slice(0, 300000));
  } catch (e) { rec.bodyError = String(e.message).slice(0, 90); }
});

await page.goto(`https://www.youtube.com/watch?v=${VID}&hl=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(2500);
for (const b of await page.$$('tp-yt-paper-dialog button, yt-button-shape button')) {
  const t = ((await b.textContent().catch(() => '')) || '').trim();
  if (/^(接受全部|我同意|Accept all|Reject all)$/i.test(t)) { await b.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(1000); }
}
await page.evaluate(() => document.querySelector('ytd-comments#comments')?.scrollIntoView({ block: 'start' }));
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 1400); await page.waitForTimeout(800); }

const dom = await page.evaluate(() => {
  const vm = document.querySelector('ytd-comment-view-model');
  const btn = [...document.querySelectorAll('ytd-comment-view-model .translate-button')].find((b) => !b.hasAttribute('hidden'));
  return {
    commentVMHtml: vm ? vm.outerHTML.slice(0, 26000) : null,
    buttonText: btn ? (btn.textContent || '').trim() : null,
    btnInner: btn ? btn.innerHTML.slice(0, 4000) : null,
    btnTag: btn ? btn.tagName : null,
    rect: btn ? btn.getBoundingClientRect().toJSON() : null,
  };
});
fs.writeFileSync(path.join(OUT, 'dom.json'), JSON.stringify(dom, null, 1));
console.log('button:', dom.buttonText, 'tag:', dom.btnTag, 'rect:', JSON.stringify(dom.rect));

if (dom.rect && dom.rect.width > 0) {
  const SEL = 'ytd-comment-view-model .translate-button:not([hidden]) tp-yt-paper-button';
  const handle = await page.$(SEL);
  if (!handle) console.log('!! no tp-yt-paper-button inside visible translate button');
  else {
    await handle.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(1000);
    const read = async () => handle.evaluate((el) => {
      const vm = el.closest('ytd-comment-view-model');
      return {
        btn: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        vmText: (vm?.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
        vmHtml: (vm?.outerHTML || '').slice(0, 40000),
      };
    });
    const before = await read();
    marker = seq;
    await handle.click({ timeout: 5000 }).catch((e) => console.log('click err', String(e.message).slice(0, 120)));
    await page.waitForTimeout(7000);
    const after = await read();
    fs.writeFileSync(path.join(OUT, 'after.json'), JSON.stringify({ before, after }, null, 1));
    console.log('BEFORE btn:', before.btn);
    console.log('BEFORE vm :', before.vmText.slice(0, 260));
    console.log('AFTER  btn:', after.btn);
    console.log('AFTER  vm :', after.vmText.slice(0, 260));
  }
}

for (const r of records) r.afterClick = marker >= 0 && r.id > marker;
fs.writeFileSync(path.join(OUT, 'full-records.json'), JSON.stringify(records, null, 1));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(records.map((r) => ({ id: r.id, method: r.method, url: r.url, status: r.status, afterClick: r.afterClick, postDataLen: r.postData?.length || 0, bodyBytes: r.bodyBytes, auth: r.headers?.authorization ? String(r.headers.authorization).slice(0, 260) : null })), null, 1));
console.log('after-click requests:');
for (const r of records.filter((x) => x.afterClick)) console.log(`  ${r.method} ${r.url.slice(0, 110)} status=${r.status}`);
const pca = records.find((r) => /perform_comment_action/.test(r.url));
if (pca) {
  console.log('\n*** perform_comment_action REQUEST BODY ***');
  console.log(String(pca.postData).slice(0, 1500));
  console.log('*** HEADERS ***');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(pca.headers).filter(([k]) => !/cookie|sec-|priority|accept/i.test(k))), null, 1));
  console.log('*** RESPONSE (id ' + pca.id + ') ***');
  const f = path.join(OUT, 'bodies', `${pca.id}.json`);
  if (fs.existsSync(f)) console.log(fs.readFileSync(f, 'utf8').slice(0, 3000));
} else console.log('!! no perform_comment_action request captured');
await page.screenshot({ path: path.join(OUT, 'screen.png') }).catch(() => {});
await context.close();
