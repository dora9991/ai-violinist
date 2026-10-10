// バイオリンのパートを作る。
// 歌の裏：そっと長い音（そっと伴奏）／サビ：動きのある対旋律／間奏・イントロ：ソロ／目立つリフ：まねる
import { scaleOf, MAJOR_SCALE, MINOR_SCALE } from './analyze.js';
import { genSoloV3 } from './solo.js';
import { genLine, hasLineModel, connectLp, dynamicsFor } from './line.js';
export { setPhrases, phraseInfo } from './solo.js';
export { setLineModel, lineModelInfo, lineScore } from './line.js';

export const LOW = 55; // G3
export const HIGH = 91; // G6
export const ROLE_LABEL = { auto: 'おまかせ', rest: '休む', pad: 'そっと伴奏', arp: '分散和音', rhythm: '刻み', counter: '対旋律', solo: 'ソロ', riff: 'リフをまねる' };
export const TYPE_LABEL = { intro: 'イントロ', verse: 'Aメロ', pre: 'Bメロ', chorus: 'サビ', inter: '間奏', outro: 'アウトロ' };
export const STYLES = {
  emotional: { label: 'エモーショナル', slide: 0.35, grace: 0.08, trill: 0.1, density: 0.55, nine: true, pent: 0.2 },
  classical: { label: 'クラシカル', slide: 0.1, grace: 0.12, trill: 0.35, density: 0.6, nine: false, pent: 0 },
  rock: { label: 'ロック', slide: 0.45, grace: 0.05, trill: 0.05, density: 0.75, nine: false, pent: 0.7 },
  celtic: { label: 'ケルト', slide: 0.05, grace: 0.45, trill: 0.15, density: 0.8, nine: false, pent: 0.35 },
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pcOf = (m) => ((m % 12) + 12) % 12;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ───────────────────────── 文脈（時間・和音の引き方）
function makeCtx(an, settings) {
  const rand = mulberry32((settings.seed ?? 1) * 7919 + 17);
  const beats = an.beats;
  const nb = beats.length;
  const lastP = nb > 1 ? beats[nb - 1] - beats[nb - 2] : 0.5;
  const beatTime = (x) => {
    if (x <= 0) return beats[0] + x * (nb > 1 ? beats[1] - beats[0] : 0.5);
    const i = Math.floor(x), f = x - i;
    if (i + 1 < nb) return beats[i] + (beats[i + 1] - beats[i]) * f;
    return beats[nb - 1] + lastP * (x - (nb - 1));
  };
  const beatLen = (x) => {
    const i = clamp(Math.floor(x), 0, nb - 2);
    return beats[i + 1] - beats[i];
  };
  const bi = (x) => clamp(Math.floor(x + 1e-6), 0, nb - 1);
  // 和音（無いときは、その拍で鳴っている強い音）
  const chordPcs = (x) => {
    const i = bi(x);
    const ch = an.chords[i];
    if (ch) return ch.pcs.slice();
    const c = an.chroma[i];
    const mx = Math.max(...c);
    return c.map((v, p) => [v, p]).filter(([v]) => v >= mx * 0.8).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, p]) => p);
  };
  const chordRoot = (x) => {
    const ch = an.chords[bi(x)];
    return ch ? ch.root : chordPcs(x)[0];
  };
  const keyAt = (x) => an.keyPerBar[an.barOfBeat[bi(x)]] || an.key;
  const scalePcs = (x) => scaleOf(keyAt(x));
  // 原曲で実際に鳴っている強さ（0〜1）
  const heard = (pc, x) => {
    const c = an.chroma[bi(x)];
    const mx = Math.max(...c) || 1;
    return c[((pc % 12) + 12) % 12] / mx;
  };
  // 和音の音のうち、使ってよいもの：曲の調の音階にある音か、調の外でも原曲で強く鳴っている音
  // （例：イ短調の E のコードの G# は、原曲で鳴っていれば使う。読み違いの和音の音は使わない）
  const safeChordPcs = (x) => {
    const sc = scalePcs(x);
    const all = chordPcs(x);
    // 原曲で鳴っていない 7 度などが、半音となりの強い音とぶつかるなら使わない（例：F のコードを FM7 と読んだときの E）
    const ok = all.filter((pc) => (sc.includes(pc) || heard(pc, x) >= 0.55) && !clashes(pc, x));
    if (ok.length) return ok;
    const inKey = all.filter((pc) => sc.includes(pc));
    return inKey.length ? inKey : all;
  };
  // 半音となりに、原曲で強く鳴っている音があって、自分は鳴っていない（＝長く弾くと濁る）
  const clashes = (pc, x) => heard(pc, x) < 0.35 && Math.max(heard(pc + 1, x), heard(pc + 11, x)) >= 0.7;
  // 鳴っている音として安全か（和音の音＝0、音階の音＝1、外れ・ぶつかる＝2）
  const tension = (m, x) => {
    const pc = pcOf(m);
    if (safeChordPcs(x).includes(pc)) return 0;
    if (scalePcs(x).includes(pc) && !clashes(pc, x)) return 1;
    return 2;
  };
  const vocalAt = (x) => an.vocalProb[bi(x)] || 0;
  // 歌のメロディ（推定・16 分ごと）：息つぎの場所・次に歌い出す音
  const VL = an.vocalLine || null;
  const vocalPitch = (step) => { if (!VL || step < 0 || step >= VL.length) return null; const v = VL[step]; return v >= 0 ? v : null; };
  let nextOn = null;
  if (VL) {
    nextOn = new Int32Array(VL.length);
    let nx = 1e9;
    for (let s = VL.length - 1; s >= 0; s--) { if (VL[s] >= 0 && (s === 0 || VL[s - 1] !== VL[s])) nx = s; nextOn[s] = Math.min(1e6, nx - s); }
  }
  const vocalState = (step) => {
    if (!VL || step < 0 || step >= VL.length) return null;
    const v = VL[step];
    const state = v < 0 ? 'rest' : step > 0 && VL[step - 1] === v ? 'hold' : 'on';
    const u = nextOn[step];
    return { state, ub: u <= 1 ? 0 : u <= 3 ? 1 : u <= 7 ? 2 : u <= 15 ? 3 : 4 };
  };
  const nextVocalNote = (step) => { if (!VL || step < 0 || step >= VL.length) return null; const u = nextOn[step]; return u < 32 ? VL[step + u] : null; };
  return { an, settings, rand, beatTime, beatLen, chordPcs: safeChordPcs, rawChordPcs: chordPcs, chordRoot, keyAt, scalePcs, tension, heard, clashes, vocalAt, vocalPitch, vocalState, nextVocalNote, hasVocalLine: !!VL, nb, style: STYLES[settings.style] || STYLES.emotional };
}

