// ==UserScript==
// @name         YouTube 评论区原生翻译（免 API Key）
// @name:en      YouTube Native Comment Translator
// @namespace    https://github.com/Noctyn/yt-native-translator
// @homepageURL  https://github.com/Noctyn/yt-native-translator
// @supportURL   https://github.com/Noctyn/yt-native-translator/issues
// @updateURL    https://raw.githubusercontent.com/Noctyn/yt-native-translator/main/yt-native-translator.user.js
// @downloadURL  https://raw.githubusercontent.com/Noctyn/yt-native-translator/main/yt-native-translator.user.js
// @version      0.1.3
// @description  复用 YouTube 网页端自带的评论翻译接口，免第三方 API Key 与自建代理：悬停即译、滚动自动翻译、译文/双语/原文一键切换，本地缓存 + 三款外观。
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
// ==/UserScript==

(function () {
  'use strict';

  const root = document.documentElement;
  if (root.hasAttribute('data-ytn-loaded')) return;
  root.setAttribute('data-ytn-loaded', '1');

  /* 1. 常量 */

  const ENDPOINT = '/youtubei/v1/comment/perform_comment_action?prettyPrint=false';
  const ACTION_TRANSLATE = 22;
  // 接口要求 context.client.clientVersion 非空（为空会 404）；页面取不到时用这个兜底
  const FALLBACK_CLIENT_VERSION = '2.20261023.01.00';
  const CONFIG_KEY = 'ytn_config_v1';
  const CACHE_KEY = 'ytn_cache_v1';
  const MODE_KEY = 'ytn_mode_v1';
  const OWN_SEL = '.ytn-box, .ytn-overlay, .ytn-toast-host';
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

  const LANGS = [
    ['auto', '跟随界面语言'],
    ['zh-CN', '简体中文'],
    ['zh-TW', '繁體中文'],
    ['en', 'English'],
    ['ja', '日本語'],
    ['ko', '한국어'],
    ['ru', 'Русский'],
    ['es', 'Español'],
    ['fr', 'Français'],
    ['de', 'Deutsch'],
    ['it', 'Italiano'],
    ['pt', 'Português'],
    ['ar', 'العربية'],
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
  });

  /* 2. 小工具 */

  const now = () => Date.now();
  const clamp = (v, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') el.setAttribute('style', v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    if (kids) for (const kid of [].concat(kids)) if (kid) el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
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

  function log(...args) {
    try { console.warn(TAG, ...args); } catch (e) { /* ignore */ }
  }

  /* 3. 存储（Tampermonkey 优先，退回 localStorage） */

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
    c.mode = pick(c.mode, ['translation', 'bilingual', 'original'], 'bilingual');
    c.style = pick(c.style, ['quote', 'card', 'minimal'], 'quote');
    c.motion = pick(c.motion, ['off', 'medium', 'full'], 'medium');
    c.modifier = pick(c.modifier, ['none', 'alt', 'ctrl', 'shift'], 'none');
    c.hoverDelay = clamp(Math.round(c.hoverDelay), 0, 1200);
    for (const k of ['hover', 'skipSame', 'autoTranslate', 'translateReplies', 'takeoverNative', 'persistCache']) c[k] = !!c[k];
    return c;
  }

  let config = sanitize(readStore(CONFIG_KEY, {}));

  function saveConfig() {
    writeStore(CONFIG_KEY, config);
    applyConfigDom();
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

  function pageClient() {
    const cfg = window.ytcfg;
    const data = (cfg && cfg.data_) || {};
    const ctxClient = (cfg && cfg.get && cfg.get('INNERTUBE_CONTEXT') || data.INNERTUBE_CONTEXT || {}).client || {};
    const client = {
      hl: ctxClient.hl || (cfg && cfg.get && cfg.get('HL')) || data.HL || root.lang || 'en',
      gl: ctxClient.gl || (cfg && cfg.get && cfg.get('GL')) || data.GL || 'US',
      clientName: 'WEB',
      clientVersion: ctxClient.clientVersion || (cfg && cfg.get && cfg.get('INNERTUBE_CLIENT_VERSION')) || data.INNERTUBE_CLIENT_VERSION || FALLBACK_CLIENT_VERSION,
      visitorData: ctxClient.visitorData || (cfg && cfg.get && cfg.get('VISITOR_DATA')) || data.VISITOR_DATA || '',
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
  let clientOverride = null;

  function breakerPause(ms) {
    deadUntil = Math.max(deadUntil, now() + ms);
  }

  function timedFetch(url, options, ms) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    return fetch(url, Object.assign({ credentials: 'same-origin', signal: ac.signal }, options))
      .finally(() => clearTimeout(t));
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
    const res = await timedFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-visitor-id': cl.visitorData,
        'x-youtube-client-name': '1',
        'x-youtube-client-version': cl.clientVersion,
      },
      body: JSON.stringify(body),
    }, FETCH_TIMEOUT);

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

  function retryMsFrom(res) {
    const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    if (ra > 0) return clamp(ra * 1000, 5000, 5 * 60 * 1000);
    const rl = Number(res.headers && res.headers.get && res.headers.get('x-rate-limit-reset'));
    if (rl > 1e9) return clamp(rl * 1000 - now(), 5000, 5 * 60 * 1000);
    return 0;
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
          if (!e || (!e.retryable && !/^HTTP|^http /.test(String(e.message)))) break;
          await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        }
      }
      if (err) throw err;
    }
    return parts.join('\n');
  }

  /* 5. 缓存（LRU + 可选持久化） */

  const cache = new Map();
  let cacheLoaded = false;

  function loadCache() {
    if (cacheLoaded) return;
    cacheLoaded = true;
    const raw = readStore(CACHE_KEY, null);
    if (!Array.isArray(raw)) return;
    const cut = now() - CACHE_TTL;
    for (const [k, v] of raw) if (v && v.t > cut && typeof v.v === 'string') cache.set(k, v);
  }

  let cacheDirty = false;

  function flushCacheNow() {
    if (!config.persistCache || !cacheDirty) return;
    cacheDirty = false;
    const merged = new Map();
    try {
      const raw = readStore(CACHE_KEY, null);
      if (Array.isArray(raw)) for (const [k, v] of raw) if (v && v.t > now() - CACHE_TTL) merged.set(k, v);
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

  /* 6. 语言判定 */

  const RE_SCRIPT = [
    ['ja', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
    ['ko', /[\p{Script=Hangul}]/gu],
    ['ru', /[\p{Script=Cyrillic}]/gu],
    ['ar', /[\p{Script=Arabic}\p{Script=Hebrew}]/gu],
    ['th', /[\p{Script=Thai}]/gu],
    ['el', /[\p{Script=Greek}]/gu],
    ['hi', /[\p{Script=Devanagari}]/gu],
  ];

  function cleanText(text) {
    return String(text || '').replace(/https?:\/\/\S+/g, ' ').replace(/[@#][\w.\-_]{2,40}/g, ' ');
  }

  function detectLang(text) {
    const s = cleanText(text);
    const letters = (s.match(/\p{L}/gu) || []).length;
    if (letters < 3) return 'other';
    for (const [name, re] of RE_SCRIPT) {
      if ((s.match(re) || []).length / letters > 0.08) return name;
    }
    const han = (s.match(/[\p{Script=Han}]/gu) || []).length;
    if (han / letters > 0.3) return 'zh';
    return 'latin';
  }

  function familyOf(lang) {
    const l = String(lang || '').toLowerCase();
    if (l.startsWith('zh')) return 'zh';
    if (l.startsWith('ja')) return 'ja';
    if (l.startsWith('ko')) return 'ko';
    if (l.startsWith('ru')) return 'ru';
    if (l.startsWith('ar')) return 'ar';
    if (l.startsWith('th')) return 'th';
    if (l.startsWith('el')) return 'el';
    if (l.startsWith('hi')) return 'hi';
    if (l.startsWith('en') || l.startsWith('es') || l.startsWith('fr') || l.startsWith('de') || l.startsWith('it') || l.startsWith('pt') || l.startsWith('vi') || l.startsWith('id')) return 'latin';
    return 'other';
  }

  function isSameLang(text, lang) {
    const d = detectLang(text);
    if (d === 'other') return false;
    return d === familyOf(lang);
  }

  /* 7. 评论区 DOM */

  function ownNode(el) {
    return !!(el && el.closest && el.closest(OWN_SEL));
  }

  function commentVM(el) {
    const vm = el && el.closest ? el.closest(VM_SEL) : null;
    if (!vm) return null;
    if (ownNode(vm)) return null;
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

  /* 8. 结果框渲染 */

  const VIEWS = ['translation', 'bilingual', 'original'];
  const VIEW_LABEL = { translation: '译文', bilingual: '对照', original: '原文' };
  let globalMode = readStore(MODE_KEY, null);
  if (!['translation', 'bilingual', 'original'].includes(globalMode)) globalMode = config.mode;

  function styleVarsFor(box, srcNode) {
    const cs = srcNode ? getComputedStyle(srcNode) : null;
    box.style.setProperty('--ytn-fs', cs ? cs.fontSize : '13px');
    box.style.setProperty('--ytn-lh', cs ? cs.lineHeight : '1.4');
    box.style.setProperty('--ytn-color', cs ? cs.color : 'inherit');
    box.style.setProperty('--ytn-weight', cs ? cs.fontWeight : '400');
  }

  function mountBox(vm, srcNode) {
    let box = vm.querySelector(':scope > .ytn-box') || vm.querySelector('.ytn-box');
    if (box) return box;
    probeTheme();
    box = h('div', { class: 'ytn-box', 'data-state': 'idle', 'data-view': globalMode, role: 'status', 'aria-live': 'polite' });
    styleVarsFor(box, srcNode);

    const tabs = h('div', { class: 'ytn-tabs', role: 'group', 'aria-label': '显示方式' });
    ['translation', 'bilingual', 'original'].forEach((v) => {
      tabs.appendChild(h('button', {
        class: 'ytn-tab', type: 'button', 'data-view': v, text: VIEW_LABEL[v], 'aria-pressed': 'false',
        onclick: (e) => {
          e.stopPropagation();
          applyBoxView(box, vm, v);
          if (config.motion !== 'off' && v !== 'original') animateIn(box);
        },
      }));
    });

    const note = h('div', { class: 'ytn-note' }, [
      h('span', { class: 'ytn-brand', text: 'Google 翻译' }),
      h('button', { class: 'ytn-retry', type: 'button', text: '重试', onclick: (e) => { e.stopPropagation(); delete vm.__ytnDone; runVM(vm, true); } }),
      tabs,
    ]);
    const wrap = h('div', { class: 'ytn-body-wrap' }, h('div', { class: 'ytn-body' }, h('div', { class: 'ytn-text' })));

    box.append(wrap, note);
    const anchor = vm.querySelector('#expander') || srcNode || vm;
    (anchor.parentNode || vm).insertBefore(box, anchor.nextSibling);
    applyBoxView(box, vm, globalMode);
    return box;
  }

  function applyBoxView(box, vm, view) {
    box.dataset.view = view;
    if (vm) {
      vm.dataset.ytnView = view;
      vm.classList.toggle('ytn-hide-source', view === 'translation');
    }
    for (const t of box.querySelectorAll('.ytn-tab')) {
      const on = t.dataset.view === view;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  // 全局切换只写一次存储，不再在每挂载一个结果框时都同步写设置
  function setGlobalView(view, persist) {
    if (!VIEWS.includes(view)) view = 'bilingual';
    globalMode = view;
    if (persist) writeStore(MODE_KEY, view);
    for (const vm of document.querySelectorAll(VM_SEL)) {
      const box = vm.querySelector('.ytn-box');
      if (box) applyBoxView(box, vm, view);
    }
  }

  function setState(box, state) {
    box.dataset.state = state;
    box.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  }

  function renderResult(vm, text, state) {
    const box = vm.querySelector('.ytn-box');
    if (!box) return;
    const target = box.querySelector('.ytn-text');
    target.textContent = text || '';
    setState(box, state);
    if (state === 'done') applyBoxView(box, vm, globalMode);
  }

  function removeBox(vm) {
    const box = vm.querySelector('.ytn-box');
    if (box) box.remove();
    vm.classList.remove('ytn-hide-source');
    delete vm.dataset.ytnView;
  }

  function animateIn(box) {
    if (config.motion === 'off' || !box.animate) return;
    try {
      box.animate([{ opacity: 0, transform: 'translateY(-2px)' }, { opacity: 1, transform: 'none' }], { duration: config.motion === 'full' ? 180 : 110, easing: 'ease-out' });
    } catch (e) { /* ignore */ }
  }

  function friendlyError(err) {
    const m = String((err && err.message) || err || '');
    if (m === 'paused') return '翻译暂时暂停，稍后自动恢复';
    if (m === 'auth') return '登录状态失效，请刷新页面';
    if (m === 'rate') return '翻译过于频繁，稍后自动继续';
    if (m === 'endpoint') return '原生翻译接口暂时不可用，点「重试」或稍后自动恢复';
    if (m === 'empty') return '没有可用译文';
    if (/abort/i.test(m)) return '请求超时';
    if (/Failed to fetch|NetworkError/i.test(m)) return '网络请求失败';
    return '翻译失败';
  }

  /* 9. 任务队列 */

  const queue = new Set();
  let running = 0;
  let queueTimer = 0;
  let pumpQueued = false;
  let pausedUntil = 0;

  function measureDist(vm) {
    if (typeof vm.__ytnDist === 'number') return vm.__ytnDist;
    if (!vm.getBoundingClientRect) return Infinity;
    const r = vm.getBoundingClientRect();
    return Math.abs((r.top + r.height / 2) - innerHeight / 2);
  }

  function enqueueVM(vm, dist) {
    if (!vm || !vm.isConnected || vm.__ytnQueued) return;
    vm.__ytnQueued = 1;
    vm.__ytnDist = typeof dist === 'number' ? dist : measureDist(vm);
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

  // 入队时记录一次距离，pump 热路径不再读布局；否则批量入队会变成 O(n²) 强制重排
  function takeNext() {
    let best = null;
    let bestDist = Infinity;
    for (const vm of queue) {
      if (!vm.isConnected) {
        queue.delete(vm);
        vm.__ytnQueued = 0;
        continue;
      }
      const d = typeof vm.__ytnDist === 'number' ? vm.__ytnDist : Infinity;
      if (best === null || d < bestDist) { bestDist = d; best = vm; }
    }
    if (best) {
      queue.delete(best);
      best.__ytnQueued = 0;
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

  async function runVM(vm, force) {
    const srcNode = textNodeOf(vm);
    const text = commentText(vm);
    if (!srcNode || text.length < 2) return false;
    if (config.translateReplies === false && isReplyVM(vm)) return false;

    const lang = targetLang();
    const textKey = text.length + '|' + lang;
    vm.__ytnKey = textKey;
    if (force) resetBreaker();

    if (config.skipSame && isSameLang(text, lang)) {
      if (!vm.__ytnSame) {
        vm.__ytnSame = 1;
        const box = vm.querySelector('.ytn-box');
        if (box) removeBox(vm);
      }
      return false;
    }
    if (!force && (vm.__ytnDone === text + lang || vm.__ytnFailKey === text + lang)) return false;

    const box = mountBox(vm, srcNode);
    const id = commentIdOf(vm, text);
    const key = cacheKey(text, lang, id);
    loadCache();
    const hit = cacheGet(key);
    if (hit && !force) {
      vm.__ytnDone = text + lang;
      delete vm.__ytnFailKey;
      renderResult(vm, hit, 'done');
      return false;
    }

    setState(box, 'loading');
    try {
      const out = await dedupe(key, () => (cacheGet(key) ? Promise.resolve(cacheGet(key)) : translate(text, lang, id)));
      if (!vm.isConnected || vm.__ytnKey !== textKey) return true;
      cacheSet(key, out);
      vm.__ytnDone = text + lang;
      delete vm.__ytnFailKey;
      renderResult(vm, out, 'done');
      return true;
    } catch (err) {
      if (err && err.defer) {
        if ((vm.__ytnDefers | 0) < 3) {
          vm.__ytnDefers = (vm.__ytnDefers | 0) + 1;
          enqueueVM(vm);
          return true;
        }
      }
      if (err && String(err.message) === 'paused') {
        vm.__ytnDefers = 0;
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
      vm.__ytnFailKey = textKey;
      if (!vm.isConnected) return true;
      renderResult(vm, friendlyError(err), 'error');
      log('翻译失败', (err && err.message === 'endpoint' ? 'HTTP ' + (err.status || '?') : (err && err.message) || err));
      return true;
    }
  }

  /* 10. 触发：悬停、自动、接管原生按钮 */

  let hoverTimer = 0;
  let hoverVM = null;
  const modDown = { alt: false, ctrl: false, shift: false };
  const MOD_KEYS = { AltLeft: 'alt', AltRight: 'alt', ControlLeft: 'ctrl', ControlRight: 'ctrl', ShiftLeft: 'shift', ShiftRight: 'shift' };

  function modifierOk() {
    if (config.modifier === 'none') return true;
    return !!modDown[config.modifier];
  }

  function isEditable(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('input, textarea, [contenteditable="true"], [role="textbox"]');
  }

  function onMouseOver(e) {
    if (!config.hover || isEditable(e.target)) return;
    const vm = commentVM(e.target);
    if (!vm || vm === hoverVM) return;
    hoverVM = vm;
    if (vm.__ytnDone || vm.__ytnSame || vm.__ytnFailKey) return;
    const wantsMod = config.modifier !== 'none';
    const immediate = config.hoverDelay <= 0 || (wantsMod && modifierOk());
    const delay = immediate ? 0 : config.hoverDelay;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      hoverTimer = 0;
      if (vm.isConnected) enqueueVM(vm);
    }, delay);
  }

  function onMouseOut() {
    hoverVM = null;
    clearTimeout(hoverTimer);
    hoverTimer = 0;
  }

  function onKeyDown(e) {
    if (MOD_KEYS[e.code]) modDown[MOD_KEYS[e.code]] = true;
    if (!e.altKey || !e.shiftKey) return;
    const k = (e.key || '').toUpperCase();
    if (k === 'S') { openPanel(); e.preventDefault(); }
    else if (k === 'T') { toggleMode(); e.preventDefault(); }
    else if (k === 'A') { translateVisible(); e.preventDefault(); }
    else if (k === 'P') { config.autoTranslate = !config.autoTranslate; saveConfig(); toast(config.autoTranslate ? '已开启自动翻译' : '已关闭自动翻译'); buildAutoWatch(); e.preventDefault(); }
    else if (k === 'C') { clearCache(); toast('已清空译文缓存'); e.preventDefault(); }
  }

  function onKeyUp(e) {
    if (MOD_KEYS[e.code]) modDown[MOD_KEYS[e.code]] = false;
  }

  function toggleMode() {
    const order = VIEWS;
    globalMode = order[(order.indexOf(globalMode) + 1) % order.length];
    setGlobalView(globalMode, true);
    toast('显示方式：' + VIEW_LABEL[globalMode]);
  }

  function eachCommentVM(cb) {
    const host = commentsRoot();
    if (!host) return;
    for (const vm of host.querySelectorAll(VM_SEL)) {
      if (ownNode(vm)) continue;
      if (config.translateReplies === false && isReplyVM(vm)) continue;
      cb(vm);
    }
  }

  function translateVisible() {
    let n = 0;
    eachCommentVM((vm) => {
      if (vm.__ytnDone || vm.__ytnSame || vm.__ytnFailKey) return;
      const r = vm.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return;
      enqueueVM(vm, Math.abs((r.top + r.height / 2) - innerHeight / 2));
      n++;
    });
    toast(n ? '正在翻译 ' + n + ' 条评论' : '可视评论都已翻译');
  }

  let autoObserver = null;
  let autoGen = 0;

  function autoEnabled() {
    return !!config.autoTranslate && typeof IntersectionObserver === 'function';
  }

  function observeAuto(vm) {
    if (!autoObserver || vm.__ytnObsGen === autoGen) return;
    vm.__ytnObsGen = autoGen;
    try { autoObserver.observe(vm); } catch (e) { /* ignore */ }
  }

  function onAutoEntries(entries) {
    for (const en of entries) {
      const vm = en.target;
      const rect = en.boundingClientRect || { top: 0, bottom: 0, height: 0 };
      vm.__ytnVisible = !!(en.isIntersecting && (en.intersectionRatio >= 0.3 || rect.height > innerHeight * 0.35));
      vm.__ytnDist = Math.abs((rect.top + rect.bottom) / 2 - innerHeight / 2);
      if (!vm.__ytnVisible) {
        clearTimeout(vm.__ytnDwell);
        continue;
      }
      if (vm.__ytnDone || vm.__ytnSame || vm.__ytnFailKey) continue;
      clearTimeout(vm.__ytnDwell);
      vm.__ytnDwell = setTimeout(() => {
        vm.__ytnDwell = 0;
        if (!config.autoTranslate || !vm.isConnected || !vm.__ytnVisible) return;
        if (vm.__ytnDone || vm.__ytnSame || vm.__ytnFailKey) return;
        enqueueVM(vm, vm.__ytnDist);
      }, AUTO_DWELL);
    }
  }

  function teardownAuto() {
    if (autoObserver) { autoObserver.disconnect(); autoObserver = null; }
    autoGen++;
  }

  // 只在初始化/导航/开关变化时重建；新加载的评论走增量观察，避免每次滚动都重建观察器
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

  function onNativeClick(e) {
    if (!config.takeoverNative) return;
    const btn = e.target && e.target.closest ? e.target.closest('ytd-tri-state-button-view-model.translate-button, .translate-button') : null;
    if (!btn) return;
    const vm = commentVM(btn);
    if (!vm) return;
    e.stopPropagation();
    e.preventDefault();
    vm.__ytnDone = '';
    runVM(vm, true);
  }

  /* 11. 提示 */

  let toastHost = null;

  function toast(msg) {
    if (!toastHost || !toastHost.isConnected) {
      toastHost = h('div', { class: 'ytn-toast-host' });
      document.body.appendChild(toastHost);
    }
    const el = h('div', { class: 'ytn-toast', text: msg });
    toastHost.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-on'));
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 400);
    }, 2400);
  }

  /* 12. 设置面板 */

  function buildSeg(opts, value, onPick) {
    const seg = h('div', { class: 'ytn-seg' });
    seg.style.setProperty('--ytn-sn', String(opts.length));
    const idx = Math.max(0, opts.findIndex((o) => o[0] === value));
    seg.style.setProperty('--ytn-si', String(idx));
    seg.appendChild(h('span', { class: 'ytn-seg-thumb' }));
    for (const [v, label] of opts) {
      seg.appendChild(h('button', {
        class: 'ytn-seg-btn' + (v === value ? ' is-on' : ''), type: 'button', 'data-v': v, text: label,
        onclick: (ev) => {
          const self = ev.currentTarget;
          for (const b of seg.querySelectorAll('.ytn-seg-btn')) b.classList.toggle('is-on', b === self);
          seg.style.setProperty('--ytn-si', String(opts.findIndex((o) => o[0] === v)));
          onPick(v);
        },
      }));
    }
    return seg;
  }

  function buildSwitch(value, onChange) {
    const sw = h('button', { class: 'ytn-switch' + (value ? ' is-on' : ''), type: 'button', role: 'switch' });
    sw.setAttribute('aria-checked', value ? 'true' : 'false');
    sw.append(h('span', { class: 'ytn-knob' }));
    sw.addEventListener('click', () => {
      const next = !sw.classList.contains('is-on');
      sw.classList.toggle('is-on', next);
      sw.setAttribute('aria-checked', next ? 'true' : 'false');
      onChange(next);
    });
    return sw;
  }

  const row = (label, control, hint, valueNode) => h('div', { class: 'ytn-row' }, [
    h('div', { class: 'ytn-row-label' }, [
      h('span', { class: 'ytn-row-name' }, valueNode ? [h('span', { text: label }), valueNode] : label),
      hint ? h('span', { class: 'ytn-hint', text: hint }) : null,
    ]),
    control,
  ]);
  const sec = (t) => h('div', { class: 'ytn-sec', text: t });
  const divider = () => h('div', { class: 'ytn-divider' });

  function previewBox(host, mode) {
    host.textContent = '';
    const src = h('div', { class: 'ytn-pv-src' }, h('span', { text: 'This song never gets old, still rickrolled my whole class in 2019.' }));
    const box = h('div', { class: 'ytn-box', 'data-state': 'done', 'data-view': mode });
    box.style.setProperty('--ytn-fs', '13px');
    box.style.setProperty('--ytn-lh', '1.4');
    const tabs = h('div', { class: 'ytn-tabs' });
    ['translation', 'bilingual', 'original'].forEach((v) => {
      tabs.appendChild(h('span', { class: 'ytn-tab' + (v === mode ? ' is-on' : ''), text: VIEW_LABEL[v] }));
    });
    box.append(
      h('div', { class: 'ytn-body-wrap' }, h('div', { class: 'ytn-body' }, h('div', { class: 'ytn-text', text: '这首歌永远不会过时，2019 年我还用它骗了全班同学。' }))),
      h('div', { class: 'ytn-note' }, [h('span', { class: 'ytn-brand', text: 'Google 翻译' }), h('button', { class: 'ytn-retry', type: 'button', text: '重试' }), tabs])
    );
    host.append(src, box);
    host.classList.toggle('ytn-hide-source', mode === 'translation');
  }

  function openPanel() {
    if (document.querySelector('.ytn-overlay')) return;
    probeTheme(true);
    let draft = Object.assign({}, config);
    const overlay = h('div', { class: 'ytn-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'YouTube 评论区翻译设置' });
    const panel = h('div', { class: 'ytn-panel' });
    const lastFocus = document.activeElement;

    const head = h('div', { class: 'ytn-head' }, [
      h('div', { class: 'ytn-title', text: 'YouTube 评论区翻译' }),
      h('button', { class: 'ytn-close', type: 'button', 'aria-label': '关闭', text: '×', onclick: close }),
    ]);

    const tabs = h('div', { class: 'ytn-ptabs' });
    const pages = [h('div', { class: 'ytn-page is-on' }), h('div', { class: 'ytn-page' }), h('div', { class: 'ytn-page' })];
    ['外观', '触发', '行为'].forEach((name, i) => {
      tabs.appendChild(h('button', { class: 'ytn-ptab' + (i === 0 ? ' is-on' : ''), type: 'button', text: name, onclick: () => {
        for (const [k, b] of tabs.querySelectorAll('.ytn-ptab').entries()) b.classList.toggle('is-on', k === i);
        for (const [k, p] of pages.entries()) p.classList.toggle('is-on', k === i);
      } }));
    });

    const body = h('div', { class: 'ytn-pbody' });
    const commit = (patch) => { Object.assign(draft, patch); config = sanitize(draft); saveConfig(); };

    // 外观页
    const pvHost = h('div', { class: 'ytn-preview' });
    pages[0].append(
      sec('显示与外观'),
      row('默认显示方式', buildSeg([['translation', '译文'], ['bilingual', '双语'], ['original', '原文']], draft.mode, (v) => { setGlobalView(v, true); previewBox(pvHost, v); commit({ mode: v }); })),
      pvHost,
      row('外观风格', buildSeg([['quote', '色条引述'], ['card', '轻盈卡片'], ['minimal', '极简竖线']], draft.style, (v) => { commit({ style: v }); })),
      row('动画档位', buildSeg([['off', '无'], ['medium', '中等'], ['full', '全部']], draft.motion, (v) => commit({ motion: v }))),
      divider(),
      row('隐藏原生「翻译成…」按钮', buildSwitch(draft.takeoverNative, (v) => { commit({ takeoverNative: v }); toast(v ? '已隐藏原生翻译按钮' : '已恢复原生翻译按钮'); }), '开启后评论区只保留脚本译文框；关闭可恢复网页自带按钮'),
    );

    // 触发页
    const delayRange = h('input', { class: 'ytn-range', type: 'range', min: '0', max: '1000', step: '20', value: String(draft.hoverDelay) });
    const delayOut = h('span', { class: 'ytn-num', text: draft.hoverDelay + 'ms' });
    delayRange.addEventListener('input', () => { delayOut.textContent = delayRange.value + 'ms'; });
    delayRange.addEventListener('change', () => commit({ hoverDelay: Number(delayRange.value) }));
    pages[1].append(
      sec('悬停翻译'),
      row('启用悬停翻译', buildSwitch(draft.hover, (v) => commit({ hover: v }))),
      row('悬停延迟', delayRange, '0ms 表示鼠标进入即翻译', delayOut),
      row('防误触修饰键', buildSeg([['none', '无'], ['alt', 'Alt'], ['ctrl', 'Ctrl'], ['shift', 'Shift']], draft.modifier, (v) => commit({ modifier: v })), '按住该键时悬停立即翻译'),
      divider(),
      sec('滚动自动翻译'),
      row('自动翻译可视评论', buildSwitch(draft.autoTranslate, (v) => { commit({ autoTranslate: v }); buildAutoWatch(); })),
      row('同时翻译回复', buildSwitch(draft.translateReplies, (v) => { commit({ translateReplies: v }); buildAutoWatch(); })),
    );

    // 行为页
    const langSel = h('select', { class: 'ytn-select' });
    for (const [v, label] of LANGS) langSel.appendChild(h('option', { value: v, text: label, selected: v === draft.targetLang }));
    langSel.addEventListener('change', () => { commit({ targetLang: langSel.value }); for (const vm of document.querySelectorAll(VM_SEL)) { delete vm.__ytnDone; if (vm.querySelector('.ytn-box')) renderResult(vm, '', 'idle'); } });
    pages[2].append(
      sec('翻译'),
      row('目标语言', langSel, draft.targetLang === 'auto' ? '当前跟随网页语言：' + pageClient().hl : '固定语言，不受网页界面语言影响'),
      row('跳过同语言评论', buildSwitch(draft.skipSame, (v) => commit({ skipSame: v }))),
      divider(),
      sec('缓存'),
      row('持久化译文缓存', buildSwitch(draft.persistCache, (v) => { commit({ persistCache: v }); if (v) { cacheDirty = true; flushCacheNow(); } })),
      row('本地缓存条目', h('span', { class: 'ytn-static', text: cache.size + ' 条' })),
      h('div', { class: 'ytn-actions' }, [
        h('button', { class: 'ytn-btn', type: 'button', text: '翻译全部可视评论', onclick: () => { close(); translateVisible(); } }),
        h('button', { class: 'ytn-btn', type: 'button', text: '清空缓存', onclick: () => { clearCache(); toast('已清空译文缓存'); close(); } }),
        h('button', { class: 'ytn-btn is-ghost', type: 'button', text: '恢复默认设置', onclick: () => { config = Object.assign({}, DEFAULTS); saveConfig(); close(); openPanel(); } }),
      ]),
    );

    body.append(...pages);
    panel.append(head, tabs, body, h('div', { class: 'ytn-foot' }, [
      h('span', { class: 'ytn-kbd', text: '快捷键（Alt+Shift+）：S 设置 / T 切换显示 / A 翻译可视 / P 自动翻译 / C 清缓存' }),
    ]));
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    previewBox(pvHost, globalMode);
    applyConfigDom();

    requestAnimationFrame(() => overlay.classList.add('is-on'));
    function close() {
      overlay.classList.remove('is-on');
      setTimeout(() => overlay.remove(), 200);
      document.removeEventListener('keydown', onKey, true);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab') return;
      const f = panel.querySelectorAll('button, select, input, [tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);
    panel.querySelector('.ytn-close').focus();
  }

  /* 13. 外观注入 */

  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function rgbTriple(color) {
    const probe = document.createElement('div');
    probe.style.cssText = 'display:none;color:' + color;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c || '');
    return m ? m[1] + ' ' + m[2] + ' ' + m[3] : '62 166 255';
  }

  function lumOf(color) {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(String(color || ''));
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
  }

  let lastProbe = 0;
  let lastAccent = '';
  let lastAccentRgb = '';

  function accentTriple(accent) {
    if (accent === lastAccent) return lastAccentRgb;
    lastAccent = accent;
    lastAccentRgb = rgbTriple(accent);
    return lastAccentRgb;
  }

  function probeTheme(force) {
    if (!force && now() - lastProbe < 1000) return;
    lastProbe = now();
    const pageCs = getComputedStyle(document.documentElement);
    let dark = null;
    // 直接采样评论正文/标题的前景色：文字亮 => 深色主题，比猜背景色可靠
    for (const sel of ['#content-text', 'yt-formatted-string', '#title', '#video-title', 'body']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const l = lumOf(getComputedStyle(el)[sel === 'body' ? 'backgroundColor' : 'color']);
      if (l == null) continue;
      dark = sel === 'body' ? l < 140 : l > 140;
      break;
    }
    if (dark == null) dark = true;
    const accent = (pageCs.getPropertyValue('--yt-spec-call-to-action') || '').trim()
      || (pageCs.getPropertyValue('--yt-spec-brand-link-text') || '').trim()
      || (dark ? '#3ea6ff' : '#065fd4');
    root.setAttribute('data-ytn-theme', dark ? 'dark' : 'light');
    root.style.setProperty('--ytn-accent', accent);
    root.style.setProperty('--ytn-accent-rgb', accentTriple(accent));
    root.style.setProperty('--ytn-fg', dark ? '#f1f1f1' : '#0f0f0f');
    root.style.setProperty('--ytn-muted', dark ? '#aaaaaa' : '#606060');
    root.style.setProperty('--ytn-line', dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.18)');
    root.style.setProperty('--ytn-bg', dark ? '#212121' : '#ffffff');
  }

  function applyConfigDom() {
    root.setAttribute('data-ytn-style', config.style);
    root.setAttribute('data-ytn-motion', reducedMotion ? 'off' : config.motion);
    if (config.takeoverNative) root.setAttribute('data-ytn-hide-native', '1');
    else root.removeAttribute('data-ytn-hide-native');
    try { probeTheme(); } catch (e) { /* ignore */ }
  }

  let cssMode = null;

  function injectStyle() {
    if (cssMode) return;
    const css = `
.ytn-box{font:var(--ytn-weight,400) var(--ytn-fs,13px)/var(--ytn-lh,1.5) var(--yt-roboto-font-family,Roboto,Arial,sans-serif);color:var(--ytn-color,var(--ytn-fg,#f1f1f1));margin:6px 0 2px;position:relative;max-width:100%}
.ytn-box[data-state="idle"]{display:none}
.ytn-box[data-state="loading"] .ytn-body{opacity:.72}
.ytn-box[data-state="error"]{--ytn-accent:#ff7b72;--ytn-accent-rgb:255 123 114}
.ytn-box[data-state="error"] .ytn-text{color:#ff8a80}
.ytn-box[data-view="original"] .ytn-body-wrap{grid-template-rows:0fr}
.ytn-body-wrap{display:grid;grid-template-rows:1fr;transition:grid-template-rows .2s ease}
.ytn-body{overflow:hidden;min-height:0}
.ytn-text{white-space:pre-wrap;word-break:break-word;color:inherit}
.ytn-text:empty::before{content:"正在翻译…";color:var(--ytn-muted,#aaa)}
.ytn-note{display:flex;align-items:center;gap:6px;margin-top:5px;font-size:11px;line-height:1.4;color:var(--ytn-muted,#aaa);min-height:18px}
.ytn-brand{opacity:.8}
.ytn-retry{display:none;border:0;background:none;color:var(--ytn-accent,#3ea6ff);cursor:pointer;font-size:11px;padding:0}
.ytn-box[data-state="error"] .ytn-retry{display:inline-block;padding:2px 8px;border-radius:999px;background:rgb(var(--ytn-accent-rgb,255 123 114)/.12)}
.ytn-box[data-state="loading"] .ytn-note{display:none}
.ytn-box[data-view="original"] .ytn-brand{display:none}
.ytn-box[data-state="loading"] .ytn-body-wrap,.ytn-box[data-state="error"] .ytn-body-wrap{grid-template-rows:1fr}
.ytn-tabs{display:flex;align-items:center;gap:1px;margin-left:8px;opacity:.62;transition:opacity .15s}
.ytn-box:hover .ytn-tabs,.ytn-tabs:focus-within{opacity:1}
.ytn-box:not([data-state="done"]) .ytn-tabs{display:none}
.ytn-tab{appearance:none;border:0;background:none;color:var(--ytn-muted,#aaa);font:500 11px/1 var(--yt-roboto-font-family,Roboto,Arial,sans-serif);padding:3px 7px;border-radius:999px;cursor:pointer;transition:color .15s,background-color .15s}
.ytn-tab:hover{color:var(--ytn-fg,#f1f1f1)}
.ytn-tab.is-on{color:var(--ytn-accent,#3ea6ff);background:rgb(var(--ytn-accent-rgb,62 166 255)/.13)}
.ytn-tab:focus-visible{outline:2px solid var(--ytn-accent,#3ea6ff);outline-offset:1px}
ytd-comment-view-model.ytn-hide-source #expander{display:none!important}
html[data-ytn-hide-native] ytd-comments .translate-button{display:none!important}
html[data-ytn-style="quote"] .ytn-box{padding-left:10px;border-left:3px solid var(--ytn-accent,#3ea6ff)}
html[data-ytn-style="quote"] .ytn-box::after{content:"";position:absolute;left:0;top:0;width:70px;height:100%;background:linear-gradient(90deg,rgb(var(--ytn-accent-rgb,62 166 255)/.10),transparent);pointer-events:none}
html[data-ytn-style="card"] .ytn-box{padding:8px 12px;border-radius:12px;background:rgb(var(--ytn-accent-rgb,62 166 255)/.08);border:1px solid rgb(var(--ytn-accent-rgb,62 166 255)/.2)}
html[data-ytn-style="minimal"] .ytn-box{padding-left:12px}
html[data-ytn-style="minimal"] .ytn-box::before{content:"";position:absolute;left:0;top:4px;bottom:4px;width:2px;border-radius:2px;background:var(--ytn-accent,#3ea6ff);opacity:.7}
html[data-ytn-motion="off"] .ytn-box *{animation:none!important;transition:none!important}
/* 设置面板 */
.ytn-overlay{position:fixed;inset:0;z-index:999999;display:grid;place-items:center;background:rgba(0,0,0,.55);opacity:0;transition:opacity .18s;padding:20px}
.ytn-overlay.is-on{opacity:1}
.ytn-panel{width:min(680px,100%);max-height:86vh;overflow:auto;background:#1c1c1e;color:#f1f1f1;border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.5);font:400 13px/1.5 Roboto,Arial,sans-serif}
.ytn-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 8px}
.ytn-title{font-size:16px;font-weight:600}
.ytn-close{border:0;background:none;color:#bbb;font-size:22px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:8px}
.ytn-close:hover{background:rgba(255,255,255,.08);color:#fff}
.ytn-ptabs{display:flex;gap:6px;padding:0 18px 10px}
.ytn-ptab{border:0;background:rgba(255,255,255,.06);color:#bbb;padding:6px 14px;border-radius:999px;cursor:pointer;font:500 12px/1 Roboto,Arial,sans-serif}
.ytn-ptab.is-on{background:#3ea6ff;color:#000}
.ytn-pbody{padding:0 18px 8px}
.ytn-page{display:none}
.ytn-page.is-on{display:block}
.ytn-sec{font-size:12px;color:#8ab4f8;margin:14px 0 6px;font-weight:600}
.ytn-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.ytn-row-label{display:flex;flex-direction:column;gap:2px}
.ytn-row-name{display:flex;align-items:baseline;gap:6px}
.ytn-hint{font-size:11px;color:#9aa0a6}
.ytn-static,.ytn-num{color:#cfcfcf;font-size:11px;font-variant-numeric:tabular-nums}
.ytn-divider{height:8px}
.ytn-seg{position:relative;display:inline-flex;background:rgba(255,255,255,.07);border-radius:999px;padding:2px}
.ytn-seg-btn{position:relative;z-index:1;border:0;background:none;color:#bbb;padding:5px 12px;border-radius:999px;cursor:pointer;font:500 12px/1 Roboto,Arial,sans-serif}
.ytn-seg-btn.is-on{color:#000}
.ytn-seg-thumb{position:absolute;top:2px;left:2px;height:calc(100% - 4px);width:calc((100% - 4px)/var(--ytn-sn,3));border-radius:999px;background:#3ea6ff;transform:translateX(calc(var(--ytn-si,0) * 100%));transition:transform .18s cubic-bezier(.2,.8,.2,1)}
.ytn-switch{position:relative;width:42px;height:22px;border-radius:999px;border:0;background:rgba(255,255,255,.18);cursor:pointer;padding:0;flex:none}
.ytn-switch.is-on{background:#3ea6ff}
.ytn-knob{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s}
.ytn-switch.is-on .ytn-knob{transform:translateX(20px)}
.ytn-select,.ytn-range{background:rgba(255,255,255,.08);color:#f1f1f1;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:5px 8px;font:400 12px/1 Roboto,Arial,sans-serif}
.ytn-range{width:150px;padding:0}
.ytn-actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 4px}
.ytn-btn{border:0;border-radius:8px;background:rgba(62,166,255,.16);color:#3ea6ff;padding:8px 12px;cursor:pointer;font:500 12px/1 Roboto,Arial,sans-serif}
.ytn-btn.is-ghost{background:rgba(255,255,255,.07);color:#bbb}
.ytn-foot{padding:10px 18px 16px;color:#888;font-size:11px}
.ytn-preview{border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px;margin:6px 0 10px;background:rgba(255,255,255,.02)}
.ytn-pv-src{font:400 13px/1.5 Roboto,Arial,sans-serif;color:#e8e8e8;margin-bottom:6px}
.ytn-preview.ytn-hide-source .ytn-pv-src{display:none}
.ytn-toast-host{position:fixed;right:18px;bottom:20px;z-index:999999;display:flex;flex-direction:column;gap:8px;align-items:flex-end}
.ytn-toast{background:#2b2b2e;color:#f1f1f1;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:9px 14px;font:400 12px/1.4 Roboto,Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4);opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s}
.ytn-toast.is-on{opacity:1;transform:none}
.ytn-toast.is-out{opacity:0;transform:translateY(6px)}
/* 浅色主题 */
html[data-ytn-theme="light"] .ytn-box[data-state="error"] .ytn-text{color:#b3261e}
html[data-ytn-theme="light"] .ytn-panel{background:#fff;color:#0f0f0f;border-color:rgba(0,0,0,.14);box-shadow:0 24px 60px rgba(0,0,0,.22)}
html[data-ytn-theme="light"] .ytn-close{color:#606060}
html[data-ytn-theme="light"] .ytn-close:hover{background:rgba(0,0,0,.06);color:#000}
html[data-ytn-theme="light"] .ytn-ptab{background:rgba(0,0,0,.06);color:#606060}
html[data-ytn-theme="light"] .ytn-ptab.is-on{background:#065fd4;color:#fff}
html[data-ytn-theme="light"] .ytn-sec{color:#065fd4}
html[data-ytn-theme="light"] .ytn-row{border-bottom-color:rgba(0,0,0,.07)}
html[data-ytn-theme="light"] .ytn-hint{color:#606060}
html[data-ytn-theme="light"] .ytn-static,html[data-ytn-theme="light"] .ytn-num{color:#3c4043}
html[data-ytn-theme="light"] .ytn-seg{background:rgba(0,0,0,.06)}
html[data-ytn-theme="light"] .ytn-seg-btn{color:#606060}
html[data-ytn-theme="light"] .ytn-seg-btn.is-on{color:#fff}
html[data-ytn-theme="light"] .ytn-seg-thumb{background:#065fd4}
html[data-ytn-theme="light"] .ytn-switch{background:rgba(0,0,0,.22)}
html[data-ytn-theme="light"] .ytn-switch.is-on{background:#065fd4}
html[data-ytn-theme="light"] .ytn-select,html[data-ytn-theme="light"] .ytn-range{background:rgba(0,0,0,.04);color:#0f0f0f;border-color:rgba(0,0,0,.16)}
html[data-ytn-theme="light"] .ytn-btn{background:rgba(6,95,212,.1);color:#065fd4}
html[data-ytn-theme="light"] .ytn-btn.is-ghost{background:rgba(0,0,0,.05);color:#606060}
html[data-ytn-theme="light"] .ytn-foot{color:#6b7280}
html[data-ytn-theme="light"] .ytn-preview{border-color:rgba(0,0,0,.1);background:rgba(0,0,0,.02)}
html[data-ytn-theme="light"] .ytn-pv-src{color:#0f0f0f}
html[data-ytn-theme="light"] .ytn-toast{background:#fff;color:#0f0f0f;border-color:rgba(0,0,0,.14);box-shadow:0 8px 24px rgba(0,0,0,.18)}
`;
    cssMode = injectCss(css);
  }

  // YouTube 的 CSP 可能拦内联 <style>，优先用构造样式表 / GM_addStyle。
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

  /* 14. 变更监听 */

  let scanTimer = 0;
  const dirty = new Set();
  let discover = false;
  let commentsEl = null;

  function inComments(node) {
    return !!(node && node.closest && node.closest('ytd-comments'));
  }

  function commentsRoot() {
    if (commentsEl && commentsEl.isConnected) return commentsEl;
    commentsEl = document.querySelector('ytd-comments#comments') || document.querySelector('ytd-comments');
    return commentsEl;
  }

  // 新增节点只做 O(1) 归属判断：落在已有评论里就检查文本是否被换掉，
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
            if (host.querySelector('.ytn-box')) { dirty.add(host); found++; }
          } else if (autoObserver) {
            discover = true;
            found++;
          }
          continue;
        }
        if (!inComments(n)) continue;
        if (autoObserver) { discover = true; found++; }
      }
    }
    if (!found) return;
    if (!scanTimer) scanTimer = setTimeout(flushMutations, 120);
  }

  function flushMutations() {
    scanTimer = 0;
    if (dirty.size) {
      const list = Array.from(dirty);
      dirty.clear();
      for (const vm of list) {
        if (!vm.isConnected) continue;
        const box = vm.querySelector('.ytn-box');
        if (!box) continue;
        const text = commentText(vm);
        const key = text.length + '|' + targetLang();
        if (vm.__ytnKey && vm.__ytnKey !== key) {
          removeBox(vm);
          delete vm.__ytnDone;
          delete vm.__ytnSame;
          delete vm.__ytnFailKey;
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
      if (config.translateReplies === false && isReplyVM(vm)) { vm.__ytnObsGen = autoGen; continue; }
      observeAuto(vm);
    }
  }

  /* 15. 初始化 */

  const primeSoon = debounce(() => primeAuto(), 1200);

  function resetForNavigation() {
    hoverVM = null;
    clearTimeout(hoverTimer);
    clearTimeout(scanTimer);
    scanTimer = 0;
    dirty.clear();
    discover = false;
    commentsEl = null;
    for (const vm of queue) vm.__ytnQueued = 0;
    queue.clear();
    for (const vm of document.querySelectorAll(VM_SEL)) {
      delete vm.__ytnDone;
      delete vm.__ytnSame;
      delete vm.__ytnKey;
      delete vm.__ytnObsGen;
      delete vm.__ytnVisible;
      delete vm.__ytnFailKey;
    }
    buildAutoWatch();
  }

  function init() {
    injectStyle();
    applyConfigDom();
    new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('mouseover', onMouseOver, { passive: true });
    document.addEventListener('mouseout', onMouseOut, { passive: true });
    document.addEventListener('scroll', () => { clearTimeout(hoverTimer); hoverVM = null; }, { passive: true });
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('click', onNativeClick, true);
    window.addEventListener('yt-navigate-finish', resetForNavigation);
    window.addEventListener('yt-page-data-updated', primeSoon);
    window.addEventListener('pagehide', flushCacheNow);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushCacheNow();
      else pump();
    });
    buildAutoWatch();
    if (typeof GM_addValueChangeListener === 'function') {
      try {
        GM_addValueChangeListener(CONFIG_KEY, (k, o, nv) => {
          config = sanitize(nv);
          applyConfigDom();
          buildAutoWatch();
        });
      } catch (e) { /* ignore */ }
    }
    if (typeof GM_registerMenuCommand === 'function') {
      try {
        GM_registerMenuCommand('YouTube 评论翻译设置', openPanel);
        GM_registerMenuCommand('切换显示方式（译文/双语/原文）', toggleMode);
        GM_registerMenuCommand('翻译全部可视评论', translateVisible);
        GM_registerMenuCommand('开关自动翻译', () => { config.autoTranslate = !config.autoTranslate; saveConfig(); buildAutoWatch(); toast(config.autoTranslate ? '已开启自动翻译' : '已关闭自动翻译'); });
        GM_registerMenuCommand('清空译文缓存', () => { clearCache(); toast('已清空译文缓存'); });
      } catch (e) { log('菜单注册失败', e); }
    }
    log('已就绪 · 目标语言', targetLang(), '· 客户端', pageClient().clientVersion);
  }

  const boot = () => {
    if (document.body) init();
    else setTimeout(boot, 200);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
