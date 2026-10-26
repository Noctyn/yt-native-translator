// Probe which inputs make perform_comment_action return 400 on the JP video.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKIES = fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim();
const body = JSON.parse(fs.readFileSync(path.join(HERE, 'pca-body.json'), 'utf8'));
const VISITOR = body.context.client.visitorData;
const CLIENT_VERSION = body.context.client.clientVersion;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

function varint(n) { let x = BigInt(n), out = []; do { let b = Number(x & 0x7fn); x >>= 7n; if (x > 0n) b |= 0x80; out.push(b); } while (x > 0n); return Buffer.from(out); }
function tag(f, w) { return varint((BigInt(f) << 3n) | BigInt(w)); }
function fVar(f, v) { return Buffer.concat([tag(f, 0), varint(v)]); }
function fLen(f, d) { const b = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8'); return Buffer.concat([tag(f, 2), varint(b.length), b]); }
function b64url(b) { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function buildAction({ commentId, text }) {
  const inner = fLen(1, fLen(1, Buffer.from(text, 'utf8')));
  return b64url(Buffer.concat([fVar(1, 22), fLen(31, Buffer.concat([fLen(2, commentId), fLen(3, inner), fLen(4, 'zh-CN'), fVar(5, 0)]))]));
}
function synthCommentId(seed) {
  // real IDs are proto field 10 (0x52) + 12 bytes, base64url => "Ug..."
  const b = Buffer.from(seed.repeat(32).slice(0, 12), 'latin1');
  return b64url(Buffer.concat([Buffer.from([0x52, 0x0c]), b]));
}

const REAL_ID = 'UgxCPX_P775CPyWsIJh4AaABAg';
const REAL_TEXT = '歌っている方、19歳の子なんですね… マジで歌詞も曲も映像も良すぎて… あなたへのおすすめありがとう';

async function call(label, { commentId = REAL_ID, text = REAL_TEXT, visitor = true, headers = true, rawAction = null } = {}) {
  const action = rawAction || buildAction({ commentId, text });
  const reqBody = {
    context: {
      client: { hl: 'zh-CN', gl: 'US', clientName: 'WEB', clientVersion: headers ? CLIENT_VERSION : '', visitorData: visitor ? VISITOR : '' },
      user: { lockedSafetyMode: false },
      request: { useSsl: true, consistencyTokenJars: [] },
    },
    actions: [action],
  };
  const hs = { 'content-type': 'application/json', cookie: COOKIES };
  if (headers) { hs['x-goog-visitor-id'] = visitor ? VISITOR : ''; hs['x-youtube-client-name'] = '1'; hs['x-youtube-client-version'] = CLIENT_VERSION; }
  const res = await fetch('https://www.youtube.com/youtubei/v1/comment/perform_comment_action?prettyPrint=false', {
    method: 'POST', headers: hs, body: JSON.stringify(reqBody),
  });
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) { /* ignore */ }
  const muts = j?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
  let translated = '';
  for (const m of muts) {
    const t = m?.payload?.commentEntityPayload?.translatedContent?.content;
    if (typeof t === 'string') translated += t.slice(0, 40);
  }
  console.log(`${label.padEnd(34)} http=${res.status} err=${String(j?.error?.message || '').slice(0, 80)} translated=${translated ? JSON.stringify(translated) : '-'}`);
  await new Promise((r) => setTimeout(r, 350));
}

await call('control real id');
await call('hash id k123456789', { commentId: 'k123456789' });
await call('hash id k1999999999', { commentId: 'k1999999999' });
await call('empty id', { commentId: '' });
await call('another video lookalike id', { commentId: 'Ugw1tpIYg_PAwdPneep4AaABAg' });
await call('synthetic valid-shape id', { commentId: synthCommentId('x') });
await call('empty text', { text: '' });
await call('one char text', { text: 'あ' });
await call('emoji only', { text: '😀😀😀' });
await call('emoji mixed', { text: '最高😀😀😀' });
await call('no visitor data', { visitor: false });
await call('no client headers/version', { headers: false });
await call('malformed action', { rawAction: 'AAAA' });