// 区間の中の小節（拍の位置）
function sectionBars(an, sec) {
  return an.bars.slice(sec.bar0, sec.bar1).map((b, k) => ({ ...b, idx: sec.bar0 + k }));
}

// ───────────────────────── 役割を決める
export function planRoles(an, settings) {
  const presence = settings.presence ?? 0.6;
  const motion = settings.motion ?? 1;
  const riffBySec = new Map();
  for (const r of an.riffs || []) riffBySec.set(r.section, r);
  const plan = an.sections.map((sec, si) => {
    const nBars = sec.bar1 - sec.bar0;
    const riff = riffBySec.get(si);
    const hasRiff = riff && riff.conf >= 0.55;
    let role = 'pad', intensity = 0.5;
    switch (sec.type) {
      case 'intro':
        role = hasRiff ? 'riff' : nBars >= 4 ? 'solo' : 'pad';
        intensity = 0.45;
        break;
      case 'verse':
        // 伴奏の動き：0 しっとり（長い音）／1 ほどよく（つなぎの音つき）／2 リズミカル（分散和音）
        role = sec.n === 1 && presence < 0.45 ? 'rest' : motion >= 2 ? (sec.n % 2 === 0 ? 'rhythm' : 'arp') : 'pad';
        intensity = sec.n === 1 ? 0.25 : 0.4;
        break;
      case 'pre':
        role = motion >= 2 ? 'rhythm' : 'pad';
        intensity = 0.55;
        break;
      case 'chorus':
        role = presence < 0.45 ? 'pad' : 'counter';
        intensity = sec.lastChorus ? 0.9 : 0.7;
        break;
      case 'inter':
        role = hasRiff && nBars < 6 ? 'riff' : 'solo';
        intensity = 0.9;
        break;
      case 'outro':
        role = hasRiff ? 'riff' : 'solo';
        intensity = 0.5;
        break;
    }
    if (nBars <= 1 && (role === 'solo' || role === 'riff')) role = 'pad';
    const over = settings.roles && settings.roles[si];
    if (over && over !== 'auto') role = over;
    if (role === 'riff' && !riff) role = 'solo';
    return { si, sec, role, intensity: clamp(intensity * (0.6 + 0.6 * presence), 0.1, 1), riff: riff || null, auto: !(over && over !== 'auto') };
  });
  return plan;
}

// ───────────────────────── 和音のまとまり（区間の中）
function chordSpans(ctx, bars, maxBeats) {
  const spans = [];
  for (const bar of bars) {
    for (let k = 0; k < bar.n; k++) {
      const x = bar.b0 + k;
      const pcs = ctx.chordPcs(x);
      const key = pcs.slice().sort().join(',');
      const last = spans[spans.length - 1];
      const startsBar = k === 0;
      if (last && last.key === key && last.len < maxBeats && !(startsBar && last.len >= maxBeats / 2 && (bar.idx % 2 === 0))) {
        last.len++;
      } else spans.push({ x, len: 1, key, pcs });
    }
  }
  // 1拍だけの和音は前につなぐ（長い音の伴奏では細かく追わない）
  for (let i = spans.length - 1; i > 0; i--) {
    if (spans[i].len === 1 && spans[i - 1].len >= 1) {
      spans[i - 1].len += 1;
      spans.splice(i, 1);
    }
  }
  return spans;
}

const PC_ROLE_COST = (m, ctx, x) => {
  const root = ctx.chordRoot(x);
  const iv = pcOf(m - root);
  if (iv === 3 || iv === 4) return 0; // 3度
  if (iv === 10 || iv === 11) return 0.1; // 7度
  if (iv === 7) return 0.35; // 5度
  if (iv === 0) return 0.55; // 根音
  if (iv === 2) return 0.4; // 9度
  return 0.6;
};

