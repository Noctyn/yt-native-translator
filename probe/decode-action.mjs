import fs from 'node:fs';

const file = process.argv[2] || 'capture2/bodies/117.json';
const j = JSON.parse(fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8'));
const muts = j.frameworkUpdates?.entityBatchUpdate?.mutations || [];
const withTr = muts.filter((m) => m.payload?.commentEntityPayload?.translateData);
console.log('mutations=' + muts.length + ' withTranslateData=' + withTr.length);
if (!withTr.length) process.exit(0);

const ce = withTr[0].payload.commentEntityPayload;
console.log('commentId              : ' + ce.properties.commentId);
console.log('source text            : ' + ce.properties.content.content.slice(0, 80));
console.log('translateData.text     : ' + ce.translateData.text);
console.log('isTranslationAvailable : ' + ce.isTranslationAvailable);
console.log('translateData keys     : ' + Object.keys(ce.translateData).join(','));
const cmd = ce.translateData.translateComment.innertubeCommand;
console.log('apiUrl                 : ' + cmd.commandMetadata.webCommandMetadata.apiUrl);
console.log('endpoint keys          : ' + Object.keys(cmd).join(','));
console.log('performCommentActionEndpoint keys: ' + Object.keys(cmd.performCommentActionEndpoint).join(','));

const action = cmd.performCommentActionEndpoint.action;
fs.writeFileSync(new URL('./action.b64', import.meta.url), action);
const b64 = decodeURIComponent(action).replace(/-/g, '+').replace(/_/g, '/');
const buf = Buffer.from(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='), 'base64');
console.log('action bytes: ' + buf.length + '  head hex: ' + buf.subarray(0, 8).toString('hex'));

function readVarint(b, i) {
  let r = 0n, shift = 1n;
  for (;;) {
    const c = b[i];
    if (c === undefined) throw new Error('truncated varint');
    i++;
    r |= BigInt(c & 0x7f) * shift;
    if (!(c & 0x80)) break;
    shift <<= 7n;
  }
  return [r, i];
}

function isAscii(s) {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 0x20) return false;
    if (c > 0x7e && c < 0xc0) return false;
  }
  return true;
}

function dump(b, off, end, depth, tag) {
  const pad = '  '.repeat(depth);
  const rows = [];
  let i = off;
  while (i < end) {
    let key;
    try { [key, i] = readVarint(b, i); } catch { rows.push(pad + '!truncated at ' + i); break; }
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (wire === 0) {
      let v; [v, i] = readVarint(b, i);
      rows.push(pad + field + ' varint ' + v);
    } else if (wire === 2) {
      let len; [len, i] = readVarint(b, i);
      const n = Number(len);
      if (i + n > end) { rows.push(pad + field + ' LEN OVERFLOW ' + n); break; }
      const seg = b.subarray(i, i + n);
      i += n;
      const txt = seg.toString('utf8');
      let sub = null;
      if (n > 1) { try { const r = dump(seg, 0, n, depth + 1, ''); if (r.ok) sub = r.rows; } catch { sub = null; } }
      const label = sub ? 'msg' : isAscii(txt) && txt.length ? 'str ' + JSON.stringify(txt.length > 90 ? txt.slice(0, 90) + '...' : txt) : 'bin ' + seg.subarray(0, 12).toString('hex');
      rows.push(pad + field + ' bytes(' + n + ') ' + label);
      if (sub) rows.push(...sub);
    } else if (wire === 5) { rows.push(pad + field + ' i32 ' + b.readUInt32LE(i)); i += 4; }
    else if (wire === 1) { rows.push(pad + field + ' i64 ' + b.readBigUInt64LE(i)); i += 8; }
    else { rows.push(pad + field + ' unsupported wire ' + wire); break; }
  }
  if (depth === 0) return { rows, ok: true };
  const looksProto = rows.length > 0 && !rows.some((r) => r.includes('!') || r.includes('OVERFLOW') || r.includes('unsupported'));
  return { rows, ok: looksProto && rows.length < 60 };
}

const res = dump(buf, 0, buf.length, 0, 'root');
console.log('--- protobuf tree ---');
console.log(res.rows.join('\n').slice(0, 4000));
