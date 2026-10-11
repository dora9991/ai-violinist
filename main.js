// AIバイオリニスト：画面の動き
import { compose, setPhrases, phraseInfo, setLineModel, lineModelInfo, leadStrong, ROLE_LABEL, TYPE_LABEL, STYLES, LOW, HIGH } from './engine/compose.js';
import { chordName, keyNameJa, keyNameTrad, halfShift, pcName } from './engine/analyze.js';
import { loadViolin, makeViolinBus, scheduleViolin, renderMix, loudnessOf } from './engine/sampler.js';
import { audioBufferToWav, notesToMidi, download } from './engine/files.js';
import { buildScore, scoreToMusicXML, quantizedNotes, beatToTime } from './engine/score.js';
import { renderScore, SCORE_CSS, fitClefs } from './engine/notation.js';

const $ = (id) => document.getElementById(id);
const MUTED = new URLSearchParams(location.search).has('mute');
// 公開版（GitHub Pages など・サーバーなし）か、この Mac のサーバーで動いているか
const FORCE_STATIC = document.querySelector('meta[name="vai-mode"]')?.content === 'static' || new URLSearchParams(location.search).has('static');
// 歌の判定の「歌っている」とみなす境目（AI ごとに出す数字の大きさが違う）
const VOCAL_TH = { mac: 0.15, yamnet: 0.008 }; // YAMNet は tests/calibrate-yamnet.cjs で Mac の判定と 93% 一致する値
const ROLE_COLOR = { pad: '#7aa7d9', arp: '#9fd3f7', rhythm: '#a6d96a', counter: '#6cc5b0', solo: '#f0a64a', riff: '#e2685b', fill: '#b993e6', answer: '#d98ad6', copy: '#f2829f', double: '#ff9f80', ending: '#e8cf77' };
const TYPE_COLOR = { intro: '#3b3550', verse: '#2b3a4f', pre: '#2f4656', chorus: '#55402c', inter: '#4d2e31', outro: '#3b3550' };
const ROLE_SHORT = { rest: '休む', pad: 'そっと', arp: '分散和音', rhythm: '刻み', counter: '対旋律', answer: '掛け合い', double: 'メロディ', solo: 'ソロ', riff: 'リフ' };

const S = {
  ctx: null, master: null, songGain: null, bus: null,
  violin: null, violinP: null, violins: {}, mode: FORCE_STATIC ? 'static' : 'server', soundSet: 'free', listenSource: null,
  fileName: '', songBuf: null, pcm: null, listen: null,
  an: null, anView: null, anOpts: { beats: null, downbeatShift: 0, meter: null, key: null },
  settings: { style: 'emotional', presence: 0.6, soloMotion: 1, motion: 1, seed: 1, roles: {}, vocal: {} },
  result: null,
  player: { playing: false, startAt: 0, offset: 0, src: null, sched: null },
  mix: { mode: 'both', vViolin: 1, vSong: 1, reverb: 0.28 },
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
  applyMix();
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
  S.settings.seed = 1;
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
  S.result = compose(S.anView, { ...S.settings });
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
}
function renderFacts() {
  const an = S.an;
  const keys = [];
  an.keyPerBar.forEach((k, i) => { if (!i || k.tonic !== an.keyPerBar[i - 1].tonic || k.mode !== an.keyPerBar[i - 1].mode) keys.push(`${keyNameJa(k)}（${keyNameTrad(k)}）`); });
  $('facts').innerHTML = `${fmt(an.duration)}・<b>${an.bpm.toFixed(an.steadyTempo ? 0 : 1)}</b> BPM${an.steadyTempo ? '' : '（揺れあり）'}・<b>${keys.slice(0, 3).join(' → ')}</b>${keys.length > 3 ? ' …' : ''}・${an.meter}拍子`;
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
    g.fill();
  }
  g.globalAlpha = 1;
  // 凡例
  if (!$('legend').childElementCount) {
    const items = [['pad', 'そっと伴奏（歌の裏）'], ['arp', '分散和音'], ['rhythm', '刻み'], ['counter', '対旋律'], ['solo', 'ソロ'], ['riff', 'リフのまね'], ['double', '楽器のメロディを弾く'], ['copy', '楽器のフレーズをまねる'], ['answer', '掛け合い'], ['fill', '合いの手'], ['ending', '最後の音']];
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
    el.style.borderLeftColor = p.role === 'rest' ? '#555' : ROLE_COLOR[p.role];
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
    el.append(row, row2, sel);
    return el;
  });
  $('sections').replaceChildren(...cards);
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
  lines.push(`<p><b>テンポ</b>：${an.bpm.toFixed(2)} BPM ${an.steadyTempo ? '（一定。打ち込みの曲のようです）' : '（揺れあり。拍を1つずつ追いかけます）'}・ピッチ ${an.tuning >= 0 ? '+' : ''}${an.tuning.toFixed(1)} セント（バイオリンも合わせます）</p>`);
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
}
function currentTime() {
  const p = S.player;
  if (!p.playing) return p.offset;
  return Math.min(S.an ? S.an.duration : 0, S.ctx.currentTime - p.startAt);
}
async function play() {
  if (!S.songBuf || !S.violin) return;
  ensureAudio();
  if (S.ctx.state !== 'running') { try { await S.ctx.resume(); } catch {} }
  const p = S.player;
  if (p.playing) return;
  if (p.offset >= S.an.duration - 0.05) p.offset = 0;
  const when = S.ctx.currentTime + 0.08;
  const src = S.ctx.createBufferSource();
  src.buffer = S.songBuf;
  src.connect(S.songGain);
  src.start(when, p.offset);
  p.src = src;
  p.startAt = when - p.offset;
  p.sched = scheduleViolin(S.ctx, S.violin, S.result.notes, S.bus.input, { songStart: p.startAt, from: p.offset, tuning: S.an.tuning, level: S.violinLevel });
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
  p.sched = scheduleViolin(S.ctx, S.violin, S.result.notes, S.bus.input, { songStart: p.startAt, from, tuning: S.an.tuning, level: S.violinLevel });
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
        return { t, d: t2 - t, midi: n.midi, vel: n.vel };
      });
      download(notesToMidi(q, an, { title: S.fileName }), `${S.fileName}_バイオリン.mid`);
      note.textContent = 'MIDI を保存しました（Logic にドラッグすると、曲のテンポと小節線も合います）';
      return;
    }
    if (kind === 'score') { openScore(); return; }
    if (kind === 'musicxml') { saveMusicXML(); note.textContent = 'MusicXML を保存しました（Logic・MuseScore などで楽譜として開けます）'; return; }
    note.textContent = '書き出しています…（曲の長さによって数十秒かかります）';
    await new Promise((r) => setTimeout(r, 30));
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
  $('score-page').innerHTML = renderScore(sc, { width: 940, keyText: keyText() });
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
    if (kind !== 'key') { S.settings.roles = {}; S.settings.vocal = {}; }
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
window.__violinAI = { S, handleFile, play, stop, seek, recompose, refix, doExport, openScore, closeScore, currentScore, yamnetListen, decode, ensureAudio };
