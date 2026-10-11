// AIバイオリニスト：画面の動き
import { compose, planRoles, setPhrases, phraseInfo, setLineModel, lineModelInfo, leadStrong, patternPreview, ROLE_LABEL, TYPE_LABEL, STYLES, LOW, HIGH } from './engine/compose.js';
import { arrangeGuitar, trioChroma } from './engine/guitar.js';
import { loadGuitar, scheduleGuitar } from './engine/guitar-sampler.js';
import { PATTERNS, CATEGORIES, RHYTHMS, ARTS, DOUBLES, parseCustom, findPattern } from './engine/patterns.js';
import { chordName, keyNameJa, keyNameTrad, halfShift, pcName } from './engine/analyze.js';

import { loadViolin, makeViolinBus, scheduleViolin, renderMix, loudnessOf, makeImpulse } from './engine/sampler.js';
import { audioBufferToWav, notesToMidi, download } from './engine/files.js';
import { buildScore, scoreToMusicXML, quantizedNotes, beatToTime } from './engine/score.js';
import { renderScore, SCORE_CSS, fitClefs } from './engine/notation.js';

const $ = (id) => document.getElementById(id);
const MUTED = new URLSearchParams(location.search).has('mute');
// 公開版（GitHub Pages など・サーバーなし）か、この Mac のサーバーで動いているか
const FORCE_STATIC = document.querySelector('meta[name="vai-mode"]')?.content === 'static' || new URLSearchParams(location.search).has('static');
// 歌の判定の「歌っている」とみなす境目（AI ごとに出す数字の大きさが違う）
const VOCAL_TH = { mac: 0.15, yamnet: 0.008 }; // YAMNet は tests/calibrate-yamnet.cjs で Mac の判定と 93% 一致する値
const ROLE_COLOR = { pad: '#7aa7d9', arp: '#9fd3f7', rhythm: '#a6d96a', counter: '#6cc5b0', solo: '#f0a64a', riff: '#e2685b', fill: '#b993e6', answer: '#d98ad6', copy: '#f2829f', double: '#ff9f80', run: '#fff1a8', pattern: '#7fe0d0', ending: '#e8cf77' };
const TYPE_COLOR = { intro: '#3b3550', verse: '#2b3a4f', pre: '#2f4656', chorus: '#55402c', inter: '#4d2e31', outro: '#3b3550' };
const ROLE_SHORT = { rest: '休む', pad: 'そっと', arp: '分散和音', rhythm: '刻み', counter: '対旋律', answer: '掛け合い', double: 'メロディ', solo: 'ソロ', riff: 'リフ' };

const S = {
  ctx: null, master: null, songGain: null, bus: null,
  violin: null, violinP: null, violins: {}, mode: FORCE_STATIC ? 'static' : 'server', soundSet: 'free', listenSource: null,
  fileName: '', songBuf: null, pcm: null, listen: null,
  an: null, anView: null, anOpts: { beats: null, downbeatShift: 0, meter: null, key: null },
  settings: { style: 'emotional', presence: 0.6, soloMotion: 1, motion: 1, seed: 1, roles: {}, vocal: {}, patterns: {}, customPatterns: loadCustomPatterns() },
  result: null,
  player: { playing: false, startAt: 0, offset: 0, src: null, sched: null },
  mix: { mode: 'both', vViolin: 1, vSong: 1, vGuitar: 1, reverb: 0.28 },
  // 作り方：add＝原曲にバイオリンを足す／trio＝歌＋アコギ＋バイオリンで作り直す
  arrMode: 'add',
  trio: { vocalBuf: null, vocalSource: null, guitar: null, style: 'auto', roles: {}, levels: { violin: 1, guitar: 1 } },
  guitar: null, guitarP: null,
  violinLevel: 1,
  view: { pps: 0, W: 0, peaks: null, peaksW: 0 },
  busy: false,
};

// 好み（弾き方・存在感・音量）を覚えておく
try {
  const saved = JSON.parse(localStorage.getItem('violin-ai:prefs') || '{}');
  if (saved.style && STYLES[saved.style]) S.settings.style = saved.style;
  if (saved.presence) S.settings.presence = saved.presence;
  if (saved.soloMotion != null) S.settings.soloMotion = saved.soloMotion;
  if (saved.motion != null) S.settings.motion = saved.motion;
  if (saved.soundSet) S.soundSet = saved.soundSet;
  if (saved.mix) Object.assign(S.mix, saved.mix);
} catch {}
function savePrefs() {
  try { localStorage.setItem('violin-ai:prefs', JSON.stringify({ style: S.settings.style, presence: S.settings.presence, soloMotion: S.settings.soloMotion, motion: S.settings.motion, soundSet: S.soundSet, mix: { vViolin: S.mix.vViolin, vSong: S.mix.vSong, reverb: S.mix.reverb } })); } catch {}
}

const fmt = (t) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ───────────────────────── 起動時：準備の確認
async function pollStatus() {
  const ds = $('st-samples'), dl = $('st-listen');
  const staticStatus = async () => {
    S.mode = 'static';
    const ok = await fetch('samples-free/manifest.json').then((r) => r.ok).catch(() => false);
    ds.className = 'dot ' + (ok ? 'ok' : 'bad');
    $('st-samples-t').textContent = ok ? 'バイオリンの音 OK（フリー音源）' : 'バイオリンの音を読めません';
    dl.className = 'dot ok';
    $('st-listen-t').textContent = '歌の判定AI（ブラウザの中で動きます）';
    $('sound-row').hidden = true;
  };
  if (S.mode === 'static') return staticStatus();
  for (let i = 0; i < 120; i++) {
    try {
      const st = await fetch('/api/status').then((r) => r.json());
      ds.className = 'dot ' + (st.samples === 'ready' ? 'ok' : st.samples === 'error' ? 'warn' : 'warn');
      $('st-samples-t').textContent = st.samples === 'ready' ? `バイオリンの音 OK（フリー音源＋Logic ${st.count}）` : st.samples === 'error' ? 'バイオリンの音 OK（フリー音源）' : 'バイオリンの音を準備中…';
      dl.className = 'dot ' + (st.listen === 'ok' ? 'ok' : 'warn');
      $('st-listen-t').textContent = st.listen === 'ok' ? '歌の判定AI OK（Mac 内蔵）' : '歌の判定AI（ブラウザの中で動きます）';
      S.serverListen = st.listen === 'ok';
      S.logicReady = st.samples === 'ready';
      $('sound-row').hidden = !S.logicReady;
      if (st.samples !== 'preparing') return st;
    } catch {
      // サーバーがない＝公開版として動く
      return staticStatus();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
pollStatus();
// ギタリストのソロ（GuitarSet）から学んだフレーズ
const licksP = Promise.all([
  fetch('engine/phrases.json').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) setPhrases(j); }).catch(() => {}),
  // プロのアレンジ（POP909）とギターソロから学んだ「線のつながり方」
  fetch('engine/linemodel.json').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) setLineModel(j); }).catch(() => {}),
]);