// ───────────────────────── そっと伴奏（歌の裏）
function genPad(ctx, item, out, prevNote) {
  const { an, rand } = ctx;
  const sec = item.sec;
  const bars = sectionBars(an, sec).filter((b) => !b.pickup);
  if (!bars.length) return prevNote;
  const inten = item.intensity;
  const sparse = inten < 0.35;
  const spans = chordSpans(ctx, bars, sparse ? 8 : 4);
  const low = item.registerLow ?? (sec.type === 'pre' ? 69 : 67);
  const high = item.registerHigh ?? (sec.type === 'pre' ? 86 : 83);
  const center0 = (low + high) / 2;
  // 1番の A メロなどは、後半から静かに入る
  let startIdx = 0;
  if (sparse && spans.length > 2) startIdx = Math.floor(spans.length / 2);
  // 動的計画法で、なめらかに動く音の並びを選ぶ
  const cand = spans.map((sp, i) => {
    const list = [];
    for (let m = low; m <= high; m++) {
      const pc = pcOf(m);
      const inChord = sp.pcs.includes(pc);
      const nine = ctx.style.nine && pcOf(m - ctx.chordRoot(sp.x)) === 2 && ctx.scalePcs(sp.x).includes(pc);
      if (!inChord && !nine) continue;
      // 和音が変わる途中の拍でも濁らないか（全拍で和音の音か音階の音）
      let ok = true;
      for (let k = 0; k < sp.len; k++) if (ctx.tension(m, sp.x + k) > 1) ok = false;
      if (!ok) continue;
      list.push(m);
    }
    if (!list.length) list.push(clamp(Math.round(center0), low, high));
    return list;
  });
  const rising = sec.type === 'pre';
  const centerAt = (i) => (rising ? low + 3 + ((high - low - 4) * i) / Math.max(1, spans.length - 1) : center0);
  const N = spans.length;
  const cost = [], back = [];
  for (let i = 0; i < N; i++) {
    cost.push(new Array(cand[i].length).fill(Infinity));
    back.push(new Array(cand[i].length).fill(-1));
    for (let j = 0; j < cand[i].length; j++) {
      const m = cand[i][j];
      let local = PC_ROLE_COST(m, ctx, spans[i].x) + 0.07 * Math.abs(m - centerAt(i)) + rand() * 0.05;
      // 歌とこすれない（歌の音と 2度でぶつかる長い音は避ける）
      if (ctx.hasVocalLine) {
        let rub = 0;
        for (let k = 0; k < spans[i].len * 4; k++) { const v = ctx.vocalPitch(spans[i].x * 4 + k); if (v != null) { const d = Math.abs(m - v) % 12; if (d === 1 || d === 2 || d === 11 || d === 10) rub++; } }
        local += 0.15 * rub;
      }
      if (i === 0) {
        const from = prevNote ? prevNote.midi : Math.round(centerAt(0));
        cost[i][j] = local + 0.25 * Math.abs(m - from);
        continue;
      }
      for (let q = 0; q < cand[i - 1].length; q++) {
        const p = cand[i - 1][q];
        const iv = Math.abs(m - p);
        let tc = iv === 0 ? 0.35 : iv <= 2 ? 0.05 : iv <= 4 ? 0.3 : iv <= 7 ? 1.2 : 3;
        if (rising && m < p) tc += 0.5;
        // 学んだ「コードが変わる所のつながり」（例：次のコードの 4度にいた音は 3度へ）
        if (hasLineModel()) {
          const r = ctx.chordRoot(spans[i].x);
          const c = connectLp(pcOf(p - r), pcOf(m - r));
          if (c != null) tc -= 0.35 * (c + 2.3);
        }
        const v = cost[i - 1][q] + tc + local;
        if (v < cost[i][j]) { cost[i][j] = v; back[i][j] = q; }
      }
    }
  }
  let j = 0;
  for (let q = 1; q < cand[N - 1].length; q++) if (cost[N - 1][q] < cost[N - 1][j]) j = q;
  const pick = new Array(N);
  for (let i = N - 1; i >= 0; i--) { pick[i] = cand[i][j]; j = back[i][j]; }
  const motion = ctx.settings.motion ?? 1;
  const unit = an.bpm >= 140 ? 1 : 0.5; // つなぎの音の長さ（拍）
  let last = prevNote;
  for (let i = startIdx; i < N; i++) {
    const sp = spans[i];
    const m = pick[i];
    const next = i + 1 < N ? pick[i + 1] : null;
    // 伴奏の動き「ほどよく」以上：次の和音の音へ、音階でつなぐ（例：ミ〜〜〜 レ↘ド）
    let approach = [];
    if (motion >= 1 && next != null && next !== m && sp.len >= 2 && rand() < (motion >= 2 ? 0.8 : 0.55)) {
      const n2 = Math.min(2, Math.round(1 / unit));
      const xEnd = sp.x + sp.len;
      const dir = next > m ? -1 : 1; // 次の音へ、反対側から近づく
      const sc = ctx.scalePcs(xEnd - 0.5);
      let p = next;
      const seq = [];
      for (let k = 0; k < n2; k++) { p = stepScale(p, dir, sc); seq.unshift(p); }
      const ok = seq.every((q, k) => ctx.tension(q, xEnd - (n2 - k) * unit) <= 1 && Math.abs(q - m) <= 7);
      if (ok) approach = seq.map((q, k) => ({ x: xEnd - (n2 - k) * unit, len: unit, midi: q }));
    }
    const mainLen = sp.len - approach.length * unit;
    const t = ctx.beatTime(sp.x), te = ctx.beatTime(sp.x + mainLen);
    // 同じ音が続くときは弓を返す（つなげず、やわらかく入り直す）
    const phrasePos = (i - startIdx) / Math.max(1, N - startIdx - 1);
    const vel = clamp(0.22 + 0.4 * inten + (rising ? 0.2 * phrasePos : 0.06 * Math.sin(Math.PI * phrasePos)), 0.15, 0.85);
    const n = { t, d: te - t, midi: m, vel, art: te - t > 1.2 ? 'sneak' : 'sus', legato: !!last && last.midi !== m && Math.abs(last.t + last.d - t) < 0.05, shape: 'swell', role: 'pad', sec: item.si };
    out.push(n);
    last = n;
    for (const a of approach) {
      const ta = ctx.beatTime(a.x), tb = ctx.beatTime(a.x + a.len);
      const an2 = { t: ta, d: tb - ta, midi: a.midi, vel: clamp(vel * 0.9, 0.15, 0.8), art: 'sus', legato: true, shape: 'flat', role: 'pad', sec: item.si };
      out.push(an2);
      last = an2;
    }
  }
  return last;
}

