// 性能探针：在真实 watch 页滚动评论区，统计长任务、掉帧、观察器重建、
// 布局读取次数以及 CPU 采样热点。用法：
//   node probe/perf.mjs dQw4w9WgXcQ --tag=before --scenario=auto-bilingual
//   node probe/perf.mjs dQw4w9WgXcQ --tag=after  --scenario=all
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const VID = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dQw4w9WgXcQ';
const SCRIPT_PATH = path.resolve(ROOT, arg('script', 'yt-native-translator.user.js'));
const TAG = arg('tag', 'run');
const WHICH = arg('scenario', 'all');
const OUT = path.join(HERE, 'perf');
fs.mkdirSync(OUT, { recursive: true });

const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8');

// Patchright 的 init script 运行在隔离世界，page.evaluate 看不到它的 window 变量；
// 计数通过 DOM 事件 + data 属性这条共享通道导出。
const INSTRUMENT = String.raw`
(() => {
  const S = {
    ioCreated: 0, ioObserve: 0, ioObserveVM: 0, ioDisconnect: 0,
    moCreated: 0, moCallbacks: 0, moRecords: 0, moTime: 0, moMax: 0,
    rect: 0, rectVM: 0, gcs: 0, gcsBox: 0,
    qsa: 0, qsaVM: 0, qsaDocVM: 0, qsaElVM: 0, qsaVMTime: 0,
    fetch: 0, longTasks: [], rafGaps: [], rafMax: 0, moOwners: {},
  };
  const bumpOwner = (cb, muts, dt) => {
    const key = (cb && cb.name) || String(cb || '').replace(/\s+/g, ' ').slice(0, 60);
    let o = S.moOwners[key];
    if (!o) o = S.moOwners[key] = { cb: 0, records: 0, time: 0, max: 0 };
    o.cb++;
    o.records += muts.length;
    o.time += dt;
    if (dt > o.max) o.max = dt;
  };
  const OrigIO = window.IntersectionObserver;
  if (OrigIO) {
    window.IntersectionObserver = class extends OrigIO {
      constructor(cb, opts) { super(cb, opts); S.ioCreated++; }
      observe(t) { S.ioObserve++; if (t && t.localName === 'ytd-comment-view-model') S.ioObserveVM++; return super.observe(t); }
      disconnect() { S.ioDisconnect++; return super.disconnect(); }
    };
  }
  const OrigMO = window.MutationObserver;
  if (OrigMO) {
    window.MutationObserver = class extends OrigMO {
      constructor(cb) {
        super(function (muts, obs) {
          const t0 = performance.now();
          try { return cb(muts, obs); }
          finally {
            const dt = performance.now() - t0;
            S.moCallbacks++;
            S.moRecords += muts.length;
            S.moTime += dt;
            if (dt > S.moMax) S.moMax = dt;
            bumpOwner(cb, muts, dt);
          }
        });
        S.moCreated++;
      }
    };
  }
  const r = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    S.rect++;
    if (this.localName === 'ytd-comment-view-model') S.rectVM++;
    return r.call(this);
  };
  const g = window.getComputedStyle;
  window.getComputedStyle = function () {
    S.gcs++;
    const el = arguments[0];
    if (el && el.classList && el.classList.contains('ytn-box')) S.gcsBox++;
    return g.apply(window, arguments);
  };
  const dq = Document.prototype.querySelectorAll;
  Document.prototype.querySelectorAll = function (s) {
    S.qsa++;
    if (s === 'ytd-comment-view-model') {
      S.qsaVM++; S.qsaDocVM++;
      const t0 = performance.now();
      const res = dq.call(this, s);
      S.qsaVMTime += performance.now() - t0;
      return res;
    }
    return dq.call(this, s);
  };
  const eq = Element.prototype.querySelectorAll;
  Element.prototype.querySelectorAll = function (s) {
    S.qsa++;
    if (s === 'ytd-comment-view-model') {
      S.qsaVM++; S.qsaElVM++;
      const t0 = performance.now();
      const res = eq.call(this, s);
      S.qsaVMTime += performance.now() - t0;
      return res;
    }
    return eq.call(this, s);
  };
  const f = window.fetch;
  window.fetch = function () { S.fetch++; return f.apply(window, arguments); };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) S.longTasks.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });
  } catch (e) { /* ignore */ }
  let last = 0;
  const tick = (t) => {
    if (last) {
      const gap = t - last;
      S.rafGaps.push(Math.round(gap));
      if (gap > S.rafMax) S.rafMax = Math.round(gap);
    }
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  document.addEventListener('ytn-perf-dump', () => {
    const owners = Object.entries(S.moOwners)
      .map(([fn, v]) => ({ fn, cb: v.cb, records: v.records, time: Math.round(v.time), max: Math.round(v.max) }))
      .sort((a, b) => b.time - a.time)
      .slice(0, 10);
    const out = {
      ...S,
      moOwners: undefined,
      moTop: owners,
      longTasks: S.longTasks.slice(),
      rafGaps: S.rafGaps.slice(),
    };
    document.documentElement.setAttribute('data-ytn-perf', JSON.stringify(out));
  });
  document.addEventListener('ytn-perf-reset', () => {
    S.longTasks.length = 0;
    S.rafGaps.length = 0;
    S.rafMax = 0;
  });
})();
`;