// ───────────────────────── 音の準備
function ensureAudio() {
  if (S.ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  S.ctx = new AC({ latencyHint: 'playback' });
  const limiter = S.ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.1;
  // 自動テストのときは音を出さない（?mute=1）
  const out = S.ctx.createGain();
  out.gain.value = MUTED ? 0 : 1;
  limiter.connect(out).connect(S.ctx.destination);
  S.master = limiter;
  S.songGain = S.ctx.createGain();
  S.songGain.connect(limiter);
  S.bus = makeViolinBus(S.ctx, limiter, { reverb: S.mix.reverb, volume: S.mix.vViolin });
  S.guitarBus = makeGuitarBus(S.ctx, limiter);
  S.silentGain = S.ctx.createGain();
  S.silentGain.gain.value = 0;
  S.silentGain.connect(limiter);
  applyMix();
}
// アコギの音の通り道：低いこもりを少し切り、空気感を足して、軽い響き
function makeGuitarBus(ctx, dest) {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 70; hp.Q.value = 0.7;
  const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 230; body.Q.value = 1; body.gain.value = -2;
  const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 6000; air.gain.value = 2;
  const out = ctx.createGain();
  const wet = ctx.createGain(); wet.gain.value = 0.14;
  const conv = ctx.createConvolver(); conv.buffer = makeImpulse(ctx, 1.6, 11);
  input.connect(hp).connect(body).connect(air);
  air.connect(out);
  air.connect(conv).connect(wet).connect(out);
  out.connect(dest);
  return { input, out, setVolume(v, t = ctx.currentTime) { out.gain.setTargetAtTime(v, t, 0.03); } };
}
function ensureGuitar() {
  if (!S.guitarP) {
    S.guitarP = loadGuitar(S.ctx, 'samples-guitar/').then((g) => (S.guitar = g));
    S.guitarP.catch(() => { S.guitarP = null; });
  }
  return S.guitarP;
}
function ensureViolin() {
  // フリー音源（VSCO・どこでも使える）か、この Mac の Logic の音か
  const set = S.mode === 'server' && S.soundSet === 'logic' && S.logicReady ? 'logic' : 'free';
  if (!S.violins[set]) {
    const base = set === 'logic' ? '/samples/' : 'samples-free/';
    S.violins[set] = (async () => {
      for (let i = 0; i < 30; i++) {
        try { return await loadViolin(S.ctx, base); } catch (e) {
          if (i === 29) throw e;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
    S.violins[set].catch(() => { delete S.violins[set]; });
  }
  return S.violins[set].then((v) => { S.violin = v; return v; });
}

// ───────────────────────── 進み具合の表示
const STEP_ORDER = ['load', 'listen', 'beats', 'sections', 'compose'];
function showBusy(title) {
  $('drop').hidden = true;
  $('studio').hidden = true;
  $('busy').hidden = false;
  $('busy-title').textContent = title;
  for (const li of $('steps').children) li.className = '';
  $('busy-bar').style.width = '0%';
  $('busy-note').textContent = '';
}
function stepState(k, st) {
  const li = $('steps').querySelector(`[data-k="${k}"]`);
  if (li) li.className = st;
  const done = [...$('steps').children].filter((x) => x.className === 'done').length;
  $('busy-bar').style.width = `${Math.round((done / STEP_ORDER.length) * 100)}%`;
}

// ───────────────────────── 曲を読み込む
async function handleFile(file) {
  if (!file || S.busy) return;
  ensureAudio();
  ensureViolin();
  stop();
  S.busy = true;
  S.fileName = file.name.replace(/\.[^.]+$/, '');
  S.settings.roles = {};
  S.settings.vocal = {};
  S.settings.patterns = {};
  S.settings.seed = 1;
  S.trio.vocalBuf = null;
  S.trio.vocalSource = null;
  S.trio.roles = {};
  updateTrioUi();
  S.anOpts = { beats: null, downbeatShift: 0, meter: null, key: null };
  showBusy(`「${S.fileName}」を聞いています`);
  try {
    stepState('load', 'now');
    stepState('listen', 'now');
    const ext = (file.name.split('.').pop() || 'audio').toLowerCase();
    const T = (S.timings = {}), t0 = performance.now();
    // サーバー（この Mac）で WAV に直してもらい、同時に歌の場所も調べてもらう（Safari は m4a などを読むのが遅いため）
    const prep = S.mode === 'server' ? await fetch('/api/prepare', { method: 'POST', body: file, headers: { 'x-ext': ext } }).then((r) => r.json()).catch(() => null) : null;
    T.prepare = Math.round(performance.now() - t0);
    let buf = null;
    if (prep && prep.wav) {
      try { buf = await decode(await fetch(prep.wav).then((r) => r.arrayBuffer())); } catch { buf = null; }
    }
    if (!buf) buf = await decode(await file.arrayBuffer());
    S.songBuf = buf;
    T.decode = Math.round(performance.now() - t0);
    S.violinLevel = (loudnessOf(S.songBuf) / 0.1) * 0.63;
    S.pcm = await toPcm22k(S.songBuf);
    T.resample = Math.round(performance.now() - t0);
    stepState('load', 'done');
    S.listen = prep && prep.listen && prep.listen.ok ? prep.listen : null;
    S.listenSource = S.listen ? 'mac' : null;
    if (!S.listen) {
      // ブラウザの中の AI（YAMNet）で歌の場所を調べる
      try {
        S.listen = await yamnetListen(S.songBuf);
        S.listenSource = 'yamnet';
      } catch (e) {
        console.warn('yamnet', e);
        S.listen = null;
      }
      T.listen = Math.round(performance.now() - t0);
    }
    stepState('listen', 'done');
    if (!S.listen) $('busy-note').textContent = '歌の判定AIが使えなかったので、音の広がりから歌の場所を推定しています。';
    await runAnalysis();
    T.analyze = Math.round(performance.now() - t0);
    stepState('compose', 'now');
    await licksP;
    await ensureViolin();
    T.violin = Math.round(performance.now() - t0);
    recompose();
    T.compose = Math.round(performance.now() - t0);
    stepState('compose', 'done');
    showStudio();
  } catch (e) {
    console.error(e);
    toast('読み込めませんでした：' + (e.message || e), 6000);
    $('busy').hidden = true;
    $('drop').hidden = !!S.an ? true : false;
    if (S.an) showStudio();
  } finally {
    S.busy = false;
  }
}
function decode(ab) {
  return new Promise((resolve, reject) => {
    const p = S.ctx.decodeAudioData(ab, resolve, (e) => reject(new Error('この形式の音声は開けませんでした')));
    if (p && p.then) p.then(resolve, () => reject(new Error('この形式の音声は開けませんでした')));
  });
}
async function toPcm22k(buf) {
  const sr = 22050;
  const len = Math.ceil(buf.duration * sr);
  const oc = new OfflineAudioContext(2, len, sr);
  const s = oc.createBufferSource();
  s.buffer = buf;
  s.connect(oc.destination);
  s.start(0);
  const out = await oc.startRendering();
  return { sr, L: out.getChannelData(0).slice(), R: out.getChannelData(1).slice() };
}
// ブラウザの中で、歌の場所を AI（YAMNet）が調べる
async function yamnetListen(buf) {
  const sr = 16000;
  const oc = new OfflineAudioContext(1, Math.ceil(buf.duration * sr), sr);
  const src = oc.createBufferSource();
  src.buffer = buf;
  src.connect(oc.destination);
  src.start(0);
  const out = await oc.startRendering();
  const pcm = out.getChannelData(0).slice();
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./engine/yamnet-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') $('busy-note').textContent = (m.note || '歌っている場所を AI が聞いています') + (m.p > 0 ? `（${Math.round(m.p * 100)}%）` : '');
      else if (m.type === 'done') { w.terminate(); resolve({ ok: true, rows: m.rows, source: 'yamnet' }); }
      else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'AI を動かせませんでした')); };
    w.postMessage({ pcm }, [pcm.buffer]);
  });
}

function runAnalysis() {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./engine/worker.js', import.meta.url), { type: 'module' });
    const L = S.pcm.L.slice(), R = S.pcm.R.slice();
    stepState('beats', 'now');
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        if (m.stage === 'sections' || m.stage === 'riffs') { stepState('beats', 'done'); stepState('sections', 'now'); }
        const note = { spectrum: '音の成分を調べています', pitch: '音の高さを調べています', beats: '拍を数えています', chords: 'コードを聞き取っています', vocal: '歌の場所をまとめています', sections: '曲の区切りを探しています', riffs: 'リフを探しています' }[m.stage];
        if (note) $('busy-note').textContent = note + (m.p > 0 && m.p < 1 ? `（${Math.round(m.p * 100)}%）` : '');
      } else if (m.type === 'done') {
        S.an = m.res;
        stepState('beats', 'done');
        stepState('sections', 'done');
        w.terminate();
        resolve();
      } else if (m.type === 'error') {
        w.terminate();
        reject(new Error(m.message));
      }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || '解析に失敗しました')); };
    w.postMessage({ L, R, sr: S.pcm.sr, listen: S.listen, opts: { ...S.anOpts, vocalThreshold: VOCAL_TH[S.listenSource] ?? 0.15 } }, [L.buffer, R.buffer]);
  });
}

// ───────────────────────── 作曲
function withVocalOverrides(an, vocal) {
  const secs = an.sections.map((s, i) => {
    if (vocal[i] == null || vocal[i] === s.vocal) return s;
    const v = vocal[i];
    const type = v ? 'verse' : i === 0 ? 'intro' : i === an.sections.length - 1 ? 'outro' : 'inter';
    return { ...s, vocal: v, type, n: 0 };
  });
  // 番号を振り直す
  const cnt = {};
  for (const s of secs) { cnt[s.type] = (cnt[s.type] || 0) + 1; s.n = cnt[s.type]; }
  return { ...an, sections: secs.map((s) => ({ ...s })) };
}
function recompose() {
  S.anView = withVocalOverrides(S.an, S.settings.vocal);
  if (S.arrMode === 'trio') {
    const plan = planRoles(S.anView, S.settings);
    plan.forEach((p) => { const r = S.trio.roles[p.si]; if (r && r !== 'auto') p.guitar = r; });
    S.trio.guitar = arrangeGuitar(S.anView, plan, { seed: S.settings.seed, guitarStyle: S.trio.style });
    // バイオリンは、原曲の代わりに「ギターの押さえた音＋歌」が鳴っているものとして作る。伴奏が薄いので少し前に出す
    S.result = compose({ ...S.anView, chroma: trioChroma(S.anView, S.trio.guitar) }, { ...S.settings, presence: Math.min(0.95, S.settings.presence + 0.1) });
    renderTrioChords();
  } else {
    S.trio.guitar = null;
    S.result = compose(S.anView, { ...S.settings });
  }
  drawTimeline();
  renderSections();
  renderFound();
  renderFacts();
  $('idea').textContent = `アイデア #${S.settings.seed}・${S.result.notes.length} 音`;
  if (S.player.playing) rescheduleViolin();
}