// ───────────────────────── 分散和音（アルペジオ）：和音の音を 8 分で上り下り
const ARP_PATTERNS = [[0, 1, 2, 1], [0, 2, 1, 2], [0, 1, 2, 3], [2, 1, 0, 1], [0, 2, 3, 1]];
function genArp(ctx, item, out, prevNote) {
  const { an, rand } = ctx;
  const bars = sectionBars(an, item.sec).filter((b) => !b.pickup);
  if (!bars.length) return prevNote;
  const unit = an.bpm >= 140 ? 1 : 0.5;
  const pat = ARP_PATTERNS[Math.floor(rand() * ARP_PATTERNS.length)];
  const lo = 60, hi = 81;
  let base = prevNote ? clamp(prevNote.midi - 5, 62, 70) : 65;
  let last = prevNote;
  let k = 0;
  const inten = item.intensity;
  for (const bar of bars) {
    for (let pos = 0; pos < bar.n - 1e-6; pos += unit, k++) {
      const x = bar.b0 + pos;
      const pcs = ctx.chordPcs(x);
      const tones = [];
      for (let m = lo; m <= hi; m++) if (pcs.includes(pcOf(m))) tones.push(m);
      if (!tones.length) continue;
      // 前の形に近い、下から 4 つの音
      let st = tones.findIndex((m) => m >= base - 1);
      if (st < 0) st = Math.max(0, tones.length - 4);
      const voicing = tones.slice(st, st + 4);
      while (voicing.length < 4 && st > 0) voicing.unshift(tones[--st]);
      if (pos === 0) base = voicing[0];
      const m = voicing[Math.min(voicing.length - 1, pat[k % pat.length])];
      const t = ctx.beatTime(x), te = ctx.beatTime(x + unit);
      const accent = pos === 0 ? 0.06 : 0;
      const n = { t, d: (te - t) * 0.95, midi: m, vel: clamp(0.24 + 0.22 * inten + accent, 0.15, 0.6), art: 'sus', legato: pos > 0, shape: 'flat', role: 'arp', sec: item.si };
      out.push(n);
      last = n;
    }
  }
  return last;
}

// ───────────────────────── 刻み：同じ音をリズムでくり返す（ポップスの弦の定番）
const RHYTHM_PATTERNS = {
  eighth: [0, 2, 4, 6, 8, 10, 12, 14],
  sync332: [0, 3, 6, 8, 11, 14], // 3+3+2 のシンコペーション
  gallop: [0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15],
  offbeat: [2, 6, 10, 14], // 裏拍だけ
};
function genRhythm(ctx, item, out, prevNote) {
  const { an, rand } = ctx;
  const bars = sectionBars(an, item.sec).filter((b) => !b.pickup && b.n === an.meter);
  if (!bars.length) return prevNote;
  const fast = an.bpm >= 140;
  const names = fast ? ['eighth', 'sync332', 'offbeat'] : ['eighth', 'sync332', 'gallop', 'sync332'];
  const pat = RHYTHM_PATTERNS[names[Math.floor(rand() * names.length)]].filter((s) => s < an.meter * 4);
  const rising = item.sec.type === 'pre';
  let m = prevNote ? clamp(prevNote.midi, 69, 81) : 74;
  let last = prevNote;
  bars.forEach((bar, bi) => {
    pat.forEach((s16, k) => {
      const x = bar.b0 + s16 / 4;
      const pcs = ctx.chordPcs(x);
      if (!pcs.includes(pcOf(m))) m = nearestIn(m, pcs, 67, 84);
      const nextS = k + 1 < pat.length ? pat[k + 1] : an.meter * 4;
      const t = ctx.beatTime(x), te = ctx.beatTime(bar.b0 + nextS / 4);
      const prog = (bi + k / pat.length) / bars.length;
      const vel = clamp((rising ? 0.28 + 0.4 * prog : 0.3 + 0.3 * item.intensity) + (s16 % 4 === 0 ? 0.07 : 0), 0.15, 0.85);
      const n = { t, d: Math.min(te - t, ctx.beatLen(x) * 0.5) * 0.9, midi: m, vel, art: 'mrc', legato: false, shape: 'flat', role: 'rhythm', sec: item.si };
      out.push(n);
      last = n;
    });
  });
  return last;
}

// ───────────────────────── 合いの手（歌の切れ目に短いフレーズ）
function addFills(ctx, item, out) {
  const { an, rand } = ctx;
  const sec = item.sec;
  const bars = sectionBars(an, sec).filter((b) => !b.pickup);
  const presence = ctx.settings.presence ?? 0.6;
  if (presence < 0.4) return;
  const meter = an.meter;
  for (let k = 3; k < bars.length; k += 4) {
    const bar = bars[k];
    if (k + 1 >= bars.length && item.si === an.sections.length - 1) continue;
    // 小節の後半で歌が切れているか
    const xs = bar.b0 + Math.floor(meter / 2);
    let vMin = 1, vSec = 0, cnt = 0;
    for (let x = xs; x < bar.b0 + bar.n; x++) vMin = Math.min(vMin, ctx.vocalAt(x));
    for (const b of bars) for (let q = 0; q < b.n; q++) { vSec += ctx.vocalAt(b.b0 + q); cnt++; }
    vSec /= Math.max(1, cnt);
    if (!(vMin < vSec * 0.55 || vMin < 0.12)) continue;
    if (rand() > 0.45 + 0.4 * presence) continue;
    // 次の小節の頭の音（なければ和音の音）へ向かう
    const tFill = ctx.beatTime(xs), tEnd = ctx.beatTime(bar.b0 + bar.n);
    const next = out.find((n) => n.t >= tEnd - 0.02 && n.t < tEnd + 0.3);
    const cur = out.filter((n) => n.t < tFill && n.t + n.d > tFill).pop();
    const target = next ? next.midi : cur ? cur.midi : 76;
    const sc = ctx.scalePcs(xs);
    const steps = meter - Math.floor(meter / 2) >= 2 ? 4 : 2;
    const dir = rand() < 0.5 ? 1 : -1;
    const notes = [];
    let m = target;
    for (let s = 0; s < steps; s++) {
      // 目標から音階を逆向きにたどって、そこへ流れ込む
      m = stepScale(m, dir, sc);
      notes.unshift(m);
    }
    if (cur) cur.d = Math.max(0.15, tFill - cur.t);
    const dur = (tEnd - tFill) / steps;
    notes.forEach((mm, i) => {
      out.push({ t: tFill + i * dur, d: dur, midi: clamp(mm, LOW, HIGH), vel: 0.45 + 0.2 * item.intensity, art: 'sus', legato: i > 0, shape: 'flat', role: 'fill', sec: item.si });
    });
  }
}
function stepScale(m, dir, sc) {
  let x = m;
  for (let k = 0; k < 3; k++) {
    x += dir;
    if (sc.includes(pcOf(x))) return x;
  }
  return m + dir * 2;
}
function nearestIn(m, pcs, lo = LOW, hi = HIGH) {
  let best = null;
  for (let d = 0; d <= 12; d++) {
    for (const s of [m + d, m - d]) {
      if (s < lo || s > hi) continue;
      if (pcs.includes(pcOf(s))) { best = s; break; }
    }
    if (best != null) break;
  }
  return best ?? clamp(m, lo, hi);
}

