// Probe the limits of the native endpoint: is commentId required, can arbitrary
// or long text be translated, which target languages work.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKIES = fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const browserBody = JSON.parse(fs.readFileSync(path.join(HERE, 'pca-body.json'), 'utf8'));

function varint(n) {
  let x = BigInt(n);
  const o = [];
  do {
    let b = Number(x & 0x7fn);
    x >>= 7n;
    if (x > 0n) b |= 0x80;
    o.push(b);
  } while (x > 0n);
  return Buffer.from(o);
}
function tag(f, w) { return varint((BigInt(f) << 3n) | BigInt(w)); }
function fVar(f, v) { return Buffer.concat([tag(f, 0), varint(v)]); }
function fLen(f, d) {
  const b = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8');
  return Buffer.concat([tag(f, 2), varint(b.length), b]);
}
function b64url(b) { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function action(o) {
  const parts = [];
  if (!o.omitId) parts.push(fLen(2, o.commentId || 'Ugw1tpIYg_PAwdPneep4AaABAg'));
  if (!o.omitText) parts.push(fLen(3, fLen(1, fLen(1, o.text))));
  parts.push(fLen(4, o.dstLang || 'zh-CN'));
  parts.push(fVar(5, 0));
  return b64url(Buffer.concat([fVar(1, o.type === undefined ? 22 : o.type), fLen(31, Buffer.concat(parts))]));
}

const ctx = {
  client: { hl: 'zh-CN', gl: 'US', clientName: 'WEB', clientVersion: '2.20261023.01.00', visitorData: browserBody.context.client.visitorData },
  user: { lockedSafetyMode: false },
  request: { useSsl: true, consistencyTokenJars: [] },
};

function run(label, act) {
  const body = JSON.stringify({ context: ctx, actions: [act] });
  const out = execFileSync('curl', ['-sS', '--compressed', '-H', 'Cookie: ' + COOKIES, '-H', 'User-Agent: ' + UA, '-H', 'Content-Type: application/json',
    '-H', 'Origin: https://www.youtube.com', '-H', 'Referer: https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    '-X', 'POST', '-w', '\\n@@%{http_code}', '-d', body,
    'https://www.youtube.com/youtubei/v1/comment/perform_comment_action?prettyPrint=false'], { maxBuffer: 1 << 26, encoding: 'utf8' });
  const idx = out.lastIndexOf('\n@@');
  const text = out.slice(0, idx);
  const code = out.slice(idx + 3);
  let res = null;
  try { res = JSON.parse(text); } catch { /* noop */ }
  const m = res?.frameworkUpdates?.entityBatchUpdate?.mutations?.[0]?.payload?.commentEntityPayload;
  const got = m?.translatedContent?.content;
  const note = got ? 'OK   ' + JSON.stringify(got).slice(0, 80) : 'EMPTY ' + String(res?.error?.message || JSON.stringify(m || {})).slice(0, 80);
  console.log(label.padEnd(24) + ' http=' + code + '  ' + note);
}

const long = 'This is a stress test. '.repeat(60);
const veryLong = 'Comment words add up quickly when people argue about nothing at all. '.repeat(120);

run('baseline', action({ text: 'hello world, this is a test comment' }));
run('no commentId', action({ omitId: true, text: 'hello world, no id here' }));
run('fake commentId', action({ commentId: 'UgzFAKESAFAKESAFAKESAFAKESA', text: 'fake id but real text' }));
run('mismatched text->en', action({ text: 'totally different text than the actual comment', dstLang: 'en' }));
run('no text (id only)', action({ omitText: true }));
run('zh->en', action({ text: '今天天气很好，评论里的人在吵架。', dstLang: 'en' }));
run('en->ja', action({ text: 'The comment section is on fire today', dstLang: 'ja' }));
run('en->zh-TW', action({ text: 'The comment section is on fire today', dstLang: 'zh-TW' }));
run('en->ru', action({ text: 'The comment section is on fire today', dstLang: 'ru' }));
run('en->xx invalid', action({ text: 'The comment section is on fire today', dstLang: 'xx' }));
run('en->"" empty', action({ text: 'The comment section is on fire today', dstLang: '' }));
run('long ' + long.length, action({ text: long }));
run('verylong ' + veryLong.length, action({ text: veryLong }));
run('emoji+newline', action({ text: 'first line\nsecond line 🎉🎉 tab\tend' }));
run('type=0', action({ text: 'does action type matter', type: 0 }));
run('type=1', action({ text: 'does action type matter', type: 1 }));
run('type=3', action({ text: 'does action type matter', type: 3 }));