// ───────────────────────── 画面：曲の情報
function showStudio() {
  $('busy').hidden = true;
  $('drop').hidden = true;
  $('studio').hidden = false;
  $('songname').textContent = S.fileName;
  syncControls();
  requestAnimationFrame(() => { fitZoom(); drawTimeline(); updateTime(); });
  renderPatternBook();
}
function renderFacts() {
  const an = S.an;
  const keys = [];
  an.keyPerBar.forEach((k, i) => { if (!i || k.tonic !== an.keyPerBar[i - 1].tonic || k.mode !== an.keyPerBar[i - 1].mode) keys.push(`${keyNameJa(k)}（${keyNameTrad(k)}）`); });
  $('facts').innerHTML = `${fmt(an.duration)}・<b>${an.bpm.toFixed(an.steadyTempo ? 0 : 1)}</b> BPM${an.steadyTempo ? '' : an.tempoFollow ? '（揺れあり・小節ごとに合わせる）' : '（揺れあり）'}・<b>${keys.slice(0, 3).join(' → ')}</b>${keys.length > 3 ? ' …' : ''}・${an.meter}拍子`;
}
function syncControls() {
  for (const b of $('style').children) b.classList.toggle('on', b.dataset.style === S.settings.style);
  for (const b of $('presence').children) b.classList.toggle('on', Math.abs(+b.dataset.p - S.settings.presence) < 0.01);
  for (const b of $('mode').children) b.classList.toggle('on', b.dataset.mode === S.mix.mode);
  for (const b of $('solo-motion').children) b.classList.toggle('on', +b.dataset.v === S.settings.soloMotion);
  for (const b of $('motion').children) b.classList.toggle('on', +b.dataset.v === S.settings.motion);
  for (const b of $('sound').children) b.classList.toggle('on', b.dataset.v === S.soundSet);
  if (S.an) {
    const sel = $('key-fix');
    if (!sel.options.length) {
      const opts = [['auto', 'AI におまかせ']];
      for (const mode of ['maj', 'min']) for (let t = 0; t < 12; t++) { const k = { tonic: t, mode }; opts.push([`${t}:${mode}`, `${keyNameJa(k)}（${keyNameTrad(k)}）`]); }
      for (const [v, txt] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = txt; sel.append(o); }
    }
    sel.value = S.anOpts.key ? `${S.anOpts.key.tonic}:${S.anOpts.key.mode}` : 'auto';
  }
  $('vol-violin').value = S.mix.vViolin;
  $('vol-song').value = S.mix.vSong;
  $('reverb').value = S.mix.reverb;
}

// ───────────────────────── 時間の流れの図
const ROWS = { ruler: [0, 18], sec: [18, 52], chord: [52, 74], wave: [74, 132], vio: [132, 282] };
const H = 282;
function fitZoom() {
  const el = $('timeline');
  const w = el.clientWidth || 800;
  S.view.pps = Math.max(w / Math.max(1, S.an.duration), 4);
  if (S.an.duration * S.view.pps < w) S.view.pps = w / S.an.duration;
}
function buildPeaks(W) {
  if (S.view.peaks && S.view.peaksW === W) return S.view.peaks;
  const b = S.songBuf;
  const chs = [];
  for (let c = 0; c < b.numberOfChannels; c++) chs.push(b.getChannelData(c));
  const n = b.length, per = n / W;
  const peaks = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const a = Math.floor(x * per), e = Math.min(n, Math.floor((x + 1) * per));
    let m = 0;
    const step = Math.max(1, Math.floor((e - a) / 400));
    for (let i = a; i < e; i += step) for (const d of chs) { const v = Math.abs(d[i]); if (v > m) m = v; }
    peaks[x] = m;
  }
  S.view.peaks = peaks;
  S.view.peaksW = W;
  return peaks;
}
function drawTimeline() {
  if (!S.an || !S.result) return;
  const an = S.anView || S.an;
  const pps = S.view.pps || 10;
  const W = Math.max($('timeline').clientWidth, Math.ceil(an.duration * pps));
  S.view.W = W;
  const cv = $('tl-canvas');
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.ceil(W * dpr);
  cv.height = Math.ceil(H * dpr);
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  $('tl-inner').style.width = W + 'px';
  $('tl-inner').style.height = H + 'px';
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.font = '11px -apple-system, "Hiragino Sans", sans-serif';
  const X = (t) => t * pps;
  // 目盛り
  g.fillStyle = '#1f1a1f';
  g.fillRect(0, 0, W, 18);
  const stepSec = pps > 30 ? 5 : pps > 12 ? 10 : 30;
  g.fillStyle = '#7d736c';
  for (let t = 0; t <= an.duration; t += stepSec) {
    g.fillRect(X(t), 12, 1, 6);
    g.fillText(fmt(t), X(t) + 3, 12);
  }
  // 小節の線
  g.fillStyle = 'rgba(255,255,255,0.05)';
  const barPx = (an.bars[2]?.t0 - an.bars[1]?.t0) * pps;
  for (const bar of an.bars) if (barPx > 7) g.fillRect(Math.round(X(bar.t0)), ROWS.chord[0], 1, H - ROWS.chord[0]);
  // 区切り
  const plan = S.result.plan;
  an.sections.forEach((s, i) => {
    const x0 = X(an.bars[s.bar0].t0), x1 = X(an.bars[s.bar1 - 1].t1);
    const p = plan[i];
    g.fillStyle = TYPE_COLOR[s.type] || '#333';
    roundRect(g, x0 + 1, ROWS.sec[0] + 3, Math.max(2, x1 - x0 - 2), ROWS.sec[1] - ROWS.sec[0] - 6, 6);
    g.fill();
    if (p && p.role !== 'rest') {
      g.fillStyle = ROLE_COLOR[p.role] || '#999';
      g.fillRect(x0 + 1, ROWS.sec[1] - 6, Math.max(2, x1 - x0 - 2), 3);
    }
    if (x1 - x0 > 34) {
      g.fillStyle = '#efe7dd';
      g.font = '600 11.5px -apple-system, "Hiragino Sans", sans-serif';
      g.fillText(`${TYPE_LABEL[s.type]}${s.n}`, x0 + 7, ROWS.sec[0] + 17, x1 - x0 - 10);
      if (p && x1 - x0 > 60) {
        g.font = '10.5px -apple-system, "Hiragino Sans", sans-serif';
        g.fillStyle = '#b8ada4';
        g.fillText(ROLE_SHORT[p.role] || '', x0 + 7, ROWS.sec[0] + 29, x1 - x0 - 10);
      }
    }
  });
  g.font = '11px -apple-system, "Hiragino Sans", sans-serif';
  // コード
  let lastName = '', freeX = -1e9;
  for (let i = 0; i < an.beats.length; i++) {
    const bar = an.barOfBeat[i];
    const name = chordName(an.chords[i], an.keyPerBar[bar]);
    if (name === lastName) continue;
    lastName = name;
    const x = X(an.beats[i]);
    const w = g.measureText(name).width;
    if (x < freeX) continue;
    g.fillStyle = name === 'N.C.' ? '#5d554f' : '#cfc4b8';
    g.fillText(name, x + 2, ROWS.chord[0] + 15);
    freeX = x + w + 8;
  }
  // 原曲の波形と歌
  const peaks = buildPeaks(W);
  const wy0 = ROWS.wave[0], wh = ROWS.wave[1] - ROWS.wave[0];
  g.fillStyle = 'rgba(110,160,235,0.2)';
  for (let i = 0; i < an.beats.length; i++) {
    if ((an.vocalProb[i] || 0) < 0.15) continue;
    const a = X(an.beats[i]), b = X(i + 1 < an.beats.length ? an.beats[i + 1] : an.duration);
    g.fillRect(a, wy0 + 2, b - a + 0.5, wh - 4);
  }
  g.fillStyle = '#6d6259';
  const mid = wy0 + wh / 2;
  for (let x = 0; x < W; x++) {
    const h = Math.min(1, peaks[x] * 1.15) * (wh / 2 - 3);
    g.fillRect(x, mid - h, 1, h * 2 || 1);
  }
  // バイオリン
  const vy0 = ROWS.vio[0] + 6, vh = ROWS.vio[1] - ROWS.vio[0] - 12;
  const Y = (m) => vy0 + ((HIGH - m) / (HIGH - LOW)) * vh;
  g.fillStyle = 'rgba(255,255,255,0.06)';
  for (const c of [60, 72, 84]) g.fillRect(0, Math.round(Y(c)), W, 1);
  g.fillStyle = '#5d554f';
  for (const [c, lab] of [[60, 'C4'], [72, 'C5'], [84, 'C6']]) for (let x = 4; x < W; x += 600) g.fillText(lab, x, Y(c) - 2);
  const nh = Math.max(3, vh / (HIGH - LOW) + 1);
  for (const n of S.result.notes) {
    g.globalAlpha = 0.45 + 0.55 * n.vel;
    g.fillStyle = ROLE_COLOR[n.role] || '#ccc';
    roundRect(g, X(n.t), Y(n.midi) - nh / 2, Math.max(2, X(n.d) - 1), nh, 2);
    if (n.dbl != null) { g.fill(); roundRect(g, X(n.t), Y(n.dbl) - nh / 2, Math.max(2, X(n.d) - 1), nh, 2); } // 重音の下の音
    g.fill();
  }
  g.globalAlpha = 1;
  // 凡例
  if (!$('legend').childElementCount) {
    const items = [['pad', 'そっと伴奏（歌の裏）'], ['arp', '分散和音'], ['rhythm', '刻み'], ['counter', '対旋律'], ['solo', 'ソロ'], ['riff', 'リフのまね'], ['double', '楽器のメロディを弾く'], ['copy', '楽器のフレーズをまねる'], ['answer', '掛け合い'], ['fill', '合いの手'], ['run', 'サビへの駆け上がり'], ['pattern', '選んだ型（パターン）'], ['ending', '最後の音']];
    $('legend').replaceChildren(...items.map(([k, t]) => {
      const s = document.createElement('span');
      const i = document.createElement('i');
      i.style.background = ROLE_COLOR[k];
      s.append(i, t);
      return s;
    }));
    const z = document.createElement('label');
    z.className = 'slider';
    z.style.marginLeft = 'auto';
    z.innerHTML = '拡大 <input type="range" id="zoom" min="1" max="10" step="0.1" value="1">';
    $('legend').append(z);
    $('zoom').addEventListener('input', (e) => {
      const base = $('timeline').clientWidth / S.an.duration;
      const t = currentTime();
      S.view.pps = base * +e.target.value;
      drawTimeline();
      updateTime();
      $('timeline').scrollLeft = Math.max(0, t * S.view.pps - $('timeline').clientWidth / 2);
    });
  }
}
function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ───────────────────────── 区間ごとのカード
function renderSections() {
  const an = S.anView;
  const plan = S.result.plan;
  const cards = an.sections.map((s, i) => {
    const p = plan[i];
    const t0 = an.bars[s.bar0].t0, t1 = an.bars[s.bar1 - 1].t1;
    const el = document.createElement('div');
    el.className = 'sec';
    el.dataset.i = i;
    el.style.borderLeftColor = p.patternId ? ROLE_COLOR.pattern : p.role === 'rest' ? '#555' : ROLE_COLOR[p.role];
    const row = document.createElement('div');
    row.className = 'row';
    const nm = document.createElement('span');
    nm.className = 'name';
    nm.textContent = `${TYPE_LABEL[s.type]}${s.n}`;
    const tm = document.createElement('span');
    tm.className = 'tm';
    tm.textContent = `${fmt(t0)}〜${fmt(t1)}`;
    tm.title = 'ここから再生';
    tm.addEventListener('click', () => { seek(t0); if (!S.player.playing) play(); });
    row.append(nm, tm);
    const row2 = document.createElement('div');
    row2.className = 'row2';
    const chip = document.createElement('button');
    chip.className = 'chip' + (s.vocal ? ' vocal' : '') + (S.settings.vocal[i] != null ? ' fixed' : '');
    chip.textContent = s.vocal ? '歌あり' : '歌なし';
    chip.title = 'AI の判定がちがうときは押して切りかえ';
    chip.addEventListener('click', () => {
      S.settings.vocal[i] = !s.vocal;
      if (S.settings.vocal[i] === S.an.sections[i].vocal) delete S.settings.vocal[i];
      delete S.settings.roles[i];
      recompose();
    });
    const info = document.createElement('span');
    info.className = 'auto';
    info.textContent = `${s.bar1 - s.bar0}小節・${p.noteCount || 0}音`;
    row2.append(chip, info);
    const sel = document.createElement('select');
    const autoRole = S.settings.roles[i] ? null : p.role;
    const opts = [['auto', `おまかせ（${ROLE_LABEL[autoRole || 'auto'] || ''}）`], ['rest', '休む'], ['pad', 'そっと伴奏（長い音）'], ['arp', '分散和音（アルペジオ）'], ['rhythm', '刻み（リズム）'], ['counter', '対旋律（動きのある伴奏）'], ['answer', '掛け合い（歌の息つぎに答える）'], ['double', s.vocal ? 'メロディを弾く（歌と同じ旋律）' : 'メロディを弾く（ギター・ピアノなどの旋律）'], ['solo', 'ソロ'], ['riff', p.hasRiff ? 'リフをまねる' : 'リフをまねる（見つからず）']];
    for (const [v, t] of opts) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === 'auto' && !autoRole ? 'おまかせ' : t;
      if (v === 'riff' && !p.hasRiff) o.disabled = true;
      sel.append(o);
    }
    sel.value = S.settings.roles[i] || 'auto';
    sel.addEventListener('change', () => {
      if (sel.value === 'auto') delete S.settings.roles[i];
      else S.settings.roles[i] = sel.value;
      recompose();
    });
    // 型（パターン）：選ぶと、この区間はその型で弾く（上の弾き方より優先）
    const psel = document.createElement('select');
    psel.className = 'pat';
    psel.title = '型（パターン）を選ぶと、この区間はその型で弾きます。音はその場のコードと調に合わせます';
    const o0 = document.createElement('option');
    o0.value = '';
    o0.textContent = '型：使わない（上の弾き方で）';
    psel.append(o0);
    for (const [cat, label] of CATEGORIES) {
      const list = cat === 'custom' ? S.settings.customPatterns : PATTERNS.filter((q) => q.cat === cat);
      if (!list.length) continue;
      const og = document.createElement('optgroup');
      og.label = label;
      for (const q of list) { const o = document.createElement('option'); o.value = q.id; o.textContent = `型：${q.name}`; og.append(o); }
      psel.append(og);
    }
    psel.value = S.settings.patterns[i] && findPattern(S.settings.patterns[i], S.settings.customPatterns) ? S.settings.patterns[i] : '';
    psel.addEventListener('change', () => {
      if (psel.value) S.settings.patterns[i] = psel.value;
      else delete S.settings.patterns[i];
      recompose();
    });
    if (p.patternId) { sel.disabled = true; sel.title = '型を選んでいる間は、型が優先です'; }
    el.append(row, row2, sel, psel);
    if (S.arrMode === 'trio' && S.trio.guitar) {
      const gp = S.trio.guitar.plan.find((q) => q.si === i);
      const gsel = document.createElement('select');
      gsel.className = 'gtr';
      for (const [v, t] of [['auto', `ギター：おまかせ（${gp && gp.kind !== 'rest' && gp.name ? gp.name : '休み'}）`], ['arp', 'ギター：アルペジオ'], ['strum', 'ギター：ストローク'], ['rest', 'ギター：休む']]) {
        const o = document.createElement('option'); o.value = v; o.textContent = t; gsel.append(o);
      }
      gsel.value = S.trio.roles[i] || 'auto';
      if (S.trio.roles[i] && gp) gsel.options[0].textContent = 'ギター：おまかせ';
      gsel.addEventListener('change', () => { if (gsel.value === 'auto') delete S.trio.roles[i]; else S.trio.roles[i] = gsel.value; recompose(); });
      el.append(gsel);
    }
    return el;
  });
  $('sections').replaceChildren(...cards);
}