// ───────────────────────── 対旋律（サビ）
const COUNTER_RHYTHMS = {
  // 1小節の中の音の長さ（拍）
  calm: [[4], [2, 2], [3, 1]],
  move: [[2, 2], [2, 1, 1], [1, 1, 2], [3, 1], [1.5, 0.5, 2]],
  busy: [[1, 1, 1, 1], [2, 1, 1], [1, 0.5, 0.5, 2], [0.5, 0.5, 1, 2]],
  // シンコペーション（付点 4 分＋付点 4 分＋4 分、裏拍から入る）
  sync: [[1.5, 1.5, 1], [0.5, 1.5, 2], [1.5, 0.5, 2], [0.75, 0.25, 1, 2]],
};
function genCounter(ctx, item, out, prevNote) {
  const { an, rand } = ctx;
  const sec = item.sec;
  const bars = sectionBars(an, sec).filter((b) => !b.pickup);
  if (!bars.length) return prevNote;
  const inten = item.intensity;
  const low = item.registerLow ?? 69, high = item.registerHigh ?? (inten > 0.8 ? 89 : 86);
  const meter = an.meter;
  // 音の位置を作る（歌が強いところは長く、弱いところは動く）
  const slots = [];
  bars.forEach((bar, bi) => {
    let v = 0;
    for (let q = 0; q < bar.n; q++) v += ctx.vocalAt(bar.b0 + q);
    v /= bar.n;
    const endOfPhrase = bi % 4 === 3;
    const presence = ctx.settings.presence ?? 0.6;
    const motion = ctx.settings.motion ?? 1;
    let pool = motion === 0 || ((v > 0.75 || presence < 0.45) && motion < 2) ? COUNTER_RHYTHMS.calm
      : motion >= 2 && !endOfPhrase ? (v < 0.6 ? COUNTER_RHYTHMS.busy : COUNTER_RHYTHMS.sync)
      : v < 0.25 && inten > 0.75 && !endOfPhrase ? COUNTER_RHYTHMS.busy : COUNTER_RHYTHMS.move;
    if (endOfPhrase) pool = [[2, 2], [3, 1], [4]];
    let pat = pool[Math.floor(rand() * pool.length)];
    if (meter !== 4) pat = meter === 3 ? [[3], [2, 1], [1, 1, 1]][Math.floor(rand() * 3)] : [meter];
    let pos = 0;
    for (const len of pat) {
      if (pos + len > bar.n + 1e-6) break;
      slots.push({ x: bar.b0 + pos, len, strong: pos === 0 || (meter === 4 && pos === 2) || len >= 2, bar: bi });
      pos += len;
    }
  });
  const N = slots.length;
  const centerAt = (i) => {
    const ph = i / Math.max(1, N - 1);
    return low + (high - low) * (0.45 + 0.35 * Math.sin(Math.PI * Math.min(1, ph * 1.15)));
  };
  const cand = slots.map((sl) => {
    const list = [];
    for (let m = low; m <= high; m++) {
      const tns = ctx.tension(m, sl.x);
      if (tns > 1) continue;
      if (sl.strong && tns > 0) continue;
      // 長い音は、続く拍でも濁らないこと
      let ok = true;
      for (let k = 1; k < Math.ceil(sl.len); k++) if (ctx.tension(m, sl.x + k) > (sl.strong ? 0 : 1)) ok = false;
      if (ok) list.push({ m, nct: tns > 0 });
    }
    if (!list.length) list.push({ m: nearestIn(Math.round(centerAt(0)), ctx.chordPcs(sl.x), low, high), nct: false });
    return list;
  });
  const cost = [], back = [];
  for (let i = 0; i < N; i++) {
    cost.push(new Array(cand[i].length).fill(Infinity));
    back.push(new Array(cand[i].length).fill(-1));
    for (let j = 0; j < cand[i].length; j++) {
      const { m, nct } = cand[i][j];
      const local = (nct ? 0.6 : PC_ROLE_COST(m, ctx, slots[i].x) * 0.6) + 0.06 * Math.abs(m - centerAt(i)) + rand() * 0.15;
      if (i === 0) {
        const from = prevNote ? prevNote.midi : Math.round(centerAt(0));
        cost[i][j] = local + 0.15 * Math.abs(m - from);
        continue;
      }
      for (let q = 0; q < cand[i - 1].length; q++) {
        const p = cand[i - 1][q];
        const iv = Math.abs(m - p.m);
        let tc = iv === 0 ? 0.6 : iv <= 2 ? 0 : iv <= 4 ? 0.25 : iv <= 7 ? 0.9 : iv <= 9 ? 2 : 4;
        if (p.nct && iv > 2) tc += 3; // 経過音は音階でぬける
        if (nct && iv > 2) tc += 3;
        const v = cost[i - 1][q] + tc + local;
        if (v < cost[i][j]) { cost[i][j] = v; back[i][j] = q; }
      }
    }
  }
  let j = 0;
  for (let q = 1; q < cand[N - 1].length; q++) if (cost[N - 1][q] < cost[N - 1][j]) j = q;
  const pick = new Array(N);
  for (let i = N - 1; i >= 0; i--) { pick[i] = cand[i][j].m; j = back[i][j]; }
  let last = prevNote;
  slots.forEach((sl, i) => {
    const t = ctx.beatTime(sl.x), te = ctx.beatTime(sl.x + sl.len);
    const ph = i / Math.max(1, N - 1);
    const vel = clamp(0.35 + 0.45 * inten + 0.1 * Math.sin(Math.PI * ph) + (sl.strong ? 0.03 : -0.03), 0.2, 0.95);
    const long = te - t >= 0.9;
    const n = { t, d: te - t, midi: pick[i], vel, art: long && i === 0 ? 'sneak' : 'sus', legato: i > 0, shape: long ? 'swell' : 'flat', role: 'counter', sec: item.si };
    if (long && rand() < ctx.style.slide * 0.5 && last && pick[i] > last.midi + 2) n.slide = -2;
    out.push(n);
    last = n;
  });
  return last;
}


