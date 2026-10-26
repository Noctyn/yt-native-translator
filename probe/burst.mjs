import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKIES = fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim();
const bb = JSON.parse(fs.readFileSync(path.join(HERE, 'pca-body.json'), 'utf8'));

function varint(n) {
  let x = BigInt(n);
  const o = [];
  do { let b = Number(x & 0x7fn); x >>= 7n; if (x > 0n) b |= 0x80; o.push(b); } while (x > 0n);
  return Buffer.from(o);
}
const tag = (f, w) => varint((BigInt(f) << 3n) | BigInt(w));
const fVar = (f, v) => Buffer.concat([tag(f, 0), varint(v)]);
const fLen = (f, d) => { const b = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8'); return Buffer.concat([tag(f, 2), varint(b.length), b]); };
const b64 = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const act = (t, l) => b64(Buffer.concat([fVar(1, 22), fLen(31, Buffer.concat([fLen(2, 'Ugw1tpIYg_PAwdPneep4AaABAg'), fLen(3, fLen(1, fLen(1, t))), fLen(4, l), fVar(5, 0)]))]));

const ctx = { client: { hl: 'zh-CN', gl: 'US', clientName: 'WEB', clientVersion: '2.20261023.01.00', visitorData: bb.context.client.visitorData }, user: { lockedSafetyMode: false }, request: { useSsl: true, consistencyTokenJars: [] } };

const codes = [];
for (let i = 0; i < 14; i++) {
  const body = JSON.stringify({ context: ctx, actions: [act('burst test sentence number ' + i + ' for rate limiting', 'ja')] });
  const out = execFileSync('curl', ['-sS', '--compressed', '-H', 'Cookie: ' + COOKIES, '-H', 'Content-Type: application/json',
    '-H', 'Origin: https://www.youtube.com', '-X', 'POST', '-w', '\\n@@%{http_code}', '-d', body,
    'https://www.youtube.com/youtubei/v1/comment/perform_comment_action?prettyPrint=false'], { encoding: 'utf8' });
  const idx = out.lastIndexOf('\n@@');
  codes.push(out.slice(idx + 3).trim());
}
console.log('burst http codes: ' + codes.join(' '));
