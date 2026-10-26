// Reproduce the native comment translation with cURL, narrowing the minimum
// request requirements, and verify the SAPISIDHASH algorithm.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKIES = fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const browserBody = JSON.parse(fs.readFileSync(path.join(HERE, 'pca-body.json'), 'utf8'));
const capturedAction = browserBody.actions[0];

function varint(n) { let x = BigInt(n), out = []; do { let b = Number(x & 0x7fn); x >>= 7n; if (x > 0n) b |= 0x80; out.push(b); } while (x > 0n); return Buffer.from(out); }
function tag(f, w) { return varint((BigInt(f) << 3n) | BigInt(w)); }
function fVar(f, v) { return Buffer.concat([tag(f, 0), varint(v)]); }
function fLen(f, d) { const b = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8'); return Buffer.concat([tag(f, 2), varint(b.length), b]); }
function b64url(b) { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function buildAction({ commentId, text, dstLang, actionType = 22 }) {
  return b64url(Buffer.concat([fVar(1, actionType), fLen(31, Buffer.concat([fLen(2, commentId), fLen(3, fLen(1, fLen(1, text))), fLen(4, dstLang), fVar(5, 0)]))]));
}

// --- SAPISIDHASH check against the captured header value
const cookieVal = (n) => (COOKIES.match(new RegExp('(?:^|;\\s)' + n + '=([^;]+)')) || [])[1];
const ts = '1792981953', expect = 'fa39c2ca5a766f4b8ad5d5d37a0a01d3018a2487';
const origin = 'https://www.youtube.com';
const trials = [];
for (const cn of ['SAPISID', '__Secure-1PSAPISID', '__Secure-3PAPISID', 'HSID', 'SSID', 'APISID']) {
  const v = cookieVal(cn);
  if (!v) continue;
  const inputs = {
    'std \\t cookie \\t origin \\t ts': `\t${v}\t${origin}\t${ts}`,
    'no leading tab': `${v}\t${origin}\t${ts}`,
    'origin first': `\t${origin}\t${v}\t${ts}`,
  };
  for (const [label, input] of Object.entries(inputs)) {
    const h = crypto.createHash('sha1').update(input).digest('hex');
    trials.push({ cookie: cn, formula: label, match: h === expect, hash: h.slice(0, 12) });
  }
}
console.log('=== SAPISIDHASH candidate check (expect ' + expect.slice(0, 12) + '…) ===');
for (const t of trials) if (t.match) console.log('MATCH  ', t.cookie, '|', t.formula);
console.log('non-matching tried:', trials.filter((t) => !t.match).length);

const minContext = (lang) => ({
  client: { hl: lang, gl: 'US', clientName: 'WEB', clientVersion: '2.20261023.01.00', visitorData: browserBody.context.client.visitorData, userAgent: UA + ',gzip(gfe)', originalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  user: { lockedSafetyMode: false },
  request: { useSsl: true, internalExperimentFlags: [], consistencyTokenJars: [] },
});

function authHeader() {
  const s = cookieVal('SAPISID');
  const t = Math.floor(Date.now() / 1000);
  const h = crypto.createHash('sha1').update(`\t${s}\t${origin}\t${t}`).digest('hex');
  return `SAPISIDHASH ${t}_${h}_u SAPISID1PHASH ${t}_${h}_u SAPISID3PHASH ${t}_${h}_u`;
}

function call(label, body, { auth = false } = {}) {
  const args = ['-sS', '--compressed', '-H', `Cookie: ${COOKIES}`, '-H', `User-Agent: ${UA}`, '-H', 'Content-Type: application/json',
    '-H', 'Origin: https://www.youtube.com', '-H', 'Referer: https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    '-H', 'x-goog-visitor-id: ' + browserBody.context.client.visitorData, '-H', 'x-youtube-client-name: 1', '-H', 'x-youtube-client-version: 2.20261023.01.00',
    '-H', 'x-goog-authuser: 0', '-X', 'POST',
    '-w', '\\n@@%{http_code}',
    '-d', JSON.stringify(body),
    'https://www.youtube.com/youtubei/v1/comment/perform_comment_action?prettyPrint=false'];
  if (auth) args.splice(4, 0, '-H', 'Authorization: ' + authHeader());
  const out = execFileSync('curl', args, { maxBuffer: 1 << 26, encoding: 'utf8' });
  const [text, code] = out.split('\n@@');
  fs.writeFileSync(path.join(HERE, `tr-${label}.json`), text);
  let j = null; try { j = JSON.parse(text); } catch { /* non json */ }
  const muts = j?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
  const translated = [];
  (function walk(n, p) { if (!n || typeof n !== 'object') return; for (const [k, v] of Object.entries(n)) { if (/translated|translation/i.test(k) && typeof v === 'string') translated.push(p + '.' + k + ' = ' + v.slice(0, 90)); if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}.${k}[${i}]`)); else if (v && typeof v === 'object') walk(v, `${p}.${k}`); } })(j || {}, '');
  console.log(`\n##### ${label} (auth=${auth}) http=${code} bytes=${text.length} mutations=${muts.length}`);
  if (!muts.length && code !== '200') console.log('   err: ' + String(j?.error?.message || text).slice(0, 160));
  for (const t of translated.slice(0, 6)) console.log('   ' + t);
  if (!translated.length) console.log('   payload kinds: ' + muts.map((m) => Object.keys(m.payload || {})[0]).join(','));
}

const synthJa = buildAction({ commentId: 'Ugw1tpIYg_PAwdPneep4AaABAg', text: 'i love how everyone just got summoned here now for the same reason', dstLang: 'ja' });
const synthKo = buildAction({ commentId: 'Ugw1tpIYg_PAwdPneep4AaABAg', text: 'i love how everyone just got summoned here now for the same reason', dstLang: 'ko' });

call('fullctx-captured', { context: browserBody.context, actions: [capturedAction], ...{ } }, {});
call('fullctx-synth-ja', { context: browserBody.context, actions: [synthJa] }, {});
call('minctx-synth-ja', { context: minContext('zh-CN'), actions: [synthJa] }, {});
call('minctx-synth-ko-auth', { context: minContext('zh-CN'), actions: [synthKo] }, { auth: true });
call('minctx-batch3', { context: minContext('zh-CN'), actions: [synthJa, synthKo, capturedAction] }, { auth: true });
