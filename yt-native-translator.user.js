// ==UserScript==
// @name         YouTube 评论区原生翻译（免 API Key）
// @name:en      YouTube Native Comment Translator
// @namespace    https://github.com/Noctyn/yt-native-translator
// @homepageURL  https://github.com/Noctyn/yt-native-translator
// @supportURL   https://github.com/Noctyn/yt-native-translator/issues
// @updateURL    https://raw.githubusercontent.com/Noctyn/yt-native-translator/main/yt-native-translator.user.js
// @downloadURL  https://raw.githubusercontent.com/Noctyn/yt-native-translator/main/yt-native-translator.user.js
// @version      0.2.0
// @description  复用 YouTube 网页端自带的评论翻译接口，免第三方 API Key 与自建代理：悬停即译、滚动自动翻译、译文/双语/原文一键切换，本地缓存 + 三款外观。
// @description:en Translate YouTube comments using YouTube native translation service without third-party API keys. Supports hover/scroll auto-translation, bilingual view, and local cache.
// @author       Noctyn
// @match        https://www.youtube.com/watch*
// @match        https://www.youtube.com/live/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// @noframes
// @license      MIT

(function () {
  'use strict';

  const root = document.documentElement;
  if (root.hasAttribute('data-ytn-loaded')) return;
  root.setAttribute('data-ytn-loaded', '1');

  /* 1. 常量 */

  const VERSION = '0.2.0';
  const ENDPOINT = '/youtubei/v1/comment/perform_comment_action?prettyPrint=false';
  const ACTION_TRANSLATE = 22;
  // 接口要求 context.client.clientVersion 非空（为空会 404）；页面取不到时用这个兜底
  const FALLBACK_CLIENT_VERSION = '2.20261023.01.00';
  const CONFIG_KEY = 'ytn_config_v1';
  const CACHE_KEY = 'ytn_cache_v1';
  const OWN_SEL = '.ytn-box, .ytn-overlay, .ytn-toast-host, .ytn-toolbar';
  const VM_SEL = 'ytd-comment-view-model';
  const TEXT_SEL = '#content-text';
  const CACHE_LIMIT = 1000;
  const CACHE_TTL = 3 * 24 * 3600 * 1000;
  const CHUNK_CHARS = 1200;
  const CHUNK_MAX = 10;
  const FETCH_TIMEOUT = 15000;
  const AUTO_DWELL = 380;
  const QUEUE_CONCURRENCY = 2;
  const QUEUE_GAP = 140;
  const PAUSE_MS = 45 * 1000;
  const TAG = '[YT评论区翻译]';

  const VIEWS = ['translation', 'bilingual', 'original'];
  const VIEW_LABEL = { translation: '译文', bilingual: '双语', original: '原文' };

  const LANGS = [
    ['auto', '跟随界面语言'],
    ['zh-CN', '简体中文'],
    ['zh-TW', '繁體中文'],
    ['en', 'English'],
    ['ja', '日本語'],
    ['ko', '한국어'],
    ['ru', 'Русский'],
    ['uk', 'Українська'],
    ['es', 'Español'],
    ['fr', 'Français'],
    ['de', 'Deutsch'],
    ['it', 'Italiano'],
    ['pt', 'Português'],
    ['nl', 'Nederlands'],
    ['pl', 'Polski'],
    ['tr', 'Türkçe'],
    ['ar', 'العربية'],
    ['hi', 'हिन्दी'],
    ['vi', 'Tiếng Việt'],
    ['th', 'ไทย'],
    ['id', 'Bahasa Indonesia'],
  ];

  const DEFAULTS = Object.freeze({
    targetLang: 'auto',
    mode: 'bilingual',
    style: 'quote',
    motion: 'medium',
    hover: true,
    hoverDelay: 200,
    modifier: 'none',
    skipSame: true,
    autoTranslate: false,
    translateReplies: true,
    takeoverNative: true,
    persistCache: true,
    showToolbar: true,
  });
  const BOOLS = ['hover', 'skipSame', 'autoTranslate', 'translateReplies', 'takeoverNative', 'persistCache', 'showToolbar'];

  /* 2. 小工具 */

  const now = () => Date.now();
  const clamp = (v, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
  const log = (...args) => { try { console.warn(TAG, ...args); } catch (e) { /* ignore */ } };
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') el.setAttribute('style', v);
        else if (k.length > 2 && k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    if (kids != null) for (const kid of [].concat(kids)) if (kid) el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    return el;
  }

  function hash32(str) {
    let x = 5381;
    for (let i = 0; i < str.length; i++) x = ((x << 5) + x + str.charCodeAt(i)) >>> 0;
    return x.toString(36);
  }

  function debounce(fn, ms) {
    let t = 0;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  // YouTube 开了 Trusted Types，不能用 innerHTML；图标一律用 createElementNS 拼
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    globe: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18' }], ['path', { d: 'M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z' }]],
    tune: [['path', { d: 'M4 7h8' }], ['path', { d: 'M18 7h2' }], ['circle', { cx: 15, cy: 7, r: 3 }], ['path', { d: 'M4 17h2' }], ['path', { d: 'M12 17h8' }], ['circle', { cx: 9, cy: 17, r: 3 }]],
    copy: [['rect', { x: 8, y: 8, width: 14, height: 14, rx: 2, ry: 2 }], ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }]],
    check: [['path', { d: 'M20 6 9 17l-5-5' }]],
    close: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
    retry: [['path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }]],
    alert: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 8v5' }], ['path', { d: 'M12 16.5h.01' }]],
  };

  function icon(name, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 18));
    svg.setAttribute('height', String(size || 18));
    svg.setAttribute('class', 'ytn-ico');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of ICONS[name] || []) {
      const n = document.createElementNS(SVG_NS, tag);
      for (const k in attrs) n.setAttribute(k, String(attrs[k]));
      svg.appendChild(n);
    }
    return svg;
  }

  function setIcon(btn, name, size) {
    const next = icon(name, size);
    const old = btn.querySelector('svg');
    if (old) old.replaceWith(next);
    else btn.prepend(next);
  }

  /* 3. 配置与存储（Tampermonkey 优先，退回 localStorage） */

  function readStore(key, dflt) {
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(key, null);
        if (v != null) return v;
      }
    } catch (e) { /* fall through */ }
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? dflt : JSON.parse(raw);
    } catch (e) {
      return dflt;
    }
  }

  function writeStore(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { log('存储失败', e); }
  }

  function sanitize(raw) {
    const c = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
    const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
    c.targetLang = pick(c.targetLang, LANGS.map((l) => l[0]), 'auto');
    c.mode = pick(c.mode, VIEWS, 'bilingual');
    c.style = pick(c.style, ['quote', 'card', 'minimal'], 'quote');
    c.motion = pick(c.motion, ['off', 'medium', 'full'], 'medium');
    c.modifier = pick(c.modifier, ['none', 'alt', 'ctrl', 'shift'], 'none');
    const delay = Number(c.hoverDelay);
    c.hoverDelay = isFinite(delay) ? clamp(Math.round(delay), 0, 1200) : DEFAULTS.hoverDelay;
    for (const k of BOOLS) c[k] = !!c[k];
    return c;
  }

  let config = sanitize(readStore(CONFIG_KEY, {}));

  // 所有设置改动的唯一入口：写存储 → 按差异刷新界面
  function commit(patch) {
    const prev = config;
    config = sanitize(Object.assign({}, prev, patch));
    writeStore(CONFIG_KEY, config);
    onConfigChanged(prev);
  }

  /* 4. 原生接口：protobuf action 构造 + 请求 */

  function varint(n) {
    const out = [];
    let x = n >>> 0;
    while (x >= 0x80) {
      out.push((x & 0x7f) | 0x80);
      x >>>= 7;
    }
    out.push(x);
    return out;
  }
  const vField = (f, v) => varint(f * 8).concat(varint(v));
  const bField = (f, bytes) => varint(f * 8 + 2).concat(varint(bytes.length), bytes);
  const utf8 = (s) => Array.from(new TextEncoder().encode(s));

  function b64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.slice(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // 与网页端一致的 CommentTranslationAction：
  //   f1=22, f31={ f2:commentId, f3{f1{f1:原文}}, f4:目标语言, f5:0 }
  function buildAction(commentId, text, dstLang) {
    const inner = bField(1, bField(1, utf8(text)));
    const payload = bField(2, utf8(commentId))
      .concat(bField(3, inner), bField(4, utf8(dstLang)), vField(5, 0));
    return b64url(vField(1, ACTION_TRANSLATE).concat(bField(31, payload)));
  }

  let clientOverride = null;

  // 沙箱里拿不到页面的 ytcfg，优先走 unsafeWindow；任何一步失败都回退到兜底值
  function pageClient() {
    let ctxClient = {};
    let get = () => undefined;
    let data = {};
    try {
      const w = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
      const cfg = w.ytcfg;
      get = (k) => { try { return cfg && typeof cfg.get === 'function' ? cfg.get(k) : undefined; } catch (e) { return undefined; } };
      data = (cfg && cfg.data_) || {};
      ctxClient = (get('INNERTUBE_CONTEXT') || data.INNERTUBE_CONTEXT || {}).client || {};
    } catch (e) { /* use fallbacks */ }
    const client = {
      hl: ctxClient.hl || get('HL') || data.HL || root.lang || 'en',
      gl: ctxClient.gl || get('GL') || data.GL || 'US',
      clientName: 'WEB',
      clientVersion: ctxClient.clientVersion || get('INNERTUBE_CLIENT_VERSION') || data.INNERTUBE_CLIENT_VERSION || FALLBACK_CLIENT_VERSION,
      visitorData: ctxClient.visitorData || get('VISITOR_DATA') || data.VISITOR_DATA || '',
    };
    if (clientOverride) Object.assign(client, clientOverride);
    return client;
  }

  function targetLang() {
    return config.targetLang === 'auto' ? pageClient().hl : config.targetLang;
  }

  function splitChunks(text) {
    if (text.length <= CHUNK_CHARS) return [text];
    const out = [];
    let cur = '';
    for (const line of text.split('\n')) {
      const joined = cur ? cur + '\n' + line : line;
      if (joined.length <= CHUNK_CHARS) { cur = joined; continue; }
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < line.length; i += CHUNK_CHARS) out.push(line.slice(i, i + CHUNK_CHARS));
    }
    if (cur) out.push(cur);
    if (out.length <= CHUNK_MAX) return out;
    const head = out.slice(0, CHUNK_MAX - 1);
    head.push(out.slice(CHUNK_MAX - 1).join('\n'));
    return head;
  }

  let deadUntil = 0;
  let authFails = 0;
  let endpointFails = 0;

  function breakerPause(ms) {
    deadUntil = Math.max(deadUntil, now() + ms);
  }

  function timedFetch(url, options, ms) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    return fetch(url, Object.assign({ credentials: 'same-origin', signal: ac.signal }, options))
      .finally(() => clearTimeout(t));
  }

  function retryMsFrom(res) {
    const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    if (ra > 0) return clamp(ra * 1000, 5000, 5 * 60 * 1000);
    const rl = Number(res.headers && res.headers.get && res.headers.get('x-rate-limit-reset'));
    if (rl > 1e9) return clamp(rl * 1000 - now(), 5000, 5 * 60 * 1000);
    return 0;
  }

  async function callOnce(text, dstLang, commentId) {
    if (deadUntil > now()) throw new Error('paused');
    const cl = pageClient();
    const body = {
      context: {
        client: { hl: cl.hl, gl: cl.gl, clientName: cl.clientName, clientVersion: cl.clientVersion, visitorData: cl.visitorData },
        user: { lockedSafetyMode: false },
        request: { useSsl: true, consistencyTokenJars: [] },
      },
      actions: [buildAction(commentId, text, dstLang)],
    };

    let res;
    try {
      res = await timedFetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-visitor-id': cl.visitorData,
          'x-youtube-client-name': '1',
          'x-youtube-client-version': cl.clientVersion,
        },
        body: JSON.stringify(body),
      }, FETCH_TIMEOUT);
    } catch (e) {
      // 超时与断网都值得重试一次
      const err = new Error(e && e.name === 'AbortError' ? 'timeout' : 'network');
      err.retryable = true;
      throw err;
    }

    if (res.status === 401 || res.status === 403) {
      if (++authFails >= 3) { breakerPause(5 * 60 * 1000); authFails = 0; }
      throw new Error('auth');
    }
    if (res.status === 429) {
      breakerPause(retryMsFrom(res) || 60 * 1000);
      const e = new Error('rate');
      e.defer = true;
      throw e;
    }
    if (res.status === 400 || res.status === 404 || res.status === 405) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 160); } catch (e) { /* ignore */ }
      log('接口拒绝请求 HTTP ' + res.status, detail);
      const e = new Error('endpoint');
      e.status = res.status;
      throw e;
    }
    if (!res.ok) {
      const e = new Error('http ' + res.status);
      e.retryable = true;
      throw e;
    }

    authFails = 0;
    const json = await res.json();
    const muts = (((json || {}).frameworkUpdates || {}).entityBatchUpdate || {}).mutations || [];
    let out = '';
    for (const m of muts) {
      const t = ((m || {}).payload || {}).commentEntityPayload;
      if (t && t.translatedContent && typeof t.translatedContent.content === 'string') out += (out ? '\n' : '') + t.translatedContent.content;
    }
    if (!out.trim()) throw new Error('empty');
    return out;
  }

  async function translate(text, dstLang, commentId) {
    const chunks = splitChunks(text);
    const parts = [];
    for (const c of chunks) {
      let err = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          parts.push(await callOnce(c, dstLang, commentId));
          endpointFails = 0;
          err = null;
          break;
        } catch (e) {
          err = e;
          // 页面客户端上下文被拒（clientVersion 为空/异常会 404）：换兼容上下文再试一次
          if (e && e.message === 'endpoint' && attempt === 0) {
            if (!clientOverride) {
              clientOverride = { clientName: 'WEB', clientVersion: FALLBACK_CLIENT_VERSION, visitorData: '' };
              log('原生接口拒绝了页面客户端上下文，改用兼容上下文重试');
            }
            continue;
          }
          if (!e || !e.retryable) break;
          await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        }
      }
      if (err) throw err;
    }
    return parts.join('\n');
  }

  /* 5. 缓存（LRU + TTL 滑动续期 + 可选持久化） */

  const cache = new Map();
  let cacheLoaded = false;
  let cacheDirty = false;

  function loadCache() {
    if (cacheLoaded) return;
    cacheLoaded = true;
    const raw = readStore(CACHE_KEY, null);
    if (!Array.isArray(raw)) return;
    const cut = now() - CACHE_TTL;
    for (const [k, v] of raw) if (v && v.t > cut && typeof v.v === 'string') cache.set(k, v);
  }

  function flushCacheNow() {
    if (!config.persistCache || !cacheDirty) return;
    cacheDirty = false;
    const merged = new Map();
    const cut = now() - CACHE_TTL;
    try {
      const raw = readStore(CACHE_KEY, null);
      if (Array.isArray(raw)) for (const [k, v] of raw) if (v && v.t > cut) merged.set(k, v);
    } catch (e) { /* ignore */ }
    for (const [k, v] of cache) merged.set(k, v);
    const arr = Array.from(merged.entries()).sort((a, b) => b[1].t - a[1].t).slice(0, CACHE_LIMIT);
    writeStore(CACHE_KEY, arr);
  }

  const flushCache = debounce(flushCacheNow, 15000);

  function cacheKey(text, lang, commentId) {
    return 'c|' + (commentId || '').slice(-12) + '|' + lang + '|' + hash32(text);
  }

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.t < now() - CACHE_TTL) { cache.delete(key); return null; }
    hit.t = now();
    cache.delete(key);
    cache.set(key, hit);
    return hit.v;
  }

  function cacheSet(key, value) {
    cache.set(key, { v: value, t: now() });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cacheDirty = true;
    if (config.persistCache) flushCache();
  }

  function clearCache() {
    cache.clear();
    cacheLoaded = true;
    cacheDirty = false;
    writeStore(CACHE_KEY, []);
    try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
  }

  const inflight = new Map();
  function dedupe(key, factory) {
    if (inflight.has(key)) return inflight.get(key);
    const p = factory().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /* 6. 语言判定：先看文字系统，再用停用词区分拉丁语系；拿不准就交给接口翻译 */

  const RE_SCRIPT = [
    ['ja', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
    ['ko', /\p{Script=Hangul}/gu],
    ['th', /\p{Script=Thai}/gu],
    ['el', /\p{Script=Greek}/gu],
    ['hi', /\p{Script=Devanagari}/gu],
    ['he', /\p{Script=Hebrew}/gu],
    ['arab', /\p{Script=Arabic}/gu],
    ['cyr', /\p{Script=Cyrillic}/gu],
  ];
  const RE_HAN = /\p{Script=Han}/gu;
  const RE_VI = /[ăơưđạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/giu;

  const STOP_RAW = {
    en: 'the and is are was were you this that with for have has not but just my so it its im dont thats very really love great song music thanks thank amazing best who what when',
    es: 'que de la el los las y en es un una por con para muy pero como esta está qué mi te se lo del al más gracias canción esto eres soy tu',
    fr: 'le la les des du est et une un que qui pour pas dans avec très je tu il elle nous vous sur mais merci chanson cest suis cette ce',
    de: 'der die das und ist nicht ich du ein eine mit für auf den dem zu es wie aber auch sehr danke lied einfach sind war',
    it: 'il lo la gli le di che è e un una per con non sono molto anche come questa grazie canzone bellissima ma mi ti',
    pt: 'o a os as de que e é um uma para com não muito mas como essa obrigado música você ele ela está são',
    id: 'yang dan di ini itu untuk dengan tidak saya aku kamu dari ada lagu banget sekali juga ya aja nya',
    tr: 've bir bu çok için ama ben sen de da ne güzel şarkı mı değil bence harika',
    pl: 'i w nie to jest się na z że jak ale bardzo dla piosenka dzięki super',
    nl: 'de het een en is van dat niet ik je met voor maar ook zo heel mooi lied dit',
  };
  const STOP = {};
  for (const k of Object.keys(STOP_RAW)) STOP[k] = new Set(STOP_RAW[k].split(' '));

  function cleanText(text) {
    return String(text || '').replace(/https?:\/\/\S+/g, ' ').replace(/[@#][\w.\-_]{2,40}/g, ' ');
  }

  function latinLang(s) {
    const words = s.toLowerCase().match(/\p{L}+/gu) || [];
    if (!words.length) return '';
    const vi = (s.match(RE_VI) || []).length;
    if (vi >= 2 || (vi >= 1 && words.length <= 3)) return 'vi';
    const score = {};
    for (const w of words) for (const k in STOP) if (STOP[k].has(w)) score[k] = (score[k] || 0) + 1;
    const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return '';
    const top = ranked[0][1];
    const second = ranked[1] ? ranked[1][1] : 0;
    return top > second && (top >= 2 || words.length <= 3) ? ranked[0][0] : '';
  }

  function detectLang(text) {
    const s = cleanText(text);
    const letters = (s.match(/\p{L}/gu) || []).length;
    if (!letters) return 'none';
    for (const [name, re] of RE_SCRIPT) {
      if ((s.match(re) || []).length / letters > 0.08) {
        if (name !== 'cyr') return name;
        return /[іїєґ]/i.test(s) ? 'uk' : /[ыэъё]/i.test(s) ? 'ru' : 'cyr';
      }
    }
    if ((s.match(RE_HAN) || []).length / letters > 0.3) return 'zh';
    return latinLang(s) || 'latin';
  }

  const FAMILY = { bg: 'cyr', sr: 'cyr', be: 'cyr', fa: 'arab', ur: 'arab', ar: 'arab', iw: 'he' };
  function familyOf(lang) {
    const p = String(lang || '').toLowerCase().split('-')[0];
    return FAMILY[p] || p;
  }

  // 'none' = 没有可翻译的文字（纯表情/链接/@提及）；'latin' = 拉丁字母但语种不确定 → 交给接口判断
  function isSameLang(text, lang) {
    const d = detectLang(text);
    if (d === 'none') return true;
    const f = familyOf(lang);
    return d === f || (d === 'cyr' && f === 'ru');
  }

  /* 7. 评论区 DOM 与每条评论的状态 */

  const states = new WeakMap();
  function st(vm) {
    let s = states.get(vm);
    if (!s) {
      s = { sig: '', done: '', same: '', fail: '', queued: false, dist: Infinity, defers: 0, visible: false, dwell: 0, obsGen: -1, view: null };
      states.set(vm, s);
    }
    return s;
  }
  function isSettled(vm) {
    const s = states.get(vm);
    return !!(s && (s.done || s.same || s.fail));
  }

  function ownNode(el) {
    return !!(el && el.closest && el.closest(OWN_SEL));
  }

  function commentVM(el) {
    const vm = el && el.closest ? el.closest(VM_SEL) : null;
    if (!vm || ownNode(vm)) return null;
    return vm;
  }

  function textNodeOf(vm) {
    return vm.querySelector(':scope #content-text') || vm.querySelector(TEXT_SEL);
  }

  function commentIdOf(vm, text) {
    for (const a of vm.querySelectorAll('a[href]')) {
      const m = /(?:\?|&)lc=([^&]+)/.exec(a.getAttribute('href') || '');
      if (m) {
        try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
      }
    }
    return 'k' + hash32(String(text).slice(0, 120));
  }

  function isReplyVM(vm) {
    return !!(vm.closest('#replies') || vm.closest('ytd-comment-replies-renderer'));
  }

  function commentText(vm) {
    const node = textNodeOf(vm);
    if (!node) return '';
    return String(node.textContent || '').replace(/\s+/g, ' ').trim();
  }

  let commentsEl = null;
  function commentsRoot() {
    if (commentsEl && commentsEl.isConnected) return commentsEl;
    commentsEl = document.querySelector('ytd-comments#comments') || document.querySelector('ytd-comments');
    return commentsEl;
  }

  function eachCommentVM(cb) {
    const host = commentsRoot();
    if (!host) return;
    for (const vm of host.querySelectorAll(VM_SEL)) {
      if (ownNode(vm)) continue;
      if (!config.translateReplies && isReplyVM(vm)) continue;
      cb(vm);
    }
  }

  /* 8. 译文框 */

  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function motionMs() {
    if (reducedMotion || config.motion === 'off') return 0;
    return config.motion === 'full' ? 260 : 160;
  }

  function viewOf(vm) {
    const s = states.get(vm);
    return (s && s.view) || config.mode;
  }

  function buildBox() {
    const box = h('div', { class: 'ytn-box', 'data-state': 'idle', 'data-view': config.mode, role: 'status', 'aria-live': 'polite' });
    const tabs = h('div', { class: 'ytn-tabs', role: 'group', 'aria-label': '显示方式' });
    for (const v of VIEWS) {
      tabs.appendChild(h('button', { class: 'ytn-tab', type: 'button', 'data-view': v, 'aria-pressed': 'false', text: VIEW_LABEL[v] }));
    }
    const note = h('div', { class: 'ytn-note' }, [
      h('span', { class: 'ytn-brand' }, [icon('globe', 14), h('span', { text: 'Google 翻译' })]),
      h('button', { class: 'ytn-retry', type: 'button' }, [icon('retry', 14), h('span', { text: '重试' })]),
      tabs,
      h('button', { class: 'ytn-copy', type: 'button', 'aria-label': '复制译文', title: '复制译文' }, icon('copy', 14)),
    ]);
    const body = h('div', { class: 'ytn-body' }, [
      h('div', { class: 'ytn-skel', 'aria-hidden': 'true' }),
      h('div', { class: 'ytn-text' }),
    ]);
    box.append(h('div', { class: 'ytn-body-wrap' }, body), note);
    return box;
  }

  function styleVarsFor(box, srcNode) {
    if (!srcNode) return;
    const cs = getComputedStyle(srcNode);
    if (/px$/.test(cs.fontSize)) box.style.setProperty('--ytn-fs', cs.fontSize);
    if (/px$/.test(cs.lineHeight)) box.style.setProperty('--ytn-lh', cs.lineHeight);
  }

  function mountBox(vm, srcNode) {
    let box = vm.querySelector('.ytn-box');
    if (box) return box;
    box = buildBox();
    styleVarsFor(box, srcNode);
    const anchor = vm.querySelector('#expander') || srcNode || vm;
    (anchor.parentNode || vm).insertBefore(box, anchor.nextSibling);
    paintBox(box, viewOf(vm));
    return box;
  }

  // 只有译文真正就绪时才藏原文，加载中/出错时原文始终可见
  function syncSource(box) {
    const host = box.closest(VM_SEL) || box.closest('.ytn-pv-main');
    if (!host) return;
    host.classList.toggle('ytn-hide-source', box.dataset.view === 'translation' && box.dataset.state === 'done');
  }

  function paintBox(box, view) {
    box.dataset.view = view;
    for (const t of box.querySelectorAll('.ytn-tab')) {
      const on = t.dataset.view === view;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    syncSource(box);
  }

  function setState(box, state) {
    box.dataset.state = state;
    box.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
    syncSource(box);
  }

  function setSkeleton(box, n) {
    const sk = box.querySelector('.ytn-skel');
    if (!sk || sk.childElementCount === n) return;
    sk.textContent = '';
    for (let i = 0; i < n; i++) sk.appendChild(h('span', { class: 'ytn-skel-line' }));
  }

  // 译文出现/切换视图时的短促入场：只动 opacity + transform
  function reveal(box, fast) {
    const ms = motionMs();
    const el = box.querySelector('.ytn-body');
    if (!ms || !el || !el.animate) return;
    try {
      el.animate(
        [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }],
        { duration: fast ? Math.round(ms * 0.7) : ms, easing: 'cubic-bezier(.2,0,0,1)' }
      );
    } catch (e) { /* ignore */ }
  }

  function renderResult(vm, text, state) {
    const box = vm.querySelector('.ytn-box');
    if (!box) return;
    const prev = box.dataset.state;
    const target = box.querySelector('.ytn-text');
    target.textContent = '';
    if (state === 'error') target.append(icon('alert', 16), h('span', { text: text || '' }));
    else target.textContent = text || '';
    box.__ytnOut = state === 'done' ? (text || '') : '';
    setState(box, state);
    if (state === 'done' && prev === 'loading') reveal(box);
  }

  function removeBox(vm) {
    const box = vm.querySelector('.ytn-box');
    if (box) box.remove();
    vm.classList.remove('ytn-hide-source');
  }

  // 全局显示方式变化：清掉单条评论的临时覆盖，统一重绘
  function refreshViews() {
    for (const vm of document.querySelectorAll(VM_SEL)) {
      const s = states.get(vm);
      if (s) s.view = null;
      const box = vm.querySelector('.ytn-box');
      if (box) paintBox(box, config.mode);
    }
  }

  function friendlyError(err) {
    const m = String((err && err.message) || err || '');
    if (m === 'paused') return '翻译暂时暂停，稍后自动恢复';
    if (m === 'auth') return '登录状态失效，请刷新页面后重试';
    if (m === 'rate') return '请求过于频繁，稍后自动继续';
    if (m === 'endpoint') return '原生翻译接口暂时不可用，点「重试」或稍后自动恢复';
    if (m === 'empty') return '没有可用译文';
    if (m === 'timeout' || /abort/i.test(m)) return '请求超时，点「重试」再试一次';
    if (m === 'network' || /Failed to fetch|NetworkError/i.test(m)) return '网络请求失败，请检查网络后重试';
    return '翻译失败，点「重试」再试一次';
  }

  function legacyCopy(text) {
    const ta = h('textarea', { readonly: true, style: 'position:fixed;top:-100px;opacity:0;pointer-events:none' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
    return ok;
  }

  async function copyOut(box, btn) {
    const text = box.__ytnOut || '';
    if (!text) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      ok = legacyCopy(text);
    }
    setIcon(btn, ok ? 'check' : 'alert', 14);
    btn.classList.toggle('is-ok', ok);
    clearTimeout(btn.__ytnT);
    btn.__ytnT = setTimeout(() => { setIcon(btn, 'copy', 14); btn.classList.remove('is-ok'); }, 1400);
  }

  /* 9. 任务队列 */

  const queue = new Set();
  let running = 0;
  let queueTimer = 0;
  let pumpQueued = false;
  let pausedUntil = 0;
  let epoch = 0; // 目标语言变化/换页时 +1，丢弃在途请求的结果

  function measureDist(vm) {
    if (!vm.getBoundingClientRect) return Infinity;
    const r = vm.getBoundingClientRect();
    return Math.abs(r.top + r.height / 2 - innerHeight / 2);
  }

  function enqueueVM(vm, dist) {
    if (!vm || !vm.isConnected) return;
    const s = st(vm);
    if (s.queued) return;
    s.queued = true;
    s.dist = typeof dist === 'number' ? dist : measureDist(vm);
    queue.add(vm);
    schedulePump(0);
  }

  function schedulePump(delay) {
    if (pumpQueued) return;
    pumpQueued = true;
    clearTimeout(queueTimer);
    queueTimer = setTimeout(() => {
      pumpQueued = false;
      queueTimer = 0;
      pump();
    }, delay || 0);
  }

  // 入队时记录一次距离，取任务时不再读布局，避免批量入队变成 O(n²) 强制重排
  function takeNext() {
    let best = null;
    let bestDist = Infinity;
    for (const vm of queue) {
      if (!vm.isConnected) {
        queue.delete(vm);
        st(vm).queued = false;
        continue;
      }
      const d = st(vm).dist;
      if (best === null || d < bestDist) { bestDist = d; best = vm; }
    }
    if (best) {
      queue.delete(best);
      st(best).queued = false;
    }
    return best;
  }

  function pump() {
    if (document.hidden) { schedulePump(1200); return; }
    if (now() < pausedUntil) { schedulePump(Math.min(pausedUntil - now() + 50, 3000)); return; }
    while (running < QUEUE_CONCURRENCY && queue.size) {
      const vm = takeNext();
      if (!vm) break;
      running++;
      runVM(vm).then((fetched) => {
        running--;
        schedulePump(fetched ? QUEUE_GAP : 0);
      }, () => {
        running--;
        schedulePump(QUEUE_GAP);
      });
    }
  }

  function pauseQueue(ms) {
    pausedUntil = Math.max(pausedUntil, now() + (ms || PAUSE_MS));
    schedulePump(0);
  }

  function resetBreaker() {
    deadUntil = 0;
    endpointFails = 0;
    authFails = 0;
    pausedUntil = 0;
    schedulePump(0);
  }

  function markSame(vm, s, sig) {
    s.same = sig;
    s.done = '';
    s.fail = '';
    if (vm.querySelector('.ytn-box')) removeBox(vm);
  }

  // 译文和原文几乎一样 → 说明本来就是目标语言，不打扰用户（手动触发时照常显示）
  function applyResult(vm, s, sig, text, out, force) {
    if (!force && norm(out) === norm(text)) { markSame(vm, s, sig); return; }
    mountBox(vm, textNodeOf(vm));
    s.done = sig;
    s.same = '';
    s.fail = '';
    renderResult(vm, out, 'done');
  }

  async function runVM(vm, force) {
    const s = st(vm);
    const srcNode = textNodeOf(vm);
    const text = commentText(vm);
    if (!srcNode || text.length < 2) return false;
    if (!config.translateReplies && isReplyVM(vm)) return false;

    const lang = targetLang();
    const sig = hash32(text) + '|' + lang;
    const myEpoch = epoch;
    s.sig = sig;
    if (force) resetBreaker();
    else if (s.done === sig || s.same === sig || s.fail === sig) return false;

    if (!force && config.skipSame && isSameLang(text, lang)) {
      markSame(vm, s, sig);
      return false;
    }

    const id = commentIdOf(vm, text);
    const key = cacheKey(text, lang, id);
    loadCache();
    const hit = force ? null : cacheGet(key);
    if (hit != null) {
      applyResult(vm, s, sig, text, hit, false);
      return false;
    }

    const box = mountBox(vm, srcNode);
    setSkeleton(box, clamp(Math.ceil(text.length / 56), 1, 3));
    setState(box, 'loading');
    try {
      const out = await dedupe(key, () => translate(text, lang, id));
      if (!vm.isConnected || epoch !== myEpoch || s.sig !== sig) return true;
      cacheSet(key, out);
      s.defers = 0;
      applyResult(vm, s, sig, text, out, !!force);
      return true;
    } catch (err) {
      if (epoch !== myEpoch) return true;
      if (err && err.defer && s.defers < 3) {
        s.defers++;
        enqueueVM(vm);
        return true;
      }
      if (err && err.message === 'paused') {
        s.defers = 0;
        pauseQueue(Math.max(1000, deadUntil - now()));
        enqueueVM(vm);
        return false;
      }
      if (err && err.message === 'endpoint') {
        endpointFails++;
        if (endpointFails >= 3) {
          breakerPause(2 * 60 * 1000);
          pauseQueue(2 * 60 * 1000);
          if (endpointFails === 3) toast('原生翻译接口连续失败，已暂停 2 分钟');
        }
      } else if (err && (err.retryable || err.message === 'rate')) {
        pauseQueue(err.message === 'rate' ? PAUSE_MS : 8000);
      }
      s.fail = sig;
      if (!vm.isConnected) return true;
      renderResult(vm, friendlyError(err), 'error');
      log('翻译失败', err && err.message === 'endpoint' ? 'HTTP ' + (err.status || '?') : (err && err.message) || err);
      return true;
    }
  }

  /* 10. 触发：悬停、自动、快捷键、接管原生按钮 */

  let hoverTimer = 0;
  let hoverVM = null;
  const MOD_KEYS = { AltLeft: 'alt', AltRight: 'alt', ControlLeft: 'ctrl', ControlRight: 'ctrl', ShiftLeft: 'shift', ShiftRight: 'shift' };

  function modHeld(e) {
    const m = config.modifier;
    return (m === 'alt' && e.altKey) || (m === 'ctrl' && e.ctrlKey) || (m === 'shift' && e.shiftKey);
  }

  function isEditable(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('input, textarea, [contenteditable="true"], [role="textbox"]');
  }

  function onMouseOver(e) {
    if (!config.hover) return;
    const t = e.target;
    if (!t || !t.closest) return;
    const vm = commentVM(t);
    if (!vm || vm === hoverVM || isEditable(t)) return;
    hoverVM = vm;
    clearTimeout(hoverTimer);
    hoverTimer = 0;
    if (isSettled(vm)) return;
    const quick = config.hoverDelay <= 0 || modHeld(e);
    hoverTimer = setTimeout(() => {
      hoverTimer = 0;
      if (vm.isConnected && hoverVM === vm) enqueueVM(vm);
    }, quick ? 0 : config.hoverDelay);
  }

  // 只在真正离开这条评论时才取消，鼠标在评论内部子元素间移动不会重置延迟计时
  function onMouseOut(e) {
    if (!hoverVM) return;
    const to = e.relatedTarget;
    if (to && to.nodeType === 1 && hoverVM.contains(to)) return;
    hoverVM = null;
    clearTimeout(hoverTimer);
    hoverTimer = 0;
  }

  function toggleMode() {
    commit({ mode: VIEWS[(VIEWS.indexOf(config.mode) + 1) % VIEWS.length] });
    toast('显示方式：' + VIEW_LABEL[config.mode]);
  }

  function toggleAuto() {
    commit({ autoTranslate: !config.autoTranslate });
    toast(config.autoTranslate ? '已开启自动翻译' : '已关闭自动翻译');
  }

  function translateVisible() {
    let n = 0;
    eachCommentVM((vm) => {
      if (isSettled(vm)) return;
      const r = vm.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return;
      enqueueVM(vm, Math.abs(r.top + r.height / 2 - innerHeight / 2));
      n++;
    });
    toast(n ? '正在翻译 ' + n + ' 条评论' : '可视评论都已翻译');
  }

  const SHORTCUTS = [
    ['KeyS', 'S', '设置', () => openPanel()],
    ['KeyT', 'T', '切换显示', toggleMode],
    ['KeyA', 'A', '翻译可视', translateVisible],
    ['KeyP', 'P', '自动翻译', toggleAuto],
    ['KeyC', 'C', '清缓存', () => { clearCache(); toast('已清空译文缓存'); }],
  ];

  // 用 e.code 而不是 e.key：macOS 上 Option+Shift+字母会产出特殊字符，e.key 对不上
  function onKeyDown(e) {
    // 悬停在评论上时按下修饰键 → 立刻翻译
    if (MOD_KEYS[e.code] && MOD_KEYS[e.code] === config.modifier && !e.repeat && hoverVM && config.hover && !isSettled(hoverVM)) {
      clearTimeout(hoverTimer);
      hoverTimer = 0;
      enqueueVM(hoverVM);
    }
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || isEditable(e.target)) return;
    const hit = SHORTCUTS.find((s) => s[0] === e.code);
    if (!hit) return;
    e.preventDefault();
    hit[3]();
  }

  function onClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;

    const ctl = t.closest('.ytn-tab, .ytn-retry, .ytn-copy');
    if (ctl) {
      const box = ctl.closest('.ytn-box');
      if (!box) return;
      e.stopPropagation();
      e.preventDefault();
      const vm = box.closest(VM_SEL);
      if (ctl.classList.contains('ytn-tab')) {
        const v = ctl.dataset.view;
        if (vm) st(vm).view = v; // 单条评论的临时视图，下次全局切换时被覆盖
        paintBox(box, v);
        if (v !== 'original') reveal(box, true);
      } else if (ctl.classList.contains('ytn-retry')) {
        if (vm) {
          const s = st(vm);
          s.done = s.same = s.fail = '';
          runVM(vm, true);
        }
      } else {
        copyOut(box, ctl);
      }
      return;
    }

    if (!config.takeoverNative) return;
    const btn = t.closest('ytd-tri-state-button-view-model.translate-button, .translate-button');
    if (!btn) return;
    const vm = commentVM(btn);
    if (!vm) return;
    e.stopPropagation();
    e.preventDefault();
    const s = st(vm);
    s.done = s.same = s.fail = '';
    runVM(vm, true);
  }

  /* 滚动自动翻译 */

  let autoObserver = null;
  let autoGen = 0;

  function autoEnabled() {
    return !!config.autoTranslate && typeof IntersectionObserver === 'function';
  }

  function observeAuto(vm) {
    if (!autoObserver) return;
    const s = st(vm);
    if (s.obsGen === autoGen) return;
    s.obsGen = autoGen;
    try { autoObserver.observe(vm); } catch (e) { /* ignore */ }
  }

  function onAutoEntries(entries) {
    for (const en of entries) {
      const vm = en.target;
      const s = st(vm);
      const rect = en.boundingClientRect || { top: 0, bottom: 0, height: 0 };
      s.visible = !!(en.isIntersecting && (en.intersectionRatio >= 0.3 || rect.height > innerHeight * 0.35));
      s.dist = Math.abs((rect.top + rect.bottom) / 2 - innerHeight / 2);
      if (!s.visible) {
        clearTimeout(s.dwell);
        continue;
      }
      if (isSettled(vm)) continue;
      clearTimeout(s.dwell);
      s.dwell = setTimeout(() => {
        s.dwell = 0;
        if (!config.autoTranslate || !vm.isConnected || !s.visible || isSettled(vm)) return;
        enqueueVM(vm, s.dist);
      }, AUTO_DWELL);
    }
  }

  function teardownAuto() {
    if (autoObserver) { autoObserver.disconnect(); autoObserver = null; }
    autoGen++;
  }

  // 只在初始化/导航/开关变化时重建；新加载的评论走增量观察
  function buildAutoWatch() {
    teardownAuto();
    if (!autoEnabled()) return;
    autoObserver = new IntersectionObserver(onAutoEntries, { rootMargin: '-8% 0px -6% 0px', threshold: [0, 0.3, 0.6] });
    eachCommentVM((vm) => observeAuto(vm));
  }

  function primeAuto() {
    if (!autoObserver) return;
    eachCommentVM((vm) => observeAuto(vm));
  }

  // 目标语言 / 跳过同语言 / 换页：清空所有评论的状态与译文框，并丢弃在途结果
  function resetAll() {
    epoch++;
    hoverVM = null;
    clearTimeout(hoverTimer);
    hoverTimer = 0;
    clearTimeout(scanTimer);
    scanTimer = 0;
    dirty.clear();
    discover = false;
    commentsEl = null;
    for (const vm of queue) {
      const s = states.get(vm);
      if (s) s.queued = false;
    }
    queue.clear();
    for (const vm of document.querySelectorAll(VM_SEL)) {
      const s = states.get(vm);
      if (s && s.dwell) clearTimeout(s.dwell);
      states.delete(vm);
      if (!ownNode(vm)) removeBox(vm);
    }
    buildAutoWatch();
  }

  /* 11. 提示：YouTube 风格的反色 snackbar，同一时间只有一条 */

  let toastHost = null;
  let toastTimer = 0;

  function toast(msg) {
    if (!toastHost || !toastHost.isConnected) {
      toastHost = h('div', { class: 'ytn-toast-host' });
      document.body.appendChild(toastHost);
    }
    let el = toastHost.firstElementChild;
    const fresh = !el;
    if (!el) {
      el = h('div', { class: 'ytn-toast', role: 'status' });
      toastHost.appendChild(el);
    }
    const wasOn = el.classList.contains('is-on');
    el.textContent = msg;
    if (fresh) requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-on')));
    else if (!wasOn) requestAnimationFrame(() => el.classList.add('is-on'));
    else if (el.animate && motionMs()) {
      try { el.animate([{ transform: 'translateY(3px)' }, { transform: 'none' }], { duration: 140, easing: 'cubic-bezier(.2,0,0,1)' }); } catch (e) { /* ignore */ }
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
  }

  /* 12. 通用控件：分段控制 / 开关 / 评论区工具栏 */

  function buildSeg(opts, value, onPick) {
    const seg = h('div', { class: 'ytn-seg', role: 'radiogroup' });
    seg.style.setProperty('--ytn-sn', String(opts.length));
    seg.appendChild(h('span', { class: 'ytn-seg-thumb' }));
    const btns = opts.map(([v, label]) => {
      const b = h('button', { class: 'ytn-seg-btn', type: 'button', role: 'radio', 'data-v': v, text: label });
      b.addEventListener('click', () => {
        if (seg.__v === v) return;
        set(v);
        onPick(v);
      });
      seg.appendChild(b);
      return b;
    });
    function set(v) {
      seg.__v = v;
      seg.style.setProperty('--ytn-si', String(Math.max(0, opts.findIndex((o) => o[0] === v))));
      for (const b of btns) {
        const on = b.dataset.v === v;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    }
    seg.ytnSet = set;
    set(value);
    return seg;
  }

  function buildSwitch(value, onChange) {
    const sw = h('button', { class: 'ytn-switch', type: 'button', role: 'switch' }, h('span', { class: 'ytn-knob' }));
    const set = (v) => {
      sw.classList.toggle('is-on', v);
      sw.setAttribute('aria-checked', v ? 'true' : 'false');
    };
    set(!!value);
    sw.addEventListener('click', () => {
      const next = !sw.classList.contains('is-on');
      set(next);
      onChange(next);
    });
    return sw;
  }

  let toolbar = null;
  let toolbarCheck = false;

  function buildToolbar() {
    const autoBtn = h('button', {
      class: 'ytn-chip', type: 'button', 'aria-pressed': 'false', title: '滚动时自动翻译可视评论（Alt+Shift+P）',
      onclick: toggleAuto,
    }, [icon('globe', 18), h('span', { text: '自动翻译' })]);
    const seg = buildSeg(VIEWS.map((v) => [v, VIEW_LABEL[v]]), config.mode, (v) => commit({ mode: v }));
    seg.setAttribute('aria-label', '评论显示方式');
    seg.setAttribute('title', '评论显示方式（Alt+Shift+T）');
    const gear = h('button', {
      class: 'ytn-icon-btn', type: 'button', 'aria-label': '翻译设置', title: '翻译设置（Alt+Shift+S）',
      onclick: () => openPanel(),
    }, icon('tune', 20));
    const bar = h('div', { class: 'ytn-toolbar', role: 'toolbar', 'aria-label': '评论翻译' }, [autoBtn, seg, gear]);
    bar.__ytn = { autoBtn, seg };
    return bar;
  }

  function syncToolbar() {
    if (!toolbar) return;
    const { autoBtn, seg } = toolbar.__ytn;
    autoBtn.classList.toggle('is-on', config.autoTranslate);
    autoBtn.setAttribute('aria-pressed', config.autoTranslate ? 'true' : 'false');
    seg.ytnSet(config.mode);
  }

  function ensureToolbar() {
    if (!config.showToolbar) {
      if (toolbar) { toolbar.remove(); toolbar = null; }
      return;
    }
    const host = commentsRoot();
    if (!host) return;
    const header = host.querySelector('ytd-comments-header-renderer');
    if (!header) return;
    const title = header.querySelector('#title');
    const parent = title ? title.parentNode : header;
    if (toolbar && toolbar.isConnected && toolbar.parentNode === parent) return;
    if (!toolbar) toolbar = buildToolbar();
    if (title) title.after(toolbar);
    else header.appendChild(toolbar);
    syncToolbar();
  }

  /* 13. 设置面板 */

  let panelRefresh = null;

  const row = (label, control, hint, extra) => {
    if (control && control.getAttribute && !control.getAttribute('aria-label') && /switch|radiogroup/.test(control.getAttribute('role') || '')) {
      control.setAttribute('aria-label', label);
    }
    return h('div', { class: 'ytn-row' }, [
      h('div', { class: 'ytn-row-text' }, [
        h('div', { class: 'ytn-row-name' }, extra ? [h('span', { text: label }), extra] : h('span', { text: label })),
        hint ? h('div', { class: 'ytn-hint', text: hint }) : null,
      ]),
      h('div', { class: 'ytn-row-ctl' }, control),
    ]);
  };
  const sec = (t) => h('div', { class: 'ytn-sec', text: t });

  // 预览里放一条“真实评论”，所见即所得
  function buildPreview() {
    const box = buildBox();
    const out = '这首歌永远不会过时，2019 年我还用它骗了全班同学。';
    box.querySelector('.ytn-text').textContent = out;
    box.__ytnOut = out;
    box.dataset.state = 'done';
    box.style.setProperty('--ytn-fs', '14px');
    box.style.setProperty('--ytn-lh', '20px');
    const main = h('div', { class: 'ytn-pv-main' }, [
      h('div', { class: 'ytn-pv-meta' }, [h('b', { text: '@rickfan' }), h('span', { text: '  2 天前' })]),
      h('div', { class: 'ytn-pv-src', text: 'This song never gets old, still rickrolled my whole class in 2019.' }),
      box,
    ]);
    const el = h('div', { class: 'ytn-preview' }, [h('div', { class: 'ytn-pv-avatar', text: 'R' }), main]);
    paintBox(box, config.mode);
    return { el, refresh: () => paintBox(box, config.mode) };
  }

  function openPanel() {
    if (document.querySelector('.ytn-overlay')) return;
    const lastFocus = document.activeElement;
    let closing = false;
    let cur = 0;

    const overlay = h('div', { class: 'ytn-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ytn-title' });
    const panel = h('div', { class: 'ytn-panel' });
    const closeBtn = h('button', { class: 'ytn-icon-btn ytn-close', type: 'button', 'aria-label': '关闭' }, icon('close', 22));
    closeBtn.addEventListener('click', close);
    const head = h('div', { class: 'ytn-head' }, [h('div', { class: 'ytn-title', id: 'ytn-title', text: 'YouTube 评论区翻译' }), closeBtn]);

    const pages = [h('div', { class: 'ytn-page', role: 'tabpanel' }), h('div', { class: 'ytn-page', role: 'tabpanel' }), h('div', { class: 'ytn-page', role: 'tabpanel' })];
    const ind = h('span', { class: 'ytn-ptab-ind' });
    const tabBtns = ['外观', '触发', '行为'].map((name, i) => h('button', { class: 'ytn-ptab', type: 'button', role: 'tab', text: name, onclick: () => selectTab(i) }));
    const tabs = h('div', { class: 'ytn-ptabs', role: 'tablist' }, [...tabBtns, ind]);
    const body = h('div', { class: 'ytn-pbody' });

    function placeInd() {
      const b = tabBtns[cur];
      if (!b || !b.offsetWidth) return;
      ind.style.setProperty('--ytn-ix', b.offsetLeft + 'px');
      ind.style.setProperty('--ytn-iw', b.offsetWidth + 'px');
    }
    function selectTab(i) {
      cur = i;
      tabBtns.forEach((b, k) => {
        b.classList.toggle('is-on', k === i);
        b.setAttribute('aria-selected', k === i ? 'true' : 'false');
      });
      pages.forEach((p, k) => p.classList.toggle('is-on', k === i));
      body.scrollTop = 0;
      placeInd();
    }

    // 外观页
    const pv = buildPreview();
    pages[0].append(
      pv.el,
      sec('评论里的译文'),
      row('显示方式', buildSeg(VIEWS.map((v) => [v, VIEW_LABEL[v]]), config.mode, (v) => commit({ mode: v })), '双语：原文在上、译文在下。也可以在每条译文下单独切换'),
      row('外观风格', buildSeg([['quote', '色条引述'], ['card', '轻盈卡片'], ['minimal', '极简竖线']], config.style, (v) => commit({ style: v }))),
      row('动画', buildSeg([['off', '关闭'], ['medium', '适中'], ['full', '丰富']], config.motion, (v) => commit({ motion: v })), '系统开启「减少动态效果」时自动关闭'),
      sec('评论区'),
      row('显示评论区工具栏', buildSwitch(config.showToolbar, (v) => commit({ showToolbar: v })), '在评论标题下放置自动翻译、显示方式和设置入口'),
      row('隐藏原生「翻译成…」按钮', buildSwitch(config.takeoverNative, (v) => { commit({ takeoverNative: v }); toast(v ? '已隐藏原生翻译按钮' : '已恢复原生翻译按钮'); }), '开启后评论区只保留脚本的译文框'),
    );

    // 触发页
    const delayRange = h('input', { class: 'ytn-range', type: 'range', min: '0', max: '1000', step: '20', value: String(Math.min(config.hoverDelay, 1000)), 'aria-label': '悬停延迟' });
    const delayOut = h('span', { class: 'ytn-num', text: config.hoverDelay + ' ms' });
    const paintRange = () => delayRange.style.setProperty('--p', (Number(delayRange.value) / 10) + '%');
    paintRange();
    delayRange.addEventListener('input', () => { delayOut.textContent = delayRange.value + ' ms'; paintRange(); });
    delayRange.addEventListener('change', () => commit({ hoverDelay: Number(delayRange.value) }));
    pages[1].append(
      sec('悬停翻译'),
      row('启用悬停翻译', buildSwitch(config.hover, (v) => commit({ hover: v })), '鼠标停在评论上即翻译'),
      row('悬停延迟', delayRange, '0 ms 表示鼠标进入就翻译', delayOut),
      row('快速翻译修饰键', buildSeg([['none', '无'], ['alt', 'Alt'], ['ctrl', 'Ctrl'], ['shift', 'Shift']], config.modifier, (v) => commit({ modifier: v })), '按住该键悬停（或悬停时按下）会跳过延迟，立即翻译'),
      sec('滚动自动翻译'),
      row('自动翻译可视评论', buildSwitch(config.autoTranslate, (v) => commit({ autoTranslate: v })), '评论在屏幕中停留片刻后自动翻译'),
      row('同时翻译回复', buildSwitch(config.translateReplies, (v) => commit({ translateReplies: v }))),
    );

    // 行为页
    loadCache();
    const langSel = h('select', { class: 'ytn-select', 'aria-label': '目标语言' });
    for (const [v, label] of LANGS) langSel.appendChild(h('option', { value: v, text: label }));
    langSel.value = config.targetLang;
    const langRow = row('目标语言', h('span', { class: 'ytn-select-wrap' }, langSel), '');
    const langHint = langRow.querySelector('.ytn-hint') || h('div', { class: 'ytn-hint' });
    if (!langHint.parentNode) langRow.querySelector('.ytn-row-text').appendChild(langHint);
    const paintLangHint = () => { langHint.textContent = config.targetLang === 'auto' ? '当前跟随网页语言：' + pageClient().hl : '固定语言，不受网页界面语言影响'; };
    paintLangHint();
    langSel.addEventListener('change', () => { commit({ targetLang: langSel.value }); paintLangHint(); });
    const cntEl = h('span', { class: 'ytn-static', text: cache.size + ' 条' });
    pages[2].append(
      sec('翻译'),
      langRow,
      row('跳过同语言评论', buildSwitch(config.skipSame, (v) => commit({ skipSame: v })), '评论已经是目标语言时不显示译文框'),
      sec('缓存'),
      row('持久化译文缓存', buildSwitch(config.persistCache, (v) => { commit({ persistCache: v }); if (v) { cacheDirty = true; flushCacheNow(); } }), '缓存保留 3 天，最多 ' + CACHE_LIMIT + ' 条'),
      row('本地缓存条目', cntEl),
      h('div', { class: 'ytn-actions' }, [
        h('button', { class: 'ytn-btn is-primary', type: 'button', text: '翻译可视评论', onclick: () => { close(); translateVisible(); } }),
        h('button', { class: 'ytn-btn', type: 'button', text: '清空缓存', onclick: () => { clearCache(); cntEl.textContent = '0 条'; toast('已清空译文缓存'); } }),
        h('button', { class: 'ytn-btn', type: 'button', text: '恢复默认设置', onclick: () => { commit(Object.assign({}, DEFAULTS)); close(); setTimeout(openPanel, motionMs() + 80); toast('已恢复默认设置'); } }),
      ]),
    );

    const foot = h('div', { class: 'ytn-foot' }, [h('span', { text: '快捷键 Alt + Shift +' })]);
    for (const s of SHORTCUTS) foot.appendChild(h('span', { class: 'ytn-kbd-item' }, [h('kbd', { class: 'ytn-kbd', text: s[1] }), h('span', { text: s[2] })]));
    foot.appendChild(h('span', { class: 'ytn-ver', text: 'v' + VERSION }));

    body.append(...pages);
    panel.append(head, tabs, body, foot);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    selectTab(0);
    panelRefresh = () => pv.refresh();
    applyConfigDom();

    requestAnimationFrame(() => {
      overlay.classList.add('is-on');
      placeInd();
      requestAnimationFrame(() => ind.classList.add('is-ready'));
    });

    function close() {
      if (closing) return;
      closing = true;
      panelRefresh = null;
      overlay.classList.remove('is-on');
      setTimeout(() => overlay.remove(), motionMs() + 40);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', placeInd);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const f = Array.from(panel.querySelectorAll('button, select, input, [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', placeInd);
    closeBtn.focus();
  }

  /* 14. 外观注入：直接取 YouTube 自带的设计变量，亮/暗主题自动跟随，不再做主题探测 */

  function applyConfigDom() {
    root.setAttribute('data-ytn-style', config.style);
    root.setAttribute('data-ytn-motion', reducedMotion ? 'off' : config.motion);
    if (config.takeoverNative) root.setAttribute('data-ytn-hide-native', '1');
    else root.removeAttribute('data-ytn-hide-native');
  }

  // 配置变化后的统一落点（本页 commit 与跨标签页同步共用）
  function onConfigChanged(prev) {
    applyConfigDom();
    if (prev.mode !== config.mode) refreshViews();
    if (prev.targetLang !== config.targetLang || prev.skipSame !== config.skipSame) resetAll();
    else if (prev.autoTranslate !== config.autoTranslate || prev.translateReplies !== config.translateReplies) buildAutoWatch();
    ensureToolbar();
    syncToolbar();
    if (panelRefresh) panelRefresh();
  }

  let cssMode = null;

  function injectStyle() {
    if (cssMode) return;
    const css = `
/* ── 令牌：优先用 YouTube 的 --yt-spec-*，缺失时按亮/暗给兜底值 ── */
:root{
  --ytn-fg:var(--yt-spec-text-primary,#0f0f0f);
  --ytn-fg2:var(--yt-spec-text-secondary,#606060);
  --ytn-accent:var(--yt-spec-call-to-action,#065fd4);
  --ytn-layer:var(--yt-spec-10-percent-layer,rgba(0,0,0,.1));
  --ytn-chip:var(--yt-spec-badge-chip-background,rgba(0,0,0,.05));
  --ytn-chip-hv:var(--yt-spec-button-chip-background-hover,rgba(0,0,0,.1));
  --ytn-surface:var(--yt-spec-raised-background,#fff);
  --ytn-inv-bg:var(--yt-spec-inverted-background,#0f0f0f);
  --ytn-inv-fg:var(--yt-spec-text-primary-inverse,#fff);
  --ytn-danger:#cc0000;
  --ytn-knob:#f1f1f1;
  --ytn-t:160ms;
  --ytn-dy:-3px;
  --ytn-ease:cubic-bezier(.2,0,0,1);
}
html[dark]{
  --ytn-fg:var(--yt-spec-text-primary,#fff);
  --ytn-fg2:var(--yt-spec-text-secondary,#aaa);
  --ytn-accent:var(--yt-spec-call-to-action,#3ea6ff);
  --ytn-layer:var(--yt-spec-10-percent-layer,rgba(255,255,255,.1));
  --ytn-chip:var(--yt-spec-badge-chip-background,rgba(255,255,255,.1));
  --ytn-chip-hv:var(--yt-spec-button-chip-background-hover,rgba(255,255,255,.2));
  --ytn-surface:var(--yt-spec-raised-background,#212121);
  --ytn-inv-bg:var(--yt-spec-inverted-background,#f1f1f1);
  --ytn-inv-fg:var(--yt-spec-text-primary-inverse,#0f0f0f);
  --ytn-danger:#ff6e66;
}
html[data-ytn-motion="medium"]{--ytn-dy:-2px}
html[data-ytn-motion="full"]{--ytn-t:260ms;--ytn-dy:-6px}
html[data-ytn-motion="off"]{--ytn-t:0ms}

@keyframes ytn-in{from{opacity:0;transform:translateY(var(--ytn-dy))}to{opacity:1;transform:none}}
@keyframes ytn-bar{from{transform:scaleY(.15)}to{transform:none}}
@keyframes ytn-shimmer{to{transform:translateX(100%)}}
@keyframes ytn-page{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

:is(.ytn-box,.ytn-toolbar,.ytn-overlay) button{font-family:inherit}
.ytn-ico{flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
:is(.ytn-tab,.ytn-retry,.ytn-copy,.ytn-chip,.ytn-icon-btn,.ytn-seg-btn,.ytn-switch,.ytn-btn,.ytn-ptab,.ytn-select):focus-visible,
.ytn-range:focus-visible{outline:2px solid var(--ytn-accent);outline-offset:2px}

/* ── 评论里的译文框 ── */
.ytn-box{position:relative;box-sizing:border-box;max-width:100%;margin:8px 0 4px;color:var(--ytn-fg);font-family:inherit;font-size:var(--ytn-fs,14px);line-height:var(--ytn-lh,20px);font-weight:400}
.ytn-box[data-state="idle"]{display:none}
.ytn-box:not([data-state="idle"]){animation:ytn-in var(--ytn-t) var(--ytn-ease) both}
.ytn-body-wrap{display:grid;grid-template-rows:1fr;transition:grid-template-rows var(--ytn-t) var(--ytn-ease)}
.ytn-body{min-height:0;overflow:hidden}
.ytn-box[data-view="original"][data-state="done"] .ytn-body-wrap{grid-template-rows:0fr}
.ytn-box[data-view="original"][data-state="done"] .ytn-body{visibility:hidden;transition:visibility 0s linear var(--ytn-t)}
.ytn-text{white-space:pre-wrap;overflow-wrap:anywhere;color:inherit}
.ytn-box[data-state="error"] .ytn-text{display:flex;align-items:flex-start;gap:6px;color:var(--ytn-danger)}
.ytn-box[data-state="error"] .ytn-text .ytn-ico{margin-top:2px}

.ytn-skel{display:none;position:relative;overflow:hidden;border-radius:6px}
.ytn-box[data-state="loading"] .ytn-skel{display:block}
.ytn-box[data-state="loading"] .ytn-text{display:none}
.ytn-skel-line{display:block;position:relative;height:var(--ytn-lh,20px)}
.ytn-skel-line::before{content:"";position:absolute;left:0;right:0;top:4px;bottom:4px;border-radius:6px;background:var(--ytn-layer)}
.ytn-skel-line:last-child:not(:first-child){width:58%}
.ytn-skel::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent 0,color-mix(in srgb,var(--ytn-fg) 12%,transparent) 50%,transparent 100%);transform:translateX(-100%);animation:ytn-shimmer 1.4s linear infinite}

.ytn-note{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;min-height:24px;margin-top:6px;font-size:12px;line-height:18px;color:var(--ytn-fg2)}
.ytn-box[data-state="loading"] .ytn-note{visibility:hidden}
.ytn-brand{display:inline-flex;align-items:center;gap:4px}
.ytn-retry{display:none;align-items:center;gap:4px;height:24px;padding:0 10px 0 8px;border:0;border-radius:12px;background:color-mix(in srgb,var(--ytn-accent) 14%,transparent);color:var(--ytn-accent);font-size:12px;font-weight:500;cursor:pointer;transition:background-color var(--ytn-t)}
.ytn-retry:hover{background:color-mix(in srgb,var(--ytn-accent) 24%,transparent)}
.ytn-box[data-state="error"] .ytn-retry{display:inline-flex}
.ytn-box[data-state="error"] :is(.ytn-brand,.ytn-tabs,.ytn-copy){display:none}
.ytn-box[data-view="original"] :is(.ytn-brand,.ytn-copy){display:none}
.ytn-tabs{display:inline-flex;gap:2px;margin-left:2px;opacity:.72;transition:opacity var(--ytn-t)}
.ytn-copy{display:inline-grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--ytn-fg2);cursor:pointer;opacity:.72;transition:opacity var(--ytn-t),background-color var(--ytn-t),color var(--ytn-t)}
.ytn-box:hover :is(.ytn-tabs,.ytn-copy),.ytn-box:focus-within :is(.ytn-tabs,.ytn-copy){opacity:1}
.ytn-copy:hover{background:var(--ytn-layer);color:var(--ytn-fg)}
.ytn-copy.is-ok{color:var(--ytn-accent)}
.ytn-tab{height:22px;padding:0 8px;border:0;border-radius:11px;background:transparent;color:var(--ytn-fg2);font-size:12px;font-weight:500;line-height:22px;cursor:pointer;transition:background-color var(--ytn-t),color var(--ytn-t)}
.ytn-tab:hover{background:var(--ytn-chip);color:var(--ytn-fg)}
.ytn-tab.is-on{background:var(--ytn-layer);color:var(--ytn-fg)}

ytd-comment-view-model.ytn-hide-source #expander{display:none!important}
html[data-ytn-hide-native] ytd-comments .translate-button{display:none!important}

/* 三款外观 */
html[data-ytn-style="quote"] .ytn-box{padding:2px 0 2px 14px}
html[data-ytn-style="quote"] .ytn-box::before{content:"";position:absolute;left:0;top:2px;bottom:2px;width:3px;border-radius:3px;background:var(--ytn-accent);transform-origin:50% 0}
html[data-ytn-motion="full"][data-ytn-style="quote"] .ytn-box:not([data-state="idle"])::before{animation:ytn-bar var(--ytn-t) var(--ytn-ease) both}
html[data-ytn-style="card"] .ytn-box{padding:10px 14px;border-radius:12px;background:var(--ytn-chip)}
html[data-ytn-style="minimal"] .ytn-box{padding:0 0 0 12px}
html[data-ytn-style="minimal"] .ytn-box::before{content:"";position:absolute;left:0;top:2px;bottom:2px;width:2px;border-radius:2px;background:var(--ytn-fg2);opacity:.45}

/* ── 评论区工具栏 ── */
.ytn-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 16px;color:var(--ytn-fg);font-family:Roboto,Arial,sans-serif;font-size:14px;line-height:20px}
.ytn-chip{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:0;border-radius:8px;background:var(--ytn-chip);color:var(--ytn-fg);font-size:14px;font-weight:500;cursor:pointer;transition:background-color var(--ytn-t),color var(--ytn-t)}
.ytn-chip:hover{background:var(--ytn-chip-hv)}
.ytn-chip.is-on{background:var(--ytn-fg);color:var(--ytn-inv-fg)}
.ytn-chip.is-on:hover{background:var(--ytn-fg);opacity:.88}
.ytn-icon-btn{display:inline-grid;place-items:center;flex:none;width:32px;height:32px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--ytn-fg);cursor:pointer;transition:background-color var(--ytn-t)}
.ytn-icon-btn:hover{background:var(--ytn-layer)}

/* ── 分段控制 / 开关 / 滑块 / 下拉 / 按钮 ── */
.ytn-seg{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;padding:2px;border-radius:8px;background:var(--ytn-chip);isolation:isolate}
.ytn-seg-thumb{position:absolute;top:2px;bottom:2px;left:2px;width:calc((100% - 4px)/var(--ytn-sn,3));border-radius:6px;background:var(--ytn-fg);transform:translateX(calc(var(--ytn-si,0)*100%));transition:transform var(--ytn-t) var(--ytn-ease)}
.ytn-seg-btn{position:relative;z-index:1;height:28px;padding:0 14px;border:0;border-radius:6px;background:transparent;color:var(--ytn-fg2);font-size:13px;font-weight:500;line-height:28px;white-space:nowrap;cursor:pointer;transition:color var(--ytn-t)}
.ytn-seg-btn:hover{color:var(--ytn-fg)}
.ytn-seg-btn.is-on{color:var(--ytn-inv-fg)}

.ytn-switch{position:relative;flex:none;width:36px;height:14px;margin:3px 2px;padding:0;border:0;border-radius:7px;background:color-mix(in srgb,var(--ytn-fg2) 45%,transparent);cursor:pointer;transition:background-color var(--ytn-t)}
.ytn-knob{position:absolute;top:-3px;left:0;width:20px;height:20px;border-radius:50%;background:var(--ytn-knob);box-shadow:0 1px 4px rgba(0,0,0,.45);transition:transform var(--ytn-t) var(--ytn-ease),background-color var(--ytn-t),box-shadow var(--ytn-t)}
.ytn-switch:hover .ytn-knob{box-shadow:0 1px 4px rgba(0,0,0,.45),0 0 0 8px color-mix(in srgb,var(--ytn-fg) 8%,transparent)}
.ytn-switch.is-on{background:color-mix(in srgb,var(--ytn-accent) 50%,transparent)}
.ytn-switch.is-on .ytn-knob{transform:translateX(16px);background:var(--ytn-accent)}
.ytn-switch.is-on:hover .ytn-knob{box-shadow:0 1px 4px rgba(0,0,0,.45),0 0 0 8px color-mix(in srgb,var(--ytn-accent) 16%,transparent)}

.ytn-range{--p:0%;-webkit-appearance:none;appearance:none;width:160px;height:4px;margin:0;padding:8px 0;border-radius:2px;background:linear-gradient(to right,var(--ytn-accent) var(--p),var(--ytn-layer) var(--p)) content-box;outline:none;cursor:pointer}
.ytn-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border:0;border-radius:50%;background:var(--ytn-accent);box-shadow:0 0 0 0 color-mix(in srgb,var(--ytn-accent) 20%,transparent);transition:box-shadow var(--ytn-t)}
.ytn-range:hover::-webkit-slider-thumb,.ytn-range:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 8px color-mix(in srgb,var(--ytn-accent) 20%,transparent)}
.ytn-range::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:var(--ytn-accent)}
.ytn-range::-moz-range-track{background:transparent}

.ytn-select-wrap{position:relative;display:inline-block}
.ytn-select-wrap::after{content:"";position:absolute;right:13px;top:50%;width:6px;height:6px;border-right:2px solid var(--ytn-fg2);border-bottom:2px solid var(--ytn-fg2);transform:translateY(-70%) rotate(45deg);pointer-events:none}
.ytn-select{-webkit-appearance:none;appearance:none;min-width:168px;height:32px;padding:0 32px 0 12px;border:0;border-radius:8px;background:var(--ytn-chip);color:var(--ytn-fg);font-size:14px;cursor:pointer;transition:background-color var(--ytn-t)}
.ytn-select:hover{background:var(--ytn-chip-hv)}
.ytn-select option{background:var(--ytn-surface);color:var(--ytn-fg)}

.ytn-btn{height:36px;padding:0 16px;border:0;border-radius:18px;background:var(--ytn-chip);color:var(--ytn-fg);font-size:14px;font-weight:500;cursor:pointer;transition:background-color var(--ytn-t),opacity var(--ytn-t)}
.ytn-btn:hover{background:var(--ytn-chip-hv)}
.ytn-btn.is-primary{background:var(--ytn-fg);color:var(--ytn-inv-fg)}
.ytn-btn.is-primary:hover{background:var(--ytn-fg);opacity:.88}

/* ── 设置面板 ── */
.ytn-overlay{position:fixed;inset:0;z-index:999999;display:grid;place-items:center;padding:24px;background:rgba(0,0,0,.6);color:var(--ytn-fg);color-scheme:light;font-family:Roboto,Arial,sans-serif;font-size:14px;line-height:20px;opacity:0;transition:opacity var(--ytn-t) linear}
html[dark] .ytn-overlay{color-scheme:dark}
.ytn-overlay.is-on{opacity:1}
.ytn-panel{display:flex;flex-direction:column;box-sizing:border-box;width:min(640px,100%);height:min(600px,100%);overflow:hidden;border-radius:16px;background:var(--ytn-surface);box-shadow:0 12px 48px rgba(0,0,0,.45);opacity:0;transform:translateY(12px) scale(.97);transition:transform var(--ytn-t) var(--ytn-ease),opacity var(--ytn-t) var(--ytn-ease)}
.ytn-overlay.is-on .ytn-panel{opacity:1;transform:none}
.ytn-head{display:flex;align-items:center;justify-content:space-between;padding:20px 12px 8px 24px}
.ytn-title{font-size:20px;font-weight:700;line-height:28px}
.ytn-ptabs{position:relative;display:flex;padding:0 12px;border-bottom:1px solid var(--ytn-layer)}
.ytn-ptab{height:48px;padding:0 16px;border:0;background:transparent;color:var(--ytn-fg2);font-size:14px;font-weight:500;line-height:48px;cursor:pointer;transition:color var(--ytn-t)}
.ytn-ptab:hover,.ytn-ptab.is-on{color:var(--ytn-fg)}
.ytn-ptab-ind{position:absolute;left:0;bottom:-1px;width:var(--ytn-iw,0px);height:2px;border-radius:2px 2px 0 0;background:var(--ytn-fg);transform:translateX(var(--ytn-ix,0px))}
.ytn-ptab-ind.is-ready{transition:transform var(--ytn-t) var(--ytn-ease),width var(--ytn-t) var(--ytn-ease)}
.ytn-pbody{flex:1;min-height:0;padding:4px 24px 16px;overflow:auto;overscroll-behavior:contain}
.ytn-page{display:none}
.ytn-page.is-on{display:block;animation:ytn-page var(--ytn-t) var(--ytn-ease) both}
.ytn-sec{margin:20px 0 4px;color:var(--ytn-fg2);font-size:12px;font-weight:500;line-height:16px}
.ytn-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:40px;padding:8px 0}
.ytn-row-text{flex:1;min-width:0}
.ytn-row-name{display:flex;align-items:baseline;gap:8px}
.ytn-hint{margin-top:2px;color:var(--ytn-fg2);font-size:12px;line-height:16px}
.ytn-row-ctl{display:flex;flex:none;align-items:center}
.ytn-num,.ytn-static{color:var(--ytn-fg2);font-size:12px;font-variant-numeric:tabular-nums}
.ytn-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 4px}
.ytn-foot{display:flex;align-items:center;flex-wrap:wrap;gap:6px 14px;padding:12px 24px;border-top:1px solid var(--ytn-layer);color:var(--ytn-fg2);font-size:12px;line-height:16px}
.ytn-kbd-item{display:inline-flex;align-items:center;gap:6px}
.ytn-kbd{padding:1px 6px;border:1px solid var(--ytn-layer);border-radius:4px;background:var(--ytn-chip);color:var(--ytn-fg);font:500 11px/16px Roboto,Arial,sans-serif}
.ytn-ver{margin-left:auto}

.ytn-preview{display:flex;gap:12px;margin:8px 0 4px;padding:16px;border:1px solid var(--ytn-layer);border-radius:12px}
.ytn-pv-avatar{display:grid;flex:none;place-items:center;width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,var(--ytn-accent),color-mix(in srgb,var(--ytn-accent) 45%,#8e44ff));color:#fff;font-weight:500}
.ytn-pv-main{flex:1;min-width:0}
.ytn-pv-meta{color:var(--ytn-fg2);font-size:13px;line-height:18px;white-space:pre}
.ytn-pv-meta b{color:var(--ytn-fg);font-weight:500}
.ytn-pv-src{margin-top:2px}
.ytn-pv-main.ytn-hide-source .ytn-pv-src{display:none}

/* ── Snackbar ── */
.ytn-toast-host{position:fixed;left:24px;bottom:24px;z-index:1000000;pointer-events:none;font-family:Roboto,Arial,sans-serif}
.ytn-toast{box-sizing:border-box;max-width:min(420px,calc(100vw - 48px));padding:14px 16px;border-radius:8px;background:var(--ytn-inv-bg);color:var(--ytn-inv-fg);box-shadow:0 4px 16px rgba(0,0,0,.35);font-size:14px;line-height:20px;opacity:0;transform:translateY(16px);transition:opacity var(--ytn-t) var(--ytn-ease),transform var(--ytn-t) var(--ytn-ease)}
.ytn-toast.is-on{opacity:1;transform:none}

/* ── 动画关闭 / 系统减少动态效果 ── */
html[data-ytn-motion="off"] :is(.ytn-box,.ytn-box *,.ytn-toolbar *,.ytn-overlay,.ytn-overlay *,.ytn-toast),
html[data-ytn-motion="off"] :is(.ytn-box,.ytn-skel)::before,
html[data-ytn-motion="off"] :is(.ytn-box,.ytn-skel)::after{animation:none!important;transition:none!important}
@media (prefers-reduced-motion:reduce){
  :is(.ytn-box,.ytn-box *,.ytn-toolbar *,.ytn-overlay,.ytn-overlay *,.ytn-toast),
  :is(.ytn-box,.ytn-skel)::before,:is(.ytn-box,.ytn-skel)::after{animation:none!important;transition:none!important}
}
`;
    cssMode = injectCss(css);
  }

  // YouTube 的 CSP 可能拦内联 <style>，优先用 GM_addStyle / 构造样式表
  function injectCss(css) {
    try {
      if (typeof GM_addStyle === 'function') { GM_addStyle(css); return 'gm'; }
    } catch (e) { /* fall through */ }
    try {
      if (typeof CSSStyleSheet === 'function' && CSSStyleSheet.prototype.replaceSync) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = document.adoptedStyleSheets.concat(sheet);
        return 'adopted';
      }
    } catch (e) { /* fall through */ }
    try {
      const el = h('style', { type: 'text/css' });
      el.textContent = css;
      document.head.appendChild(el);
      return 'style-tag';
    } catch (e) {
      log('样式注入失败', e);
      return 'failed';
    }
  }

  /* 15. 变更监听 */

  let scanTimer = 0;
  const dirty = new Set();
  let discover = false;

  function inComments(node) {
    return !!(node && node.closest && node.closest('ytd-comments'));
  }

  // 新增节点只做 O(1) 归属判断：落在已处理的评论里就检查文本是否被换掉，
  // 其余批量发现留到 flush 时对评论区做一次扫描，避免每个节点都扫整棵子树
  function onMutations(muts) {
    let found = 0;
    for (const m of muts) {
      const added = m.addedNodes;
      if (!added || !added.length) continue;
      for (let i = 0; i < added.length; i++) {
        const n = added[i];
        if (!n || n.nodeType !== 1 || ownNode(n)) continue;
        const host = n.localName === VM_SEL ? n : n.closest(VM_SEL);
        if (host) {
          if (host !== n) {
            if (isSettled(host)) { dirty.add(host); found++; }
          } else if (autoObserver) {
            discover = true;
            found++;
          }
          continue;
        }
        if (!inComments(n)) continue;
        toolbarCheck = true;
        if (autoObserver) discover = true;
        found++;
      }
    }
    if (found && !scanTimer) scanTimer = setTimeout(flushMutations, 120);
  }

  function flushMutations() {
    scanTimer = 0;
    if (toolbarCheck) {
      toolbarCheck = false;
      ensureToolbar();
    }
    if (dirty.size) {
      const list = Array.from(dirty);
      dirty.clear();
      const lang = targetLang();
      for (const vm of list) {
        if (!vm.isConnected) continue;
        const s = states.get(vm);
        if (!s || !s.sig) continue;
        // 评论文本被 YouTube 换掉（编辑、复用节点）→ 作废旧译文
        if (s.sig !== hash32(commentText(vm)) + '|' + lang) {
          removeBox(vm);
          s.done = s.same = s.fail = '';
          s.sig = '';
          s.view = null;
        }
      }
    }
    if (!discover) return;
    discover = false;
    if (!autoObserver) return;
    const host = commentsRoot();
    if (!host) return;
    for (const vm of host.querySelectorAll(VM_SEL)) {
      if (ownNode(vm)) continue;
      if (!config.translateReplies && isReplyVM(vm)) { st(vm).obsGen = autoGen; continue; }
      observeAuto(vm);
    }
  }

  /* 16. 初始化 */

  const primeSoon = debounce(() => { primeAuto(); ensureToolbar(); }, 1200);

  function onNavigate() {
    resetAll();
    setTimeout(ensureToolbar, 900);
  }

  function init() {
    injectStyle();
    applyConfigDom();
    new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('mouseover', onMouseOver, { passive: true });
    document.addEventListener('mouseout', onMouseOut, { passive: true });
    document.addEventListener('scroll', () => { clearTimeout(hoverTimer); hoverTimer = 0; hoverVM = null; }, { passive: true });
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('yt-navigate-finish', onNavigate);
    window.addEventListener('yt-page-data-updated', primeSoon);
    window.addEventListener('pagehide', flushCacheNow);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushCacheNow();
      else pump();
    });
    buildAutoWatch();
    ensureToolbar();
    if (typeof GM_addValueChangeListener === 'function') {
      try {
        // 其他标签页改了设置 → 本页同步（本页自己的写入已经由 commit 处理）
        GM_addValueChangeListener(CONFIG_KEY, (k, o, nv, remote) => {
          if (!remote) return;
          const prev = config;
          config = sanitize(nv);
          onConfigChanged(prev);
        });
      } catch (e) { /* ignore */ }
    }
    if (typeof GM_registerMenuCommand === 'function') {
      try {
        GM_registerMenuCommand('YouTube 评论翻译设置', () => openPanel());
        GM_registerMenuCommand('切换显示方式（译文/双语/原文）', toggleMode);
        GM_registerMenuCommand('翻译全部可视评论', translateVisible);
        GM_registerMenuCommand('开关自动翻译', toggleAuto);
        GM_registerMenuCommand('清空译文缓存', () => { clearCache(); toast('已清空译文缓存'); });
      } catch (e) { log('菜单注册失败', e); }
    }
    log('已就绪 v' + VERSION + ' · 目标语言', targetLang(), '· 客户端', pageClient().clientVersion);
  }

  const boot = () => {
    if (document.body) init();
    else setTimeout(boot, 200);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();