// ───────────────────────── 再アレンジ（歌＋アコギ＋バイオリン）
function setArrMode(mode) {
  S.arrMode = mode === 'trio' ? 'trio' : 'add';
  for (const b of $('arr-mode').children) b.classList.toggle('on', b.dataset.v === S.arrMode);
  updateTrioUi();
  if (!S.an) return;
  const go = () => {
    const was = S.player.playing;
    if (was) stop();
    updateTrioLevels();
    recompose();
    applyMix();
    if (was) play();
  };
  if (S.arrMode === 'trio') {
    ensureAudio();
    toast('アコギの伴奏を作っています…');
    ensureGuitar().then(go, () => toast('ギターの音を読み込めませんでした'));
  } else go();
}
// 歌を取り出す AI（Spleeter）が置いてあるか（公開版では入れていないことがある）
async function sepAvailable() {
  if (S.sepOk != null) return S.sepOk;
  try { const r = await fetch('models-sep/README.md', { cache: 'no-store' }); S.sepOk = r.ok; } catch { S.sepOk = false; }
  updateTrioUi();
  return S.sepOk;
}
function updateTrioUi() {
  const trio = S.arrMode === 'trio';
  if (trio && S.sepOk == null) sepAvailable();
  const sepBtn = $('trio-sep');
  if (S.sepOk === false) { sepBtn.disabled = true; sepBtn.textContent = 'AI で歌を取り出す（この版には入っていません）'; sepBtn.title = '歌だけのファイルを入れてください（Logic の「ステム分割」などで書き出せます）'; }
  else if (!S.trio.sepBusy) { sepBtn.disabled = false; sepBtn.textContent = S.trio.vocalSource === 'ai' ? 'AI でもう一度取り出す' : 'AI で原曲から歌を取り出す'; }
  $('trio-panel').hidden = !trio;
  $('vol-guitar-wrap').hidden = !trio;
  $('vol-song-label').textContent = trio ? '歌' : '原曲';
  document.querySelectorAll('.trio-only').forEach((b) => (b.hidden = !trio));
  const songBtn = [...$('mode').children].find((b) => b.dataset.mode === 'song');
  if (songBtn) songBtn.textContent = trio ? '歌とギターだけ' : '原曲だけ';
  const st = $('trio-vocal-state');
  if (S.trio.vocalBuf) {
    st.textContent = S.trio.vocalSource === 'file' ? `歌だけのファイル「${S.trio.vocalName}」を使っています${S.trio.offset ? `（曲の頭に合わせて ${S.trio.offset > 0 ? '+' : ''}${S.trio.offset.toFixed(2)} 秒ずらしました）` : ''}` : `AI で原曲から取り出した歌を使っています（${Math.round(S.trio.sepMs / 1000)} 秒かかりました）`;
    st.classList.add('ok');
  } else {
    st.textContent = 'まだ取り出していません（今はギターとバイオリンだけが鳴ります）';
    st.classList.remove('ok');
  }
  for (const b of $('guitar-style').children) b.classList.toggle('on', b.dataset.v === S.trio.style);
}
function renderTrioChords() {
  const box = $('trio-chords');
  if (!box || !S.trio.guitar) return;
  const seen = new Map();
  for (const c of S.trio.guitar.chords) { const name = chordName({ root: c.root, q: c.q }, S.an.key); if (!seen.has(name)) seen.set(name, c.frets); }
  box.replaceChildren(...[...seen].slice(0, 24).map(([name, fr]) => { const sp = document.createElement('span'); const b = document.createElement('b'); b.textContent = name; sp.append(b, fr || ''); sp.title = '押さえ方（6 弦→1 弦。x＝弾かない、数字＝フレット）'; return sp; }));
}
function trioChordChartHtml() {
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const seen = new Map();
  for (const c of S.trio.guitar.chords) { const name = chordName({ root: c.root, q: c.q }, S.an.key); if (!seen.has(name)) seen.set(name, c.frets); }
  const secs = S.trio.guitar.plan.map((p) => `${TYPE_LABEL[S.anView.sections[p.si].type]}${S.anView.sections[p.si].n}：${p.kind === 'rest' ? '休み' : p.name}`).join('　');
  return `<div class="score-head" style="margin-bottom:10px"><p><b>アコギ</b>（6 弦→1 弦。x＝弾かない、数字＝フレット）　${[...seen].map(([n, f]) => `<b>${esc(n)}</b> ${esc(f || '')}`).join('　')}</p><p style="font-size:12px;color:#555">${esc(secs)}</p></div>`;
}
// 書き出し（再アレンジ）：歌・ギター・バイオリンから選んで 1 本の WAV に
async function renderTrio(parts) {
  if (parts.guitar) await ensureGuitar();
  const sr = 44100, dur = S.an.duration + 2.5;
  const oc = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  const limiter = oc.createDynamicsCompressor();
  limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.1;
  limiter.connect(oc.destination);
  if (parts.vocal && S.trio.vocalBuf) {
    const src = oc.createBufferSource();
    src.buffer = S.trio.vocalBuf;
    const g = oc.createGain();
    g.gain.value = S.mix.vSong;
    src.connect(g).connect(limiter);
    src.start(0);
  }
  if (parts.guitar && S.trio.guitar) {
    const gb = makeGuitarBus(oc, limiter);
    gb.out.gain.value = S.mix.vGuitar;
    scheduleGuitar(oc, S.guitar, S.trio.guitar.notes, gb.input, { songStart: 0, from: 0, tuning: S.an.tuning, level: S.trio.levels.guitar });
  }
  if (parts.violin) {
    const bus = makeViolinBus(oc, limiter, { reverb: S.mix.reverb, volume: S.mix.vViolin });
    scheduleViolin(oc, S.violin, S.result.notes, bus.input, { songStart: 0, from: 0, tuning: S.an.tuning, level: violinLevelNow() });
  }
  return oc.startRendering();
}
// 歌だけのファイルを、原曲の頭に合わせる（音の立ち上がりの並びが一番よく重なるずれ。±3 秒まで）
function onsetEnv(buf) {
  const hop = Math.round(buf.sampleRate * 0.01), n = Math.floor(buf.length / hop);
  const chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let q = 0; for (let j = i * hop; j < (i + 1) * hop; j += 4) for (const d of chs) q += d[j] * d[j]; e[i] = Math.log1p(200 * Math.sqrt(q / (hop / 4))); }
  for (let i = n - 1; i > 0; i--) e[i] = Math.max(0, e[i] - e[i - 1]);
  e[0] = 0;
  return e;
}
function alignVocal(mix, voc) {
  const a = onsetEnv(mix), b = onsetEnv(voc);
  let best = 0, bv = -Infinity;
  for (let L = -300; L <= 300; L++) {
    let q = 0;
    for (let i = Math.max(0, L); i < Math.min(a.length, b.length + L); i += 1) q += a[i] * b[i - L];
    if (q > bv) { bv = q; best = L; }
  }
  const shift = best * 0.01; // 歌を shift 秒うしろへ（負なら前へ）
  const sr = voc.sampleRate, len = Math.ceil(mix.duration * sr);
  const out = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: sr });
  for (let c = 0; c < 2; c++) {
    const src = voc.getChannelData(Math.min(c, voc.numberOfChannels - 1)), dst = out.getChannelData(c);
    const off = Math.round(shift * sr);
    for (let i = 0; i < len; i++) { const j = i - off; if (j >= 0 && j < src.length) dst[i] = src[j]; }
  }
  return { buf: out, shift };
}
async function loadVocalFile(file) {
  if (!file || !S.songBuf) return;
  ensureAudio();
  try {
    const voc = await decode(await file.arrayBuffer());
    const { buf, shift } = alignVocal(S.songBuf, voc);
    S.trio.vocalBuf = buf;
    S.trio.vocalSource = 'file';
    S.trio.vocalName = file.name;
    S.trio.offset = Math.abs(shift) >= 0.02 ? shift : 0;
    updateTrioLevels();
    updateTrioUi();
    if (S.player.playing) { stop(); play(); }
    toast('歌だけのファイルを入れました');
  } catch (e) {
    console.error(e);
    toast('このファイルは読めませんでした');
  }
}
async function runSeparation() {
  if (!S.songBuf || S.trio.sepBusy) return;
  ensureAudio();
  let mod;
  try { mod = await import('./engine/separate.js'); } catch (e) { toast('歌を取り出す AI を読み込めませんでした'); return; }
  S.trio.sepBusy = true;
  const btn = $('trio-sep'), prog = $('trio-prog');
  btn.disabled = true;
  prog.hidden = false;
  prog.value = 0;
  const t0 = performance.now();
  $('trio-vocal-state').textContent = '歌を取り出しています…（曲の長さによって 1〜2 分。ほかの操作はできます）';
  try {
    const r = await mod.separateVocals(S.songBuf, { onProgress: (v) => (prog.value = v), base: 'models-sep/' });
    const len = r.vocal[0].length;
    const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: r.sampleRate });
    buf.copyToChannel(r.vocal[0], 0);
    buf.copyToChannel(r.vocal[1] || r.vocal[0], 1);
    S.trio.vocalBuf = buf;
    S.trio.vocalSource = 'ai';
    S.trio.sepMs = performance.now() - t0;
    updateTrioLevels();
    if (S.player.playing) { stop(); play(); }
    toast('歌を取り出しました');
  } catch (e) {
    console.error(e);
    toast('歌を取り出せませんでした：' + (e.message || e), 5000);
  } finally {
    S.trio.sepBusy = false;
    btn.disabled = false;
    prog.hidden = true;
    updateTrioUi();
  }
}