// ───────────────────────── 学んだ統計で作る線（ソロ・対旋律・合いの手）
// 線（genLine の結果）を、鳴らす音符にする
function lineToNotes(ctx, item, ln, role, velOf, opt = {}) {
  const { rand, style } = ctx;
  const out = [];
  let peak = null;
  for (const n of ln) if (n.len >= 0.75 && (!peak || n.midi > peak.midi)) peak = n;
  const dyn = dynamicsFor(ln);
  ln.forEach((n, i) => {
    const t = ctx.beatTime(n.x), te = ctx.beatTime(n.x + n.len);
    const d = te - t;
    const pv = ln[i - 1];
    const touching = pv && Math.abs(pv.x + pv.len - n.x) < 1e-6;
    const note = {
      t, d, midi: n.midi, vel: clamp(velOf(n, i) + dyn[i], 0.15, 1),
      art: !touching && d > 0.9 ? 'sneak' : !touching && d < 0.3 && n.onBeat && opt.accent ? 'mrc' : 'sus',
      legato: !!touching, shape: d >= 0.8 ? 'swell' : 'flat', role, sec: item.si,
    };
    if (d >= 0.6 && pv && n.midi - pv.midi >= 4 && rand() < style.slide) note.slide = -2;
    if (n.len >= 1 && (n === peak || n.phraseEnd)) note.vib = 1;
    out.push(note);
  });
  return out;
}
const barsOf = (ctx, item) => sectionBars(ctx.an, item.sec).filter((b) => !b.pickup && b.n === 4);
// 次の区間のはじめの音（つながりの目標）
function nextTargetPitch(ctx, item, center) {
  const an = ctx.an;
  const nextSec = an.sections[item.si + 1];
  if (!nextSec) return null;
  const x = an.bars[nextSec.bar0].b0;
  // 次が歌なら、歌い出しの音（推定）へ。なければ次のコードの音
  const v = ctx.nextVocalNote(x * 4);
  if (v != null) { let m = v; while (m < center - 7) m += 12; while (m > center + 7) m -= 12; return m; }
  const pcs = ctx.chordPcs(x);
  return nearestIn(Math.round(center), pcs, 55, 91);
}

function genSoloLine(ctx, item, out, prevNote, nextIsVocal) {
  const bars = barsOf(ctx, item);
  if (bars.length < 1) return prevNote;
  const sec = item.sec;
  const isIntro = sec.type === 'intro', isOutro = sec.type === 'outro';
  const motion = ctx.settings.soloMotion ?? 1;
  const inten = item.intensity;
  // 1 小節の音の数のめやす（はじめ → 終わりでだんだん増える）
  const dens = [[[2, 5], [3, 7]], [[3, 7], [6, 11]], [[5, 10], [8, 14]]][motion];
  const N = bars.length;
  const startC = prevNote ? clamp(prevNote.midi, 69, 81) : 74;
  const hi = isIntro || isOutro ? 86 : 90;
  const center = (p) => clamp(startC + (isOutro ? -2 : 8 * inten) * Math.sin((Math.PI / 2) * Math.min(1, p * 1.2)), 66, hi - 4);
  const ln = genLine(ctx, {
    kind: 'solo', bars,
    densityAt: (bi) => { const p = bi / Math.max(1, N - 1); const a = dens[0], b = dens[1]; return [Math.round(a[0] + (b[0] - a[0]) * p), Math.round(a[1] + (b[1] - a[1]) * p)]; },
    lo: 62, hi, center, prev: prevNote ? prevNote.midi : null,
    target: nextTargetPitch(ctx, item, center(1)),
    endLong: !nextIsVocal, endRest: nextIsVocal,
    phraseBars: motion === 2 ? 4 : 2, // 2〜4 小節ごとに息つぎ
    beam: 28,
  });
  if (!ln.length) return genSoloV3(ctx, item, out, prevNote, nextIsVocal, sectionBars(ctx.an, sec).filter((b) => !b.pickup));
  // 最後の音：次が歌でなければ長くのばして決める
  const last = ln[ln.length - 1];
  const end = bars[N - 1].b0 + 4;
  if (!nextIsVocal && end - last.x > last.len) last.len = Math.min(end - last.x, Math.max(last.len, 2));
  const notes = lineToNotes(ctx, item, ln, 'solo', (n, i) => 0.45 + 0.4 * inten * (0.75 + 0.25 * (i / ln.length)) + (n.onBeat ? 0.05 : 0), { accent: inten > 0.6 });
  const lastOut = notes[notes.length - 1];
  if (lastOut) { lastOut.vib = 1; lastOut.shape = nextIsVocal ? 'fade' : 'swell'; }
  out.push(...notes);
  return lastOut || prevNote;
}