const cookies = [];
for (const part of fs.readFileSync(path.join(HERE, 'cookies.txt'), 'utf8').trim().split(/;\s*/)) {
  const eq = part.indexOf('=');
  if (eq <= 0) continue;
  for (const domain of ['.youtube.com', '.google.com']) {
    cookies.push({ name: part.slice(0, eq), value: part.slice(eq + 1), domain, path: '/', secure: part.slice(0, eq).startsWith('__Secure-'), sameSite: 'None' });
  }
}

const SCENARIOS = {
  baseline: { withScript: false, seed: false, steps: 14, wait: 650 },
  'auto-bilingual': { withScript: true, cfg: { autoTranslate: true, hover: true, mode: 'bilingual', style: 'quote', takeoverNative: true }, steps: 14, wait: 650 },
  'auto-translation': { withScript: true, cfg: { autoTranslate: true, hover: false, mode: 'translation', style: 'quote', takeoverNative: true }, steps: 14, wait: 650 },
  'visible-all': { withScript: true, cfg: { autoTranslate: false, hover: false, mode: 'bilingual' }, steps: 12, wait: 650, hotkey: true },
  'auto-long': { withScript: true, cfg: { autoTranslate: true, hover: false, mode: 'bilingual', style: 'quote', takeoverNative: true }, steps: 40, wait: 450 },
  'baseline-long': { withScript: false, seed: false, steps: 40, wait: 450 },
};

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);
}

async function ping(page, ms = 6000) {
  const t = Date.now();
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); });
  try {
    await Promise.race([page.evaluate(() => 1), timeout]);
  } catch (e) {
    clearTimeout(timer);
    return -1;
  }
  clearTimeout(timer);
  return Date.now() - t;
}

const snap = (page) => page.evaluate(() => {
  document.dispatchEvent(new Event('ytn-perf-dump'));
  const raw = document.documentElement.getAttribute('data-ytn-perf');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
});

async function dismissConsent(page) {
  for (const b of await page.$$('tp-yt-paper-dialog button, yt-button-shape button')) {
    const t = ((await b.textContent().catch(() => '')) || '').trim();
    if (/^(接受全部|我同意|Accept all|Reject all)$/i.test(t)) {
      await b.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
  }
}

function summarize(c) {
  const lt = c.longTasks || [];
  const rg = c.rafGaps || [];
  const sorted = [...rg].sort((a, b) => a - b);
  const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);
  return {
    longTasks: lt.length,
    longTaskTotal: lt.reduce((a, b) => a + b, 0),
    longTaskMax: lt.length ? Math.max(...lt) : 0,
    longTaskOver200: lt.filter((d) => d >= 200).length,
    frames: rg.length,
    frameP95: pct(0.95),
    frameMax: sorted.length ? sorted[sorted.length - 1] : 0,
    framesOver100: rg.filter((g) => g >= 100).length,
    framesOver500: rg.filter((g) => g >= 500).length,
  };
}

const COUNTERS = ['ioCreated', 'ioObserve', 'ioObserveVM', 'ioDisconnect', 'moCreated', 'moCallbacks', 'moRecords', 'moTime', 'rect', 'rectVM', 'gcs', 'gcsBox', 'qsa', 'qsaVM', 'qsaDocVM', 'qsaElVM', 'qsaVMTime', 'fetch'];

function diff(before, after) {
  const out = {};
  for (const k of COUNTERS) out[k] = Math.round(((after[k] || 0) - (before[k] || 0)) * 100) / 100;
  return out;
}

function topFns(profile, n = 22) {
  const counts = new Map();
  for (const node of profile.nodes) {
    if (!node.hitCount) continue;
    const cf = node.callFrame;
    const name = cf.functionName || '(anonymous)';
    const key = cf.url ? `${name} @${String(cf.url).split('/').pop().slice(0, 40)}` : name;
    counts.set(key, (counts.get(key) || 0) + node.hitCount);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([fn, ms]) => ({ fn, ms }));
}