// ───────────────────────── パターン帳：型の一覧・試聴・まとめて使う・自分で作る
function loadCustomPatterns() {
  try { const v = JSON.parse(localStorage.getItem('vai-custom-patterns') || '[]'); return Array.isArray(v) ? v.filter((q) => q && q.id && q.kind) : []; } catch { return []; }
}
function saveCustomPatterns() {
  try { localStorage.setItem('vai-custom-patterns', JSON.stringify(S.settings.customPatterns)); } catch {}
}
function smallBtn(label, onClick, extra = '') {
  const b = document.createElement('button');
  b.className = `btn small ${extra}`.trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
function renderPatternBook() {
  const body = $('patbook-body');
  if (!body) return;
  const wrap = document.createElement('div');
  wrap.className = 'pb';
  const top = document.createElement('div');
  top.className = 'pb-top';
  const note = document.createElement('span');
  note.textContent = '試聴は、この曲の調とテンポで、よくある 4 小節の進行に当てて鳴らします（バイオリンだけ）。';
  top.append(note, smallBtn('選んだ型を全部はずす', () => { S.settings.patterns = {}; recompose(); toast('型を全部はずしました'); }, 'ghost'));
  wrap.append(top);
  for (const [cat, label] of CATEGORIES) {
    const list = cat === 'custom' ? S.settings.customPatterns : PATTERNS.filter((q) => q.cat === cat);
    const h = document.createElement('h4');
    h.textContent = label;
    wrap.append(h);
    if (!list.length) { const e = document.createElement('p'); e.className = 'pb-empty'; e.textContent = 'まだありません。下の「自分で型を作る」から作れます。'; wrap.append(e); continue; }
    for (const q of list) {
      const row = document.createElement('div');
      row.className = 'pb-row';
      row.dataset.id = q.id;
      const t = document.createElement('div');
      t.className = 'pb-text';
      const b = document.createElement('b');
      b.textContent = q.name;
      const d = document.createElement('span');
      d.textContent = q.desc || '';
      t.append(b, d);
      const acts = document.createElement('div');
      acts.className = 'pb-acts';
      acts.append(smallBtn('試聴', () => previewPattern(q)), smallBtn('歌の区間に', () => applyPattern(q.id, 'vocal')), smallBtn('歌のない区間に', () => applyPattern(q.id, 'inst')));
      if (q.cat === 'custom') acts.append(smallBtn('削除', () => deleteCustomPattern(q.id), 'ghost'));
      row.append(t, acts);
      wrap.append(row);
    }
  }
  wrap.append(customPatternForm());
  body.replaceChildren(wrap);
}
function applyPattern(id, which) {
  if (!S.anView) return;
  let n = 0;
  S.anView.sections.forEach((s, i) => { if ((which === 'vocal' && s.vocal) || (which === 'inst' && !s.vocal)) { S.settings.patterns[i] = id; n++; } });
  if (!n) { toast(which === 'vocal' ? '歌の区間がありません' : '歌のない区間がありません'); return; }
  recompose();
  const q = findPattern(id, S.settings.customPatterns);
  toast(`${n} か所の区間を「${q ? q.name : id}」で弾きます`);
}
function deleteCustomPattern(id) {
  S.settings.customPatterns = S.settings.customPatterns.filter((q) => q.id !== id);
  saveCustomPatterns();
  let used = false;
  for (const k of Object.keys(S.settings.patterns)) if (S.settings.patterns[k] === id) { delete S.settings.patterns[k]; used = true; }
  renderPatternBook();
  if (used) recompose(); else if (S.result) renderSections();
}
let previewStop = null;
function stopPreview() { if (previewStop) { previewStop(); previewStop = null; } }
async function previewPattern(q) {
  if (!S.violin) { toast('バイオリンの音を準備しています。少し待ってから押してください'); return; }
  ensureAudio();
  if (S.ctx.state !== 'running') { try { await S.ctx.resume(); } catch {} }
  stop();
  stopPreview();
  const key = S.an ? S.an.key : { tonic: 0, mode: 'maj' };
  const bpm = S.an ? Math.max(60, Math.min(160, S.an.bpm)) : 100;
  const r = patternPreview(q, { tonic: key.tonic, mode: key.mode, bpm });
  const sched = scheduleViolin(S.ctx, S.violin, r.notes, S.bus.input, { songStart: S.ctx.currentTime + 0.1, tuning: S.an ? S.an.tuning : 0, level: S.violinLevel });
  const timer = setTimeout(stopPreview, (r.duration + 2) * 1000);
  previewStop = () => { clearTimeout(timer); sched.stop(); };
  S.lastPreview = { id: q.id, notes: r.notes.length };
  toast(`試聴：${q.name}（${r.chords.map((c) => pcName(c.root, key) + (c.q === 'min' ? 'm' : '')).join(' → ')}）`, 3500);
}
function customPatternForm() {
  const f = document.createElement('div');
  f.className = 'pb-form';
  const opt = (obj, fmt) => Object.entries(obj).map(([k, v]) => `<option value="${k}">${fmt ? fmt(v) : v}</option>`).join('');
  f.innerHTML = `<h4>自分で型を作る</h4>
    <div class="pb-grid">
      <label>名前 <input id="pf-name" maxlength="24" placeholder="例：わたしの 1・5・8"></label>
      <label>作り方 <select id="pf-kind"><option value="chord">和音の音で（1・3・5・8 など）</option><option value="steps">音階の動きで（0・1・2・1 など）</option></select></label>
      <label class="wide">音の並び <input id="pf-tokens" placeholder="例：1 5 8 5"></label>
      <label>リズム <select id="pf-rhythm">${opt(RHYTHMS, (v) => v[0])}<option value="custom">自分で書く…</option></select></label>
      <label id="pf-rc" hidden>リズム（x＝音・-＝のばす・.＝休み・16 文字） <input id="pf-rcustom" maxlength="16" placeholder="x.x-x.x-x.x-x.x-"></label>
      <label>弾き方 <select id="pf-art">${opt(ARTS)}</select></label>
      <label>重音 <select id="pf-dbl">${opt(DOUBLES)}</select></label>
    </div>
    <p class="pb-help">和音の音：1＝根音・3＝3度・5＝5度・7＝7度・8＝根音のオクターブ上・10＝3度のオクターブ上・12＝5度のオクターブ上・-5＝根音の下の 5度。<br>音階の動き：0＝その場の和音の音、1＝音階で 1 つ上、-1＝1 つ下。どちらも、リズムの音ごとに順にくり返します（小節ごとに最初から）。</p>
    <div class="pb-formacts"><button class="btn small" id="pf-try">試聴</button><button class="btn small primary" id="pf-save">保存して使えるようにする</button><span class="pb-err" id="pf-err"></span></div>`;
  const q = (sel) => f.querySelector(sel);
  q('#pf-art').value = 'detache';
  q('#pf-kind').addEventListener('change', () => { q('#pf-tokens').placeholder = q('#pf-kind').value === 'steps' ? '例：0 1 2 1' : '例：1 5 8 5'; });
  q('#pf-rhythm').addEventListener('change', () => { q('#pf-rc').hidden = q('#pf-rhythm').value !== 'custom'; });
  const read = () => {
    const r = parseCustom({ name: q('#pf-name').value || `自分の型 ${S.settings.customPatterns.length + 1}`, kind: q('#pf-kind').value, tokens: q('#pf-tokens').value, rhythm: q('#pf-rhythm').value === 'custom' ? q('#pf-rcustom').value : q('#pf-rhythm').value, art: q('#pf-art').value, dbl: q('#pf-dbl').value });
    q('#pf-err').textContent = r.ok ? '' : r.error;
    return r.ok ? r.pattern : null;
  };
  q('#pf-try').addEventListener('click', () => { const p = read(); if (p) previewPattern(p); });
  q('#pf-save').addEventListener('click', () => {
    const p = read();
    if (!p) return;
    S.settings.customPatterns = [...S.settings.customPatterns, p];
    saveCustomPatterns();
    renderPatternBook();
    if (S.result) renderSections();
    toast(`「${p.name}」を保存しました。区間のカードの「型」から選べます`);
  });
  return f;
}

// テンポの説明：一定／ほぼ一定（揺れる所だけ小節ごと）／揺れあり（小節ごとに合わせ直す。範囲つき）
function tempoNote(an) {
  if (an.steadyTempo) return '（一定。打ち込みの曲のようです）';
  if (an.tempoFollow && (an.tempoGridShare ?? 0) >= 0.8) return '（ほぼ一定。はじめ・終わりなど揺れる所だけ、小節ごとに合わせ直しています）';
  if (an.tempoFollow) {
    const tc = (an.tempoCurve || []).filter((v) => v > 0).sort((a, b) => a - b);
    const rng = tc.length ? `：約 ${Math.round(tc[Math.floor(tc.length * 0.05)])}〜${Math.round(tc[Math.floor(tc.length * 0.95)])} BPM` : '';
    return `（揺れあり。小節ごとにテンポを合わせ直しています${rng}）`;
  }
  return '（揺れあり。拍を 1 つずつ追いかけます）';
}

function renderFound() {
  const an = S.anView;
  const lines = [];
  const vocalSecs = an.sections.filter((s) => s.vocal);
  const src = S.an.vocalSource !== 'ai' ? '音の広がり（代わりの方法）' : S.listenSource === 'yamnet' ? 'ブラウザの中で動く音の分類 AI（Google の YAMNet）' : 'Mac 内蔵の音の分類 AI';
  lines.push(`<p><b>歌っている場所</b>（${src}）：${vocalSecs.length ? vocalSecs.map((s) => `${fmt(an.bars[s.bar0].t0)}〜${fmt(an.bars[s.bar1 - 1].t1)}`).join('、') : '見つかりませんでした（インスト曲として扱います）'}</p>`);
  const inst = an.sections.filter((s) => !s.vocal);
  if (inst.length) lines.push(`<p><b>歌のないところ</b>：${inst.map((s) => `${TYPE_LABEL[s.type]}${s.n}（${fmt(an.bars[s.bar0].t0)}〜）`).join('、')} → ここでバイオリンが前に出ます</p>`);
  if (an.riffs.length) {
    for (const r of an.riffs) {
      const s = an.sections[r.section];
      lines.push(`<p><b>くり返すフレーズ（リフ）</b>：${TYPE_LABEL[s.type]}${s.n} に ${r.periodBars}小節のくり返し（${r.notes.length}音・一致 ${Math.round(r.sim * 100)}%）${r.conf >= 0.55 ? ' → バイオリンでまねられます' : ''}</p>`);
    }
  } else lines.push('<p><b>リフ</b>：はっきりくり返すフレーズは見つかりませんでした</p>');
  // ほかの楽器とのからみ
  const leadSecs = inst.filter((s) => leadStrong(S.an, s));
  if (an.groove && an.groove.some((g) => g)) lines.push('<p><b>ドラム・ベース</b>：小節ごとに、キック・スネア・ハイハットの入る 16 分を聞き取りました → 刻みはそこに乗せ、ソロ・対旋律もそのリズムに寄せて、強い所に軽くアクセントをつけます</p>');
  lines.push(`<p><b>楽器のメロディ</b>：${leadSecs.length ? `${leadSecs.map((s) => `${TYPE_LABEL[s.type]}${s.n}`).join('、')} で、ギター・ピアノなどの目立つ旋律を聞き取りました → バイオリンが同じ旋律を弾きます（楽器が休む所は前後へつながる線でうめます）` : '歌のないところに、はっきりした楽器の旋律は見つかりませんでした（区間の役割で「メロディを弾く」も選べます）'}。歌の息つぎに楽器が入れるフレーズは、バイオリンでまねます</p>`);
  if (S.arrMode === 'trio' && S.trio.guitar) {
    const kinds = S.trio.guitar.plan.filter((q) => q.kind !== 'rest').map((q) => q.name);
    lines.push(`<p><b>再アレンジ（歌＋アコギ＋バイオリン）</b>：歌は${S.trio.vocalBuf ? (S.trio.vocalSource === 'file' ? '歌だけのファイル' : 'AI で原曲から取り出したもの') : 'まだありません'}。アコギは、聞き取ったコードを、指 4 本で押さえられて前のコードから手があまり動かない形で弾きます（${[...new Set(kinds)].join('・')}）。バイオリンは、ギターと歌の音を「鳴っている音」として、ぶつからないように作ります</p>`);
  }
  lines.push('<p><b>アレンジの型</b>（YouTube の弦アレンジ・バイオリン講座 61 本で多くが言っていたこと）：1番の Aメロは低く控えめに入り、サビのたびに少しずつ高く、最後のサビが頂点／歌と同じ音・同じ音域でかぶせない／歌が細かく動く間はのばし、休む・のばす間に動く／長い音は和音が変わっても共通の音を保つ／サビの頭へ駆け上がり、Bメロの終わりは 8 分の刻みで押し上げる／サビが終わったら急に切らずにのばして消える／ソロは短い動機を高さを変えてくり返し、最後に戻る／最後のサビの山場と最後の音は重音</p>');
  if (S.an.vocalLine) lines.push('<p><b>掛け合い</b>：歌のフレーズが終わった息つぎで、その終わりの形をまねて答えます（サビは歌と同じメロディを重ねることもできます：区間の役割「メロディを弾く」）</p>');
  const keys = [];
  an.keyPerBar.forEach((k, i) => { if (!i || k.tonic !== an.keyPerBar[i - 1].tonic || k.mode !== an.keyPerBar[i - 1].mode) keys.push(`${keyNameTrad(k)}（${fmt(an.bars[i].t0)}〜）`); });
  lines.push(`<p><b>曲全体の調</b>：${keyNameJa(an.key)}（${keyNameTrad(an.key)}）${an.key.manual ? '　※手で指定' : ''}。コードとコードの間の音は、この調の音階から選び、原曲の音と半音でぶつかる音は使いません</p>`);
  if (keys.length > 1) lines.push(`<p><b>転調</b>：${keys.join(' → ')}（長く続く、はっきりした転調だけを採用）</p>`);
  const lm = lineModelInfo();
  if (lm) lines.push(`<p><b>旋律のつながり</b>：ポップスのプロのアレンジ ${lm.songs.inst} 曲の副旋律と、ギターソロ ${lm.songs.solo} 曲（合わせて ${Math.round(lm.notes / 1000)} 千音）から学んだ「次のコードへの入り方・跳んだあとの戻り方・フレーズの終わり方・歌の息つぎへの入り方・強弱」で、ソロ・対旋律・合いの手を 1 音ずつ選びます${S.an.vocalLine ? '（歌のメロディも推定して、歌い出しの音へつなげます）' : ''}</p>`);
  else {
    const li = phraseInfo();
    if (li) lines.push(`<p><b>ソロのフレーズ</b>：ギタリストの実際のソロ演奏（GuitarSet）から学んだ ${li.count} 個のフレーズを、この曲のコードに合わせて置きかえて弾きます</p>`);
  }
  lines.push(`<p><b>テンポ</b>：${an.bpm.toFixed(2)} BPM ${tempoNote(an)}・ピッチ ${an.tuning >= 0 ? '+' : ''}${an.tuning.toFixed(1)} セント（バイオリンも合わせます）</p>`);
  $('found-body').innerHTML = lines.join('');
}

// ───────────────────────── 再生
function applyMix() {
  if (!S.ctx) return;
  const t = S.ctx.currentTime;
  const songOn = S.mix.mode !== 'violin', vOn = S.mix.mode !== 'song';
  S.songGain.gain.setTargetAtTime(songOn ? S.mix.vSong : 0, t, 0.02);
  S.bus.setVolume(vOn ? S.mix.vViolin : 0, t);
  S.bus.setReverb(S.mix.reverb, t);
  if (S.guitarBus) S.guitarBus.setVolume(S.arrMode === 'trio' && songOn ? S.mix.vGuitar : 0, t);
}
// 再アレンジのときの音量：歌の大きさに合わせて、ギターとバイオリンを決める（歌がまだなければ原曲から）
function updateTrioLevels() {
  const ref = S.trio.vocalBuf ? loudnessOf(S.trio.vocalBuf) : loudnessOf(S.songBuf) * 0.6;
  S.trio.levels = { violin: (ref / 0.1) * 0.6, guitar: Math.max(0.15, Math.min(3, (ref / 0.1) * 0.75)) };
}
const violinLevelNow = () => (S.arrMode === 'trio' ? S.trio.levels.violin : S.violinLevel);
function currentTime() {
  const p = S.player;
  if (!p.playing) return p.offset;
  return Math.min(S.an ? S.an.duration : 0, S.ctx.currentTime - p.startAt);
}
async function play() {
  if (!S.songBuf || !S.violin) return;
  stopPreview();
  ensureAudio();
  if (S.ctx.state !== 'running') { try { await S.ctx.resume(); } catch {} }
  const p = S.player;
  if (p.playing) return;
  if (p.offset >= S.an.duration - 0.05) p.offset = 0;
  const trio = S.arrMode === 'trio';
  if (trio) { try { await ensureGuitar(); } catch (e) { toast('ギターの音を読み込めませんでした'); return; } }
  const when = S.ctx.currentTime + 0.08;
  const src = S.ctx.createBufferSource();
  // 再アレンジ：歌（取り出したもの）を鳴らす。まだなければ、原曲は音を出さずに時計の代わりにだけ使う
  src.buffer = trio && S.trio.vocalBuf ? S.trio.vocalBuf : S.songBuf;
  src.connect(trio && !S.trio.vocalBuf ? S.silentGain : S.songGain);
  src.start(when, p.offset);
  p.src = src;
  p.startAt = when - p.offset;
  p.sched = scheduleViolin(S.ctx, S.violin, S.result.notes, S.bus.input, { songStart: p.startAt, from: p.offset, tuning: S.an.tuning, level: violinLevelNow() });
  p.gsched = trio && S.trio.guitar && S.guitar ? scheduleGuitar(S.ctx, S.guitar, S.trio.guitar.notes, S.guitarBus.input, { songStart: p.startAt, from: p.offset, tuning: S.an.tuning, level: S.trio.levels.guitar }) : null;
  p.playing = true;
  src.onended = () => { if (p.src === src && p.playing && currentTime() >= S.an.duration - 0.2) { stop(); p.offset = 0; updateTime(); } };
  $('play').classList.add('playing');
  tick();
}
function stop() {
  const p = S.player;
  if (!p.playing) return;
  p.offset = currentTime();
  p.playing = false;
  try { p.src.stop(); } catch {}
  p.src = null;
  p.sched && p.sched.stop();
  p.sched = null;
  p.gsched && p.gsched.stop();
  p.gsched = null;
  $('play').classList.remove('playing');
}
function seek(t) {
  t = Math.max(0, Math.min(S.an.duration, t));
  const was = S.player.playing;
  if (was) stop();
  S.player.offset = t;
  if (was) play();
  updateTime();
}
function rescheduleViolin() {
  const p = S.player;
  if (!p.playing) return;
  p.sched && p.sched.stop();
  const from = currentTime() + 0.05;
  p.sched = scheduleViolin(S.ctx, S.violin, S.result.notes, S.bus.input, { songStart: p.startAt, from, tuning: S.an.tuning, level: violinLevelNow() });
  p.gsched && p.gsched.stop();
  p.gsched = S.arrMode === 'trio' && S.trio.guitar && S.guitar ? scheduleGuitar(S.ctx, S.guitar, S.trio.guitar.notes, S.guitarBus.input, { songStart: p.startAt, from, tuning: S.an.tuning, level: S.trio.levels.guitar }) : null;
}
let rafId = 0;
function tick() {
  cancelAnimationFrame(rafId);
  const loop = () => {
    updateTime(true);
    if (S.player.playing) rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}
let lastSecIdx = -1, lastTimeText = '';
function updateTime(follow) {
  if (!S.an) return;
  const t = currentTime();
  const txt = `${fmt(t)} / ${fmt(S.an.duration)}`;
  if (txt !== lastTimeText) { $('time').textContent = txt; lastTimeText = txt; }
  const x = t * S.view.pps;
  $('playhead').style.transform = `translateX(${x}px)`;
  if (follow) {
    const el = $('timeline');
    if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 60);
  }
  // いまの区間のカードを目立たせる
  const an = S.anView;
  let idx = -1;
  if (an) an.sections.forEach((s, i) => { if (t >= an.bars[s.bar0].t0 && t < an.bars[s.bar1 - 1].t1) idx = i; });
  if (idx !== lastSecIdx) {
    for (const c of $('sections').children) c.classList.toggle('current', +c.dataset.i === idx);
    lastSecIdx = idx;
  }
}

// ───────────────────────── 書き出し
async function doExport(kind) {
  if (!S.result) return;
  const btns = document.querySelectorAll('[data-export]');
  btns.forEach((b) => (b.disabled = true));
  const note = $('export-note');
  try {
    if (kind === 'midi') {
      // 楽譜と同じく拍にそろえた音で書き出す（Logic の楽譜表示もきれいになる）
      const an = S.anView;
      const q = quantizedNotes(currentScore()).map((n) => {
        const t = beatToTime(an.beats, n.beat), t2 = beatToTime(an.beats, n.beat + n.dur);
        return { t, d: t2 - t, midi: n.midi, vel: n.vel, art: n.art, dbl: n.dbl };
      });
      // 駆け上がり（5〜7 連符）は拍にそろえず、そのままのタイミングで
      const runs = S.result.notes.filter((n) => n.role === 'run').map((n) => ({ t: n.t, d: n.d, midi: n.midi, vel: n.vel, art: n.art }));
      const extra = S.arrMode === 'trio' && S.trio.guitar ? [{ name: 'Acoustic Guitar', program: 25, channel: 1, notes: S.trio.guitar.notes }] : [];
      download(notesToMidi(q.concat(runs).sort((a, b) => a.t - b.t), an, { title: S.fileName, extraTracks: extra }), `${S.fileName}_${extra.length ? 'バイオリンとギター' : 'バイオリン'}.mid`);
      note.textContent = extra.length ? 'MIDI を保存しました（バイオリンとアコギの 2 トラック。Logic にドラッグすると、曲のテンポと小節線も合います）' : 'MIDI を保存しました（Logic にドラッグすると、曲のテンポと小節線も合います）';
      return;
    }
    if (kind === 'score') { openScore(); return; }
    if (kind === 'musicxml') { saveMusicXML(); note.textContent = 'MusicXML を保存しました（Logic・MuseScore などで楽譜として開けます）'; return; }
    note.textContent = '書き出しています…（曲の長さによって数十秒かかります）';
    await new Promise((r) => setTimeout(r, 30));
    if (S.arrMode === 'trio') {
      if (kind === 'vocal' && !S.trio.vocalBuf) { note.textContent = '歌がまだありません（「AI で原曲から歌を取り出す」か「歌だけのファイルを入れる」）'; return; }
      const parts = { mix: { vocal: true, guitar: true, violin: true }, violin: { violin: true }, guitar: { guitar: true }, vocal: { vocal: true } }[kind] || { violin: true };
      const buf = await renderTrio(parts);
      const label = { mix: '歌とアコギとバイオリン', violin: 'バイオリンだけ', guitar: 'ギターだけ', vocal: '歌だけ' }[kind];
      download(audioBufferToWav(buf), `${S.fileName}_${label}.wav`);
      note.textContent = '保存しました（ダウンロードフォルダ）';
      return;
    }
    const buf = await renderMix({
      song: S.songBuf, violin: S.violin, notes: S.result.notes,
      includeSong: kind === 'mix', includeViolin: true,
      songVolume: S.mix.vSong, violinVolume: S.mix.vViolin, reverb: S.mix.reverb,
      tuning: S.an.tuning, violinLevel: S.violinLevel,
    });
    download(audioBufferToWav(buf), `${S.fileName}_${kind === 'mix' ? 'バイオリン入り' : 'バイオリンだけ'}.wav`);
    note.textContent = '保存しました（ダウンロードフォルダ）';
  } catch (e) {
    console.error(e);
    note.textContent = '書き出しに失敗しました：' + (e.message || e);
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

// ───────────────────────── 楽譜
function currentScore() {
  return buildScore(S.anView, S.result.notes, S.result.plan, { title: S.fileName });
}
function keyText() {
  const k = S.an.keyPerBar[0] || S.an.key;
  return `調：${keyNameJa(k)}（${keyNameTrad(k)}）`;
}
let scoreStyleAdded = false;
function openScore() {
  if (!S.result) return;
  if (!scoreStyleAdded) {
    const st = document.createElement('style');
    st.textContent = SCORE_CSS;
    document.head.append(st);
    scoreStyleAdded = true;
  }
  const sc = currentScore();
  $('score-page').innerHTML = (S.arrMode === 'trio' && S.trio.guitar ? trioChordChartHtml() : '') + renderScore(sc, { width: 940, keyText: keyText() });
  $('score-view').hidden = false;
  document.body.classList.add('score-open');
  fitClefs($('score-page'));
  $('score-view').querySelector('.score-scroll').scrollTop = 0;
}
function closeScore() {
  $('score-view').hidden = true;
  document.body.classList.remove('score-open');
}
function saveMusicXML() {
  const xml = scoreToMusicXML(currentScore());
  download(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }), `${S.fileName}_バイオリン.musicxml`);
}
$('score-close').addEventListener('click', closeScore);
$('score-xml').addEventListener('click', saveMusicXML);
$('score-print').addEventListener('click', () => {
  const old = document.title;
  document.title = `${S.fileName}_バイオリン譜`;
  window.print();
  setTimeout(() => (document.title = old), 1000);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('score-view').hidden) closeScore(); });