function genCounterLine(ctx, item, out, prevNote) {
  const bars = barsOf(ctx, item);
  if (!bars.length) return prevNote;
  const motion = ctx.settings.motion ?? 1;
  const inten = item.intensity;
  const dens = [[1, 3], [2, 5], [3, 8]][motion];
  const N = bars.length;
  const center = (p) => 75 + 4 * Math.sin(Math.PI * Math.min(1, p * 1.1));
  // 歌っている最中は長くのばし、動くのは歌の息つぎで（弦のアレンジの基本）：歌の途中の短い音は、前の音にまとめる
  const shapeRhythm = (notes) => {
    if (!ctx.hasVocalLine) return notes;
    const out2 = [];
    for (const nt of notes) {
      const st = ctx.vocalState(nt.step);
      const singing = st && st.state !== 'rest';
      const prevNt = out2[out2.length - 1];
      if (singing && nt.len < 4 && prevNt && nt.step - (prevNt.step + prevNt.len) <= 1) { prevNt.len = nt.step + nt.len - prevNt.step; continue; }
      out2.push({ ...nt });
    }
    return out2;
  };
  const ln = genLine(ctx, {
    kind: 'counter', bars, densityAt: () => dens, shapeRhythm,
    lo: 67, hi: inten > 0.8 ? 89 : 86, center, prev: prevNote ? prevNote.midi : null,
    target: nextTargetPitch(ctx, item, center(1)),
    vocalPitch: ctx.vocalPitch, vocalState: ctx.hasVocalLine ? ctx.vocalState : null, fillWeight: 0.9, vocalWeight: 0.8,
    endLong: true, phraseBars: 4, beam: 24,
  });
  if (!ln.length) return genCounter(ctx, item, out, prevNote);
  const notes = lineToNotes(ctx, item, ln, 'counter', (n, i) => 0.35 + 0.42 * inten + 0.08 * Math.sin((Math.PI * i) / Math.max(1, ln.length - 1)) + (n.onBeat ? 0.03 : -0.02));
  out.push(...notes);
  return notes[notes.length - 1] || prevNote;
}

// 合いの手：歌の息つぎ（1.5 拍以上の休み）に、次に歌い出す音へつながる短いフレーズ
function addLineFills(ctx, item, out) {
  const { an, rand } = ctx;
  const presence = ctx.settings.presence ?? 0.6, motion = ctx.settings.motion ?? 1;
  if (presence < 0.4 || !ctx.hasVocalLine) return false;
  const bars = barsOf(ctx, item);
  if (!bars.length) return false;
  const s0 = bars[0].b0 * 4, s1 = (bars[bars.length - 1].b0 + 4) * 4;
  const gaps = [];
  let a = null;
  for (let st = s0; st <= s1; st++) {
    const v = st < s1 ? ctx.vocalPitch(st) : 0;
    if (v == null) { if (a == null) a = st; }
    else { if (a != null && st - a >= 6 && st < s1) gaps.push([a, st]); a = null; }
  }
  const p = Math.min(0.85, 0.25 + 0.3 * presence + 0.15 * motion);
  let made = 0;
  for (const [ga, gb] of gaps) {
    if (rand() > p) continue;
    const fa = Math.max(ga + 1, gb - (motion >= 2 ? 12 : 8)), fb = gb - 1; // 歌い出しの 16 分ひとつ前で終わる
    if (fb - fa < 3) continue;
    const firstBar = Math.floor(fa / 16), lastBar = Math.floor((fb - 1) / 16);
    const bs = an.bars.filter((b) => !b.pickup && b.n === 4 && Math.floor((b.b0 * 4) / 16) >= firstBar - 0 && b.b0 * 4 <= fb && b.b0 * 4 + 16 > fa);
    if (!bs.length) continue;
    const before = out.filter((n) => n.t < ctx.beatTime(fa / 4)).pop();
    const v = ctx.nextVocalNote(gb);
    const center = before ? before.midi : 76;
    let target = null;
    if (v != null) { target = v; while (target < center - 6) target += 12; while (target > center + 6) target -= 12; }
    const ln = genLine(ctx, {
      kind: 'fill', bars: bs, densityAt: () => [3, 12],
      keep: (n) => n.step >= fa && n.step < fb,
      lo: 64, hi: 86, center: () => center, prev: before ? before.midi : null, target,
      vocalPitch: ctx.vocalPitch, vocalState: ctx.vocalState, fillWeight: 1.5, beam: 20,
    });
    if (ln.length < 2) continue;
    // 歌い出しまでに終わる
    for (const n of ln) if ((n.x + n.len) * 4 > fb) n.len = Math.max(0.25, fb / 4 - n.x);
    // 下でのびている伴奏の音は、合いの手の前で切る
    const tFill = ctx.beatTime(ln[0].x);
    for (const nn of out) if (nn.t < tFill && nn.t + nn.d > tFill) nn.d = Math.max(0.12, tFill - nn.t);
    const vel0 = before ? before.vel : 0.4;
    out.push(...lineToNotes(ctx, item, ln, 'fill', () => clamp(vel0 + 0.08, 0.3, 0.7)));
    made++;
  }
  return made > 0 || gaps.length > 0;
}

