// Isolate which client field/header causes 404 on perform_comment_action.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKIES = fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim();
const body = JSON.parse(fs.readFileSync(path.join(HERE, 'pca-body.json'), 'utf8'));
const VISITOR = body.context.client.visitorData;
const VER = body.context.client.clientVersion;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

function varint(n) { let x = BigInt(n), out = []; do { let b = Number(x & 0x7fn); x >>= 7n; if (x > 0n) b |= 0x80; out.push(b); } while (x > 0n); return Buffer.from(out); }
function tag(f, w) { return varint((BigInt(f) << 3n) | BigInt(w)); }
function fVar(f, v) { return Buffer.concat([tag(f, 0), varint(v)]); }
function fLen(f, d) { const b = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8'); return Buffer.concat([tag(f, 2), varint(b.length), b]); }
function b64url(b) { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function buildAction() {
  const text = '歌っている方、19歳の子なんですね… マジで歌詞も曲も映像も良すぎて… あなたへのおすすめありがとう';
  const inner = fLen(1, fLen(1, Buffer.from(text, 'utf8')));
  return b64url(Buffer.concat([fVar(1, 22), fLen(31, Buffer.concat([fLen(2, 'UgxCPX_P775CPyWsIJh4AaABAg'), fLen(3, inner), fLen(4, 'zh-CN'), fVar(5, 0)]))]));
}
const ACTION = buildAction();

async function call(label, { ctxVer = VER, ctxName = 'WEB', ctxVisitor = VISITOR, hVer = VER, hName = '1', hVisitor = VISITOR } = {}) {
  const reqBody = {
    context: {
      client: { hl: 'zh-CN', gl: 'US', clientName: ctxName, clientVersion: ctxVer, visitorData: ctxVisitor },
      user: { lockedSafetyMode: false },
      request: { useSsl: true, consistencyTokenJars: [] },
    },
    actions: [ACTION],
  };
  const hs = { 'content-type': 'application/json', cookie: COOKIES };
  if (hVer !== null) hs['x-youtube-client-version'] = hVer;
  if (hName !== null) hs['x-youtube-client-name'] = hName;
  if (hVisitor !== null) hs['x-goog-visitor-id'] = hVisitor;
  const res = await fetch('https://www.youtube.com/youtubei/v1/comment/perform_comment_action?prettyPrint=false', {
    method: 'POST', headers: hs, body: JSON.stringify(reqBody),
  });
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) { /* ignore */ }
  console.log(`${label.padEnd(36)} http=${res.status} err=${String(j?.error?.message || '').slice(0, 60)}`);
  await new Promise((r) => setTimeout(r, 350));
}

console.log('page version:', VER, 'visitor:', VISITOR.slice(0, 18) + '...');
await call('baseline');
await call('ctxVersion empty', { ctxVer: '' });
await call('header version empty', { hVer: '' });
await call('both version empty', { ctxVer: '', hVer: '' });
await call('ctxVersion stale 2.20250101.00.00', { ctxVer: '2.20250101.00.00', hVer: '2.20250101.00.00' });
await call('ctxVersion future 2.20261101.00.00', { ctxVer: '2.20261101.00.00', hVer: '2.20261101.00.00' });
await call('clientName omitted', { ctxName: '', hName: null });
await call('clientName WEB_MUSIC', { ctxName: 'WEB_MUSIC', hName: '1' });
await call('visitor empty', { ctxVisitor: '', hVisitor: '' });
await call('header name missing', { hName: null });
await call('header name 85 (WEB_REMIX)', { hName: '85' });