// ───────────────────────── 解析の手直し
async function refix(kind) {
  if (!S.an || S.busy) return;
  const o = S.anOpts;
  const b = S.an.beats, dur = S.an.duration;
  // 拍の並びを、今の拍から作り直す（もう一度テンポを探すより確実）
  if (kind === 'double') {
    if (S.an.bpm * 2 > 260) { toast('これ以上速くはできません'); return; }
    const nb = [];
    for (let i = 0; i < b.length; i++) { nb.push(b[i]); const nx = i + 1 < b.length ? b[i + 1] : b[i] + (b[i] - b[i - 1]); if ((b[i] + nx) / 2 < dur) nb.push((b[i] + nx) / 2); }
    o.beats = nb;
    o.downbeatShift = 0;
  }
  if (kind === 'half') {
    if (S.an.bpm / 2 < 40) { toast('これ以上遅くはできません'); return; }
    // 小節の頭の拍が残るように、1つおきに取る
    const first = S.an.bars.find((x) => !x.pickup)?.b0 || 0;
    o.beats = b.filter((_, i) => (i - first) % 2 === 0);
    o.downbeatShift = 0;
  }
  if (kind === 'shift') o.beats = halfShift(b, dur);
  if (kind === 'bar') o.downbeatShift = (o.downbeatShift + 1) % (S.an.meter || 4);
  if (kind === 'meter') { o.meter = (S.an.meter || 4) === 4 ? 3 : 4; o.downbeatShift = 0; }
  if (kind === 'key') o.beats = b; // 調だけ変えるときは、拍はそのまま
  stop();
  S.busy = true;
  toast(kind === 'key' ? '調を変えて作り直しています…' : '拍を数え直しています…', 4000);
  try {
    await runAnalysis();
    if (kind !== 'key') { S.settings.roles = {}; S.settings.vocal = {}; S.settings.patterns = {}; }
    S.view.peaks = null;
    recompose();
    toast(kind === 'key' ? `調を ${keyNameTrad(S.an.key)} にして作り直しました` : `${S.an.meter}拍子・テンポ ${S.an.bpm.toFixed(1)} BPM で作り直しました`);
    syncControls();
  } catch (e) {
    toast('やり直せませんでした：' + e.message, 5000);
  } finally {
    S.busy = false;
  }
}