// ───────────────────────── リフをまねる
function genRiff(ctx, item, out, prevNote) {
  const { an, rand } = ctx;
  const sec = item.sec, riff = item.riff;
  const bars = sectionBars(an, sec).filter((b) => !b.pickup && b.n === an.meter);
  if (!bars.length || !riff) return prevNote;
  const meds = riff.notes.map((n) => n.midi).sort((a, b) => a - b);
  const med = meds[meds.length >> 1];
  let shift = 0;
  while (med + shift < 72) shift += 12;
  while (med + shift > 84) shift -= 12;
  const reps = Math.floor(bars.length / riff.periodBars);
  const skipFirst = sec.type === 'intro' && reps >= 3;
  const spb = riff.stepsPerBeat;
  let last = prevNote;
  for (let r = 0; r < reps; r++) {
    if (r === 0 && skipFirst) continue;
    const b0 = bars[r * riff.periodBars];
    riff.notes.forEach((nt, i) => {
      const barOff = Math.floor(nt.s / (an.meter * spb));
      const bar = bars[r * riff.periodBars + barOff];
      if (!bar) return;
      const within = nt.s - barOff * an.meter * spb;
      const x = bar.b0 + within / spb;
      // 原曲でその音が鳴っていなければ（聞き取り違いの恐れ）まねない
      if (ctx.heard(pcOf(nt.midi), x) < 0.45) return;
      const m = clamp(nt.midi + shift, LOW, HIGH);
      const t = ctx.beatTime(x), te = ctx.beatTime(x + nt.len / spb);
      const short = nt.len <= 2;
      out.push({ t, d: te - t, midi: m, vel: clamp(0.55 + 0.35 * item.intensity, 0.3, 1), art: short && within % spb === 0 ? 'mrc' : 'sus', legato: !short, shape: 'flat', role: 'riff', sec: item.si });
      last = out[out.length - 1];
    });
    void b0;
  }
  void rand;
  return last;
}

// ───────────────────────── 曲の最後の音
function addEnding(ctx, out) {
  const { an } = ctx;
  const lastBeat = an.beats.length - 1;
  // 最後に音がある拍（エネルギーがある所）を探す
  let endX = lastBeat;
  const medE = [...an.beatEnergy].sort((a, b) => a - b)[an.beatEnergy.length >> 1] || 1;
  while (endX > 0 && an.beatEnergy[endX] < medE * 0.15) endX--;
  // 最後の和音の始まり
  let x = endX;
  const key = (i) => (an.chords[i] ? an.chords[i].pcs.join(',') : 'N');
  while (x > 0 && key(x - 1) === key(endX) && endX - x < 8) x--;
  const t = ctx.beatTime(x);
  const tEnd = Math.min(an.duration, ctx.beatTime(endX + 1) + 1.5);
  // すでに鳴っている音を切って、主音（和音の音）を長く
  for (const n of out) if (n.t + n.d > t) n.d = Math.max(0.1, t - n.t);
  for (let i = out.length - 1; i >= 0; i--) if (out[i].d <= 0.1 && out[i].t >= t - 0.01) out.splice(i, 1);
  const k = ctx.keyAt(x);
  const pcs = ctx.chordPcs(x);
  const prev = out[out.length - 1];
  let m = pcs.includes(k.tonic) ? nearestIn(prev ? prev.midi : 76, [k.tonic], 67, 86) : nearestIn(prev ? prev.midi : 76, pcs, 67, 86);
  if (tEnd - t > 0.8) out.push({ t, d: tEnd - t, midi: m, vel: 0.5, art: 'sneak', legato: false, shape: 'fade', role: 'ending', vib: 1, sec: an.sections.length - 1 });
}

// ───────────────────────── 仕上げ
function finalize(ctx, notes) {
  const { rand } = ctx;
  for (const n of notes) {
    n.midi = clamp(Math.round(n.midi), LOW, HIGH);
    n.vel = clamp(n.vel + (rand() - 0.5) * 0.06, 0.08, 1);
    // ほんの少しの人間らしさ（つながっていない長い音の入りだけ）
    if (!n.legato && n.d > 0.4) { const j = (rand() - 0.5) * 0.012; n.t += j; n.d -= j; }
    n.t = Math.max(0, n.t);
  }
  notes.sort((a, b) => a.t - b.t);
  // 1本の旋律：重なりを整える
  for (let i = 0; i + 1 < notes.length; i++) {
    const a = notes[i], b = notes[i + 1];
    if (a.t + a.d > b.t) a.d = Math.max(0.04, b.t - a.t);
    // 前の音とすき間なく続き、高さが違えば、なめらかにつなぐ
    if (b.t - (a.t + a.d) > 0.08) b.legato = false;
  }
  for (const n of notes) {
    n.t = Math.round(n.t * 10000) / 10000;
    n.d = Math.floor(n.d * 10000) / 10000;
  }
  return notes.filter((n) => n.d > 0.04);
}

export function compose(an, settings = {}) {
  const ctx = makeCtx(an, settings);
  const plan = planRoles(an, settings);
  const notes = [];
  let prev = null;
  plan.forEach((item, idx) => {
    const nextVocal = idx + 1 < plan.length && plan[idx + 1].sec.vocal;
    const start = notes.length;
    switch (item.role) {
      case 'pad':
        prev = genPad(ctx, item, notes, prev);
        // 合いの手：歌のメロディが取れていれば「次の歌い出しへつながる」学んだ線、取れなければ前の作り方
        if (item.sec.vocal && !(hasLineModel() && an.meter === 4 && addLineFills(ctx, item, notes))) addFills(ctx, item, notes);
        break;
      case 'counter':
        prev = hasLineModel() && an.meter === 4 ? genCounterLine(ctx, item, notes, prev) : genCounter(ctx, item, notes, prev);
        break;
      case 'solo':
        prev = hasLineModel() && an.meter === 4
          ? genSoloLine(ctx, item, notes, prev, nextVocal)
          : genSoloV3(ctx, item, notes, prev, nextVocal, sectionBars(an, item.sec).filter((b) => !b.pickup));
        break;
      case 'arp':
        prev = genArp(ctx, item, notes, prev);
        break;
      case 'rhythm':
        prev = genRhythm(ctx, item, notes, prev);
        break;
      case 'riff':
        prev = genRiff(ctx, item, notes, prev);
        break;
      default:
        prev = null;
    }
    item.noteCount = notes.length - start;
  });
  if (settings.ending !== false) addEnding(ctx, notes);
  const out = finalize(ctx, notes);
  return { notes: out, plan: plan.map((p) => ({ si: p.si, role: p.role, auto: p.auto, intensity: p.intensity, type: p.sec.type, n: p.sec.n, noteCount: p.noteCount, hasRiff: !!p.riff })) };
}