function printSummary(r) {
  const m = summarize(r.post);
  const d = r.delta;
  console.log(`\n=== ${r.tag} / ${r.scenario} ===`);
  console.log(`vms=${r.view.vms} boxes=${r.view.boxes} done=${r.view.done} err=${r.view.error} api=${r.api} wall=${r.wallMs}ms pings=[${r.pings.slice(0, 20).join(',')}]`);
  console.log(`longtask: n=${m.longTasks} total=${m.longTaskTotal}ms max=${m.longTaskMax}ms >200ms=${m.longTaskOver200}`);
  console.log(`frames: n=${m.frames} p95=${m.frameP95}ms max=${m.frameMax}ms >100ms=${m.framesOver100} >500ms=${m.framesOver500}`);
  console.log(`counters: IO new=${d.ioCreated} obsVM=${d.ioObserveVM} disc=${d.ioDisconnect} | MO cb=${d.moCallbacks} recs=${d.moRecords} time=${Math.round(d.moTime)}ms max=${Math.round(r.post.moMax)}ms | rectVM=${d.rectVM}/${d.rect} gcsBox=${d.gcsBox} | qsaDocVM=${d.qsaDocVM} qsaElVM=${d.qsaElVM} scan=${Math.round(d.qsaVMTime)}ms | fetch=${d.fetch}`);
  if (r.post.moTop) console.log('moTop: ' + r.post.moTop.slice(0, 6).map((o) => `${o.fn.slice(0, 36)} cb=${o.cb} ${o.time}ms max=${o.max}ms`).join(' | '));
  console.log('top: ' + r.top.slice(0, 14).map((t) => `${t.fn}=${t.ms}ms`).join(' | '));
  if (r.errors.length) console.log('errors: ' + r.errors.join(' || '));
}

async function runOne(name) {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error('unknown scenario ' + name);
  const browser = await chromium.launch({ headless: true, args: ['--lang=zh-CN', '--disable-features=Translate'] });
  const context = await browser.newContext({ viewport: { width: 1320, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  context.setDefaultTimeout(20000);
  await context.addCookies(cookies);
  await context.addInitScript({ content: INSTRUMENT + (sc.withScript ? '\n' + SCRIPT : '') });

  const errors = [];
  let api = 0;
  const newPage = async () => {
    const p = await context.newPage();
    p.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text().slice(0, 200)); });
    p.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 200)));
    p.on('request', (req) => { if (/perform_comment_action/.test(req.url())) api++; });
    return p;
  };

  if (sc.seed !== false) {
    const seed = await newPage();
    await seed.goto('https://www.youtube.com/?persist_configs=1', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await seed.evaluate((cfg) => {
      localStorage.setItem('ytn_config_v1', JSON.stringify(cfg));
      localStorage.removeItem('ytn_cache_v1');
      localStorage.removeItem('ytn_mode_v1');
    }, sc.cfg || {});
    await seed.close();
  }

  const page = await newPage();
  await page.goto(`https://www.youtube.com/watch?v=${VID}&hl=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2500);
  await dismissConsent(page);
  await page.evaluate(() => document.querySelector('ytd-comments#comments')?.scrollIntoView({ block: 'start' })).catch(() => {});
  await page.waitForTimeout(1500);

  const before = await snap(page).catch(() => ({}));
  await page.evaluate(() => document.dispatchEvent(new Event('ytn-perf-reset'))).catch(() => {});

  const cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  await cdp.send('Profiler.start');

  const t0 = Date.now();
  const pings = [];
  let unresponsive = 0;
  for (let i = 0; i < sc.steps; i++) {
    await withTimeout(page.mouse.wheel(0, 1100).catch(() => {}), 8000);
    await page.waitForTimeout(sc.wait).catch(() => {});
    const p = await ping(page);
    pings.push(p);
    if (p < 0) unresponsive++;
    if (unresponsive >= 3) break;
  }
  if (sc.hotkey) {
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', altKey: true, shiftKey: true, bubbles: true, cancelable: true }))).catch(() => {});
    await page.waitForTimeout(8000);
  }
  const wall = Date.now() - t0;

  let profile = null;
  try { profile = (await cdp.send('Profiler.stop')).profile; } catch (e) { errors.push('profiler stop: ' + e.message); }
  await cdp.detach().catch(() => {});

  const post = await snap(page).catch(() => before);
  const view = await page.evaluate(() => ({
    vms: document.querySelectorAll('ytd-comment-view-model').length,
    boxes: document.querySelectorAll('.ytn-box').length,
    done: document.querySelectorAll('.ytn-box[data-state="done"]').length,
    loading: document.querySelectorAll('.ytn-box[data-state="loading"]').length,
    error: document.querySelectorAll('.ytn-box[data-state="error"]').length,
    theme: document.documentElement.getAttribute('data-ytn-theme'),
  })).catch(() => ({ vms: -1, boxes: -1, done: -1, error: -1 }));
  await page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) }).catch(() => {});

  const result = {
    tag: TAG,
    scenario: name,
    vid: VID,
    script: SCRIPT_PATH,
    wallMs: wall,
    pings,
    unresponsive,
    api,
    view,
    errors: [...new Set(errors)].slice(0, 10),
    before,
    post,
    postSummary: summarize(post),
    delta: diff(before, post),
    top: profile ? topFns(profile) : [],
  };
  fs.writeFileSync(path.join(OUT, `${TAG}-${name}.json`), JSON.stringify(result, null, 1));
  printSummary(result);

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

const names = WHICH === 'all' ? Object.keys(SCENARIOS) : [WHICH];
for (const name of names) {
  try { await runOne(name); }
  catch (e) { console.error(`scenario ${name} failed: ` + (e && e.stack || e)); }
}