// ───────────────────────── 操作
$('file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; handleFile(f); });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').classList.add('over'); });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop').classList.remove('over'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').classList.remove('over');
  const f = [...(e.dataTransfer?.files || [])].find((x) => /^audio\//.test(x.type) || /\.(m4a|mp3|wav|aiff?|flac|caf|aac|ogg)$/i.test(x.name));
  if (f) handleFile(f);
  else toast('音声ファイルを入れてください');
});
$('play').addEventListener('click', () => (S.player.playing ? stop() : play()));
$('timeline').addEventListener('click', (e) => {
  if (!S.an) return;
  const r = $('tl-inner').getBoundingClientRect();
  seek((e.clientX - r.left) / S.view.pps);
});
$('mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.mix.mode = b.dataset.mode;
  syncControls();
  applyMix();
});
$('vol-violin').addEventListener('input', (e) => { S.mix.vViolin = +e.target.value; applyMix(); savePrefs(); });
$('vol-song').addEventListener('input', (e) => { S.mix.vSong = +e.target.value; applyMix(); savePrefs(); });
$('vol-guitar').addEventListener('input', (e) => { S.mix.vGuitar = +e.target.value; applyMix(); });
$('arr-mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.v !== S.arrMode) setArrMode(b.dataset.v); });
$('guitar-style').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.trio.style = b.dataset.v; updateTrioUi(); if (S.an) recompose(); });
$('trio-sep').addEventListener('click', () => runSeparation());
$('trio-vocal-file').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; loadVocalFile(f); });
$('reverb').addEventListener('input', (e) => { S.mix.reverb = +e.target.value; applyMix(); savePrefs(); });
$('style').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !S.an) return;
  S.settings.style = b.dataset.style;
  syncControls();
  savePrefs();
  recompose();
});
$('presence').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !S.an) return;
  S.settings.presence = +b.dataset.p;
  syncControls();
  savePrefs();
  recompose();
});
$('solo-motion').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !S.an) return;
  S.settings.soloMotion = +b.dataset.v;
  syncControls();
  savePrefs();
  recompose();
});
$('motion').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !S.an) return;
  S.settings.motion = +b.dataset.v;
  syncControls();
  savePrefs();
  recompose();
});
$('key-fix').addEventListener('change', (e) => {
  const v = e.target.value;
  S.anOpts.key = v === 'auto' ? null : { tonic: +v.split(':')[0], mode: v.split(':')[1] };
  refix('key');
});
$('sound').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.soundSet = b.dataset.v;
  syncControls();
  savePrefs();
  if (!S.ctx) return;
  await ensureViolin();
  if (S.player.playing) rescheduleViolin();
  toast(S.soundSet === 'logic' ? 'Logic の音にしました（この Mac だけ）' : 'フリー音源（公開版と同じ音）にしました');
});
$('reroll').addEventListener('click', () => {
  if (!S.an) return;
  S.settings.seed++;
  recompose();
  toast(`別のアイデア（#${S.settings.seed}）にしました`);
});
document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => doExport(b.dataset.export)));
document.querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', () => refix(b.dataset.fix)));
$('another').addEventListener('click', () => { stop(); $('studio').hidden = true; $('drop').hidden = false; });
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !S.an || $('studio').hidden || !$('score-view').hidden) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'select', 'textarea', 'button'].includes(tag)) return;
  e.preventDefault();
  S.player.playing ? stop() : play();
});
let resizeT = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    if (!S.an || $('studio').hidden) return;
    const z = +($('zoom')?.value || 1);
    S.view.pps = ($('timeline').clientWidth / S.an.duration) * z;
    drawTimeline();
    updateTime();
  }, 150);
});

// テスト用に中を見られるようにする
window.__violinAI = { S, handleFile, play, stop, seek, recompose, refix, doExport, openScore, closeScore, currentScore, yamnetListen, decode, ensureAudio, previewPattern, applyPattern, renderPatternBook, setArrMode, loadVocalFile, runSeparation, renderTrio };
