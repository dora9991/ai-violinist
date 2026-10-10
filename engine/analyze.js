// 曲の解析：拍・小節・調・コード・歌の場所・曲の区切り・リフ。
// 入力は 22050Hz の左右の波形（Float32Array）。ブラウザ（Worker）でも Node（テスト）でも動く。
import { FFT, hann } from './fft.js';

export const PC_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const PC_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const QUALITIES = {
  maj: { iv: [0, 4, 7], w: [1, 0.9, 0.8], suffix: '' },
  min: { iv: [0, 3, 7], w: [1, 0.9, 0.8], suffix: 'm' },
  dom7: { iv: [0, 4, 7, 10], w: [1, 0.9, 0.75, 0.7], suffix: '7' },
  maj7: { iv: [0, 4, 7, 11], w: [1, 0.9, 0.75, 0.7], suffix: 'M7' },
  min7: { iv: [0, 3, 7, 10], w: [1, 0.9, 0.75, 0.7], suffix: 'm7' },
};
const QNAMES = Object.keys(QUALITIES);
const ONSET_LAG = 0.031;
let RIFF_FROM = 0.5, RIFF_TO = 0.5;
export function __riffWin(a, b) { RIFF_FROM = a; RIFF_TO = b; }
export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

// Krumhansl–Kessler の調のプロファイル
const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const flatKeys = new Set(['5maj', '10maj', '3maj', '8maj', '1maj', '6maj', '2min', '7min', '0min', '5min', '10min', '3min']);
export function pcName(pc, key) {
  const useFlat = key && flatKeys.has(`${key.tonic}${key.mode}`);
  return (useFlat ? PC_FLAT : PC_SHARP)[((pc % 12) + 12) % 12];
}
export function keyName(key) {
  return `${pcName(key.tonic, key)}${key.mode === 'min' ? 'm' : ''}`;
}
export function keyNameJa(key) {
  return `${pcName(key.tonic, key)} ${key.mode === 'min' ? 'マイナー' : 'メジャー'}`;
}
// 日本語の調名（イ長調・嬰ヘ短調・変ロ長調 など）
const TRAD = { C: 'ハ', D: 'ニ', E: 'ホ', F: 'ヘ', G: 'ト', A: 'イ', B: 'ロ' };
export function keyNameTrad(key) {
  const n = pcName(key.tonic, key);
  const head = n.length > 1 ? (n[1] === '#' ? '嬰' : '変') : '';
  return `${head}${TRAD[n[0]]}${key.mode === 'min' ? '短調' : '長調'}`;
}

function corr(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / (Math.sqrt(da * db) + 1e-12);
}
function norm2(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) + 1e-12;
  return v.map((x) => x / s);
}
function median(arr) {
  if (!arr.length) return 0;
  const a = Array.from(arr).sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = Array.from(arr).sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))];
}

// ───────────────────────── 1. 短時間スペクトル（細かい：拍・旋律・歌の手がかり）
function stageA(L, R, sr, progress) {
  const N = 2048, hop = 256, half = N / 2;
  const fft = new FFT(N), win = hann(N);
  const n = L.length;
  const F = Math.ceil(n / hop);
  const NB = 40;
  // メル帯域
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const imel = (m) => 700 * (10 ** (m / 2595) - 1);
  const mLo = mel(30), mHi = mel(10000);
  const edges = [];
  for (let b = 0; b < NB + 2; b++) edges.push(imel(mLo + ((mHi - mLo) * b) / (NB + 1)));
  const bands = [];
  for (let b = 0; b < NB; b++) {
    const lo = edges[b], c = edges[b + 1], hi = edges[b + 2];
    const list = [];
    for (let k = 1; k < half; k++) {
      const f = (k * sr) / N;
      if (f <= lo || f >= hi) continue;
      const w = f < c ? (f - lo) / (c - lo) : (hi - f) / (hi - c);
      list.push(k, w);
    }
    if (!list.length) list.push(Math.max(1, Math.round((c * N) / sr)), 1);
    bands.push(list);
  }
  const lowBands = [], bodyBands = [];
  for (let b = 0; b < NB; b++) {
    if (edges[b + 1] < 160) lowBands.push(b);
    if (edges[b] > 200 && edges[b + 1] < 2500) bodyBands.push(b);
  }
  const logmel = new Float32Array(F * NB);
  const rms = new Float32Array(F);
  const vprox = new Float32Array(F); // 真ん中・声の帯域の強さ
  const vfrac = new Float32Array(F);
  const sideFrac = new Float32Array(F);
  const melPitch = new Float32Array(F); // 一番目立つ音の高さ（MIDI・小数）
  const melSal = new Float32Array(F);
  const melRel = new Float32Array(F);
  const TOPK = 3;
  const melTopP = new Float32Array(F * TOPK), melTopS = new Float32Array(F * TOPK);
  const topBin = new Int32Array(TOPK);
  const tuneHist = new Float64Array(100);
  const re = new Float64Array(N), im = new Float64Array(N);
  const M = new Float64Array(half + 1), S = new Float64Array(half + 1);
  const kV0 = Math.round((250 * N) / sr), kV1 = Math.round((4000 * N) / sr);
  const k60 = Math.round((60 * N) / sr);
  const kP0 = Math.max(2, Math.round((80 * N) / sr)), kP1 = Math.round((5000 * N) / sr);
  const SAL_LO = 4500, SAL_BINS = 520; // MIDI 45.0〜96.9 を 10 セント刻み
  const sal = new Float64Array(SAL_BINS);
  const peaksF = new Float64Array(64), peaksA = new Float64Array(64);
  for (let t = 0; t < F; t++) {
    const start = t * hop - half;
    for (let i = 0; i < N; i++) {
      const j = start + i;
      if (j >= 0 && j < n) { re[i] = L[j] * win[i]; im[i] = R[j] * win[i]; }
      else { re[i] = 0; im[i] = 0; }
    }
    fft.transform(re, im);
    let tot = 0, totC = 0, vE = 0, sE = 0, maxM = 0;
    for (let k = 0; k <= half; k++) {
      const k2 = k === 0 ? 0 : N - k;
      const a = re[k], b = im[k], c = re[k2], d = im[k2];
      const lr = (a + c) / 2, li = (b - d) / 2;
      const rr = (b + d) / 2, ri = (c - a) / 2;
      const mr = (lr + rr) / 2, mi = (li + ri) / 2;
      const sr_ = (lr - rr) / 2, si = (li - ri) / 2;
      const m = Math.sqrt(mr * mr + mi * mi), s = Math.sqrt(sr_ * sr_ + si * si);
      M[k] = m; S[k] = s;
      if (k >= k60) {
        const p = m * m;
        tot += p;
        sE += s * s;
        if (k >= kV0 && k <= kV1) {
          let cen = 1 - s / (m + 1e-9);
          if (cen < 0) cen = 0;
          const cw = cen * cen * cen * cen;
          vE += p * cw;
          totC += p;
        }
      }
      if (k >= kP0 && k <= kP1 && m > maxM) maxM = m;
    }
    rms[t] = Math.sqrt(tot / N);
    vprox[t] = vE;
    vfrac[t] = totC > 0 ? vE / (tot + 1e-12) : 0;
    sideFrac[t] = sE / (tot + sE + 1e-12);
    for (let b = 0; b < NB; b++) {
      const list = bands[b];
      let e = 0;
      for (let q = 0; q < list.length; q += 2) { const m = M[list[q]]; e += m * m * list[q + 1]; }
      logmel[t * NB + b] = Math.log(1e-9 + e);
    }
    // 山（ピーク）を拾う
    let np = 0;
    const thr = maxM * 0.01; // -40dB
    if (maxM > 1e-6) {
      for (let k = kP0; k <= kP1; k++) {
        const m = M[k];
        if (m > thr && m > M[k - 1] && m >= M[k + 1]) {
          const al = Math.log(M[k - 1] + 1e-12), be = Math.log(m + 1e-12), ga = Math.log(M[k + 1] + 1e-12);
          const den = al - 2 * be + ga;
          const p = den !== 0 ? (0.5 * (al - ga)) / den : 0;
          const f = ((k + p) * sr) / N;
          const amp = Math.exp(be - 0.25 * (al - ga) * p);
          if (np < 64) { peaksF[np] = f; peaksA[np] = amp; np++; }
          else {
            // 一番小さいものと入れ替え
            let mi = 0;
            for (let q = 1; q < 64; q++) if (peaksA[q] < peaksA[mi]) mi = q;
            if (amp > peaksA[mi]) { peaksF[mi] = f; peaksA[mi] = amp; }
          }
        }
      }
    }
    // 調律（440Hz からのずれ）の度数分布
    for (let q = 0; q < np; q++) {
      const f = peaksF[q];
      if (f < 150 || f > 2000) continue;
      const cents = 1200 * Math.log2(f / 440);
      let dev = cents - 100 * Math.round(cents / 100);
      const bin = Math.min(99, Math.max(0, Math.floor(dev + 50)));
      tuneHist[bin] += peaksA[q];
    }
    // 旋律の目立ち度（倍音を足し合わせる）
    sal.fill(0);
    let ampSum = 0;
    for (let q = 0; q < np; q++) {
      const f = peaksF[q], a = Math.pow(peaksA[q], 0.8);
      ampSum += a;
      for (let h = 1; h <= 8; h++) {
        const f0 = f / h;
        if (f0 < 108) break;
        const c = 100 * (69 + 12 * Math.log2(f0 / 440));
        const bi = (c - SAL_LO) / 10;
        const b0 = Math.round(bi);
        if (b0 < 1 || b0 >= SAL_BINS - 1) continue;
        const w = a * Math.pow(0.8, h - 1);
        sal[b0] += w;
        sal[b0 - 1] += w * 0.5;
        sal[b0 + 1] += w * 0.5;
      }
    }
    let bb = 0;
    for (let b = 1; b < SAL_BINS; b++) if (sal[b] > sal[bb]) bb = b;
    melPitch[t] = (SAL_LO + bb * 10) / 100;
    melSal[t] = sal[bb];
    melRel[t] = ampSum > 0 ? sal[bb] / ampSum : 0;
    // 目立つ高さの候補を 3 つ（半音以上はなれた山）。山を 1 回でなめて、大きい順に入れる
    topBin.fill(-1);
    for (let b = 1; b < SAL_BINS - 1; b++) {
      const v = sal[b];
      if (v <= 0 || v < sal[b - 1] || v < sal[b + 1]) continue;
      // 近い山（半音未満）がすでにあれば、大きい方だけ
      let near = -1;
      for (let q = 0; q < TOPK; q++) if (topBin[q] >= 0 && Math.abs(topBin[q] - b) < 6) { near = q; break; }
      if (near >= 0) { if (v > sal[topBin[near]]) topBin[near] = b; else continue; }
      else {
        let mi = -1;
        for (let q = 0; q < TOPK; q++) { if (topBin[q] < 0) { mi = q; break; } if (mi < 0 || sal[topBin[q]] < sal[topBin[mi]]) mi = q; }
        if (topBin[mi] < 0 || v > sal[topBin[mi]]) topBin[mi] = b;
      }
    }
    // 大きい順に並べる
    const ord = Array.from(topBin).sort((x, y) => (y < 0 ? -1 : x < 0 ? 1 : sal[y] - sal[x]));
    for (let k = 0; k < TOPK; k++) {
      const mb = ord[k];
      melTopP[t * TOPK + k] = mb < 0 ? 0 : (SAL_LO + mb * 10) / 100;
      melTopS[t * TOPK + k] = mb < 0 || ampSum <= 0 ? 0 : sal[mb] / ampSum;
    }
    if ((t & 1023) === 0) progress && progress('spectrum', t / F);
  }
  // 調律：円周平均
  let cx = 0, cy = 0;
  for (let b = 0; b < 100; b++) {
    const ang = ((b - 50 + 0.5) / 100) * 2 * Math.PI;
    cx += Math.cos(ang) * tuneHist[b];
    cy += Math.sin(ang) * tuneHist[b];
  }
  const tuning = (Math.atan2(cy, cx) / (2 * Math.PI)) * 100;
  return { F, hop, fps: sr / hop, NB, logmel, lowBands, bodyBands, rms, vprox, vfrac, sideFrac, melPitch, melSal, melRel, melTopP, melTopS, TOPK, tuning };
}

// ───────────────────────── 2. 長い窓のスペクトル（コード・調・ベース）
function stageB(L, R, sr, tuning, progress) {
  const N = 8192, hop = 2048, half = N / 2;
  const fft = new FFT(N), win = hann(N);
  const n = L.length;
  const F = Math.ceil(n / hop);
  const M0 = 24, NM = 84; // MIDI 24〜107
  const spec = new Float32Array(F * NM);
  // 各ビンがどの半音に入るか
  const map = [];
  for (let k = 1; k < half; k++) {
    const f = (k * sr) / N;
    const m = 69 + 12 * Math.log2(f / 440) - tuning / 100;
    const m0 = Math.round(m);
    if (m0 < M0 || m0 >= M0 + NM) continue;
    const w = 1 - 1.4 * Math.abs(m - m0);
    if (w <= 0) continue;
    map.push(k, m0 - M0, w);
  }
  const re = new Float64Array(N), im = new Float64Array(N), Mg = new Float64Array(half + 1);
  for (let t = 0; t < F; t++) {
    const start = t * hop - half;
    for (let i = 0; i < N; i++) {
      const j = start + i;
      if (j >= 0 && j < n) { re[i] = 0.5 * (L[j] + R[j]) * win[i]; im[i] = 0; }
      else { re[i] = 0; im[i] = 0; }
    }
    fft.transform(re, im);
    for (let k = 0; k <= half; k++) Mg[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    const off = t * NM;
    for (let q = 0; q < map.length; q += 3) {
      const k = map[q];
      const m = Mg[k];
      // 山だけを数える（打楽器の雑音を減らす）
      if (m >= Mg[k - 1] && m >= Mg[k + 1]) spec[off + map[q + 1]] += m * map[q + 2];
    }
    if ((t & 127) === 0) progress && progress('pitch', t / F);
  }
  return { F, hop, fps: sr / hop, M0, NM, spec };
}

// ───────────────────────── 3. 拍
function onsetEnvelope(A) {
  const { F, NB, logmel, lowBands, bodyBands } = A;
  const raw = new Float32Array(F), low = new Float32Array(F), body = new Float32Array(F);
  for (let t = 1; t < F; t++) {
    let s = 0, sl = 0, sb = 0;
    for (const b of bodyBands) {
      const d = logmel[t * NB + b] - logmel[(t - 1) * NB + b];
      if (d > 0) sb += d;
    }
    body[t] = sb / Math.max(1, bodyBands.length);
    for (let b = 0; b < NB; b++) {
      const d = logmel[t * NB + b] - logmel[(t - 1) * NB + b];
      if (d > 0) s += d;
    }
    for (const b of lowBands) {
      const d = logmel[t * NB + b] - logmel[(t - 1) * NB + b];
      if (d > 0) sl += d;
    }
    raw[t] = s / NB;
    low[t] = sl / Math.max(1, lowBands.length);
  }
  const hp = (x) => {
    const W = 16, out = new Float32Array(F);
    let acc = 0;
    const pre = new Float64Array(F + 1);
    for (let t = 0; t < F; t++) { acc += x[t]; pre[t + 1] = acc; }
    let s2 = 0;
    for (let t = 0; t < F; t++) {
      const a = Math.max(0, t - W), b = Math.min(F, t + W + 1);
      const mean = (pre[b] - pre[a]) / (b - a);
      out[t] = Math.max(0, x[t] - mean);
      s2 += out[t] * out[t];
    }
    const sd = Math.sqrt(s2 / F) + 1e-9;
    for (let t = 0; t < F; t++) out[t] /= sd;
    return out;
  };
  return { onset: hp(raw), lowOnset: hp(low), bodyOnset: hp(body) };
}

function estimateTempo(onset, fps, prefer = 120) {
  const F = onset.length;
  const maxLag = Math.ceil((60 * fps) / 45) * 2 + 4;
  const acf = new Float64Array(maxLag + 1);
  for (let l = 1; l <= maxLag; l++) {
    let s = 0;
    for (let t = 0; t + l < F; t++) s += onset[t] * onset[t + l];
    acf[l] = s / (F - l);
  }
  const at = (lag) => {
    const i = Math.floor(lag), f = lag - i;
    if (i + 1 > maxLag) return 0;
    return acf[i] * (1 - f) + acf[i + 1] * f;
  };
  let best = 0, bestBpm = prefer;
  const scores = [];
  for (let bpm = 55; bpm <= 210; bpm += 0.25) {
    const lag = (60 * fps) / bpm;
    let s = at(lag) + 0.5 * at(2 * lag) + 0.25 * at(lag / 2) + 0.25 * at(4 * lag / 1);
    const w = Math.exp(-0.5 * (Math.log2(bpm / prefer) / 0.9) ** 2);
    s *= w;
    scores.push([bpm, s]);
    if (s > best) { best = s; bestBpm = bpm; }
  }
  return bestBpm;
}

function trackBeats(onset, fps, bpm) {
  const F = onset.length;
  const P = (60 * fps) / bpm;
  const alpha = 100;
  const cum = new Float64Array(F), back = new Int32Array(F).fill(-1);
  const lo = Math.round(2 * P), hi = Math.max(1, Math.round(P / 2));
  const pen = new Float64Array(lo + 1);
  for (let d = hi; d <= lo; d++) pen[d] = alpha * Math.log(d / P) ** 2;
  for (let t = 0; t < F; t++) {
    let best = -Infinity, bi = -1;
    for (let d = hi; d <= lo; d++) {
      const tau = t - d;
      if (tau < 0) break;
      const v = cum[tau] - pen[d];
      if (v > best) { best = v; bi = tau; }
    }
    if (bi >= 0 && best > 0) { cum[t] = onset[t] + best; back[t] = bi; }
    else cum[t] = onset[t];
  }
  // 終わりの拍
  let end = F - 1, bv = -Infinity;
  for (let t = Math.max(0, F - Math.ceil(P)); t < F; t++) if (cum[t] > bv) { bv = cum[t]; end = t; }
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) { beats.push(t / fps); if (back[t] < 0) break; }
  beats.reverse();
  return beats;
}

function sampleOnset(onset, fps, time) {
  const x = time * fps;
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= onset.length) return 0;
  const f = x - i;
  return onset[i] * (1 - f) + onset[i + 1] * f;
}
function peakNear(onset, fps, time, rad = 0.035) {
  let m = 0;
  const a = Math.max(0, Math.floor((time - rad) * fps)), b = Math.min(onset.length - 1, Math.ceil((time + rad) * fps));
  for (let i = a; i <= b; i++) if (onset[i] > m) m = onset[i];
  return m;
}

// 一定のテンポ（打ち込みの曲）なら、拍を等間隔の格子にそろえる
function smoothOnset(onset, fps) {
  const sig = 0.018 * fps, R = Math.ceil(sig * 3);
  const w = [];
  for (let d = -R; d <= R; d++) w.push(Math.exp(-0.5 * (d / sig) ** 2));
  const out = new Float32Array(onset.length);
  for (let t = 0; t < onset.length; t++) {
    let s = 0;
    for (let d = -R; d <= R; d++) { const j = t + d; if (j >= 0 && j < onset.length) s += onset[j] * w[d + R]; }
    out[t] = s;
  }
  return out;
}
function gridScore(sm, fps, a, T, t0, t1) {
  let s = 0, n = 0;
  const k0 = Math.ceil((t0 - a) / T), k1 = Math.floor((t1 - a) / T);
  for (let k = k0; k <= k1; k++) { s += sampleOnset(sm, fps, a + k * T); n++; }
  return n ? s / n : 0;
}
function refineGrid(beats, onset, fps, duration) {
  const K = beats.length;
  if (K < 16) return { beats, steady: false };
  const sm = smoothOnset(onset, fps);
  const t0 = beats[0], t1 = beats[K - 1];
  let dp = 0;
  for (const b of beats) dp += peakNear(sm, fps, b, 0.03);
  dp /= K;
  const ivs = [];
  for (let i = 1; i < K; i++) ivs.push(beats[i] - beats[i - 1]);
  const T0 = median(ivs);
  const search = (Tlo, Thi, Tstep, aStep) => {
    let best = { s: -1 };
    for (let T = Tlo; T <= Thi; T += Tstep) {
      for (let a = 0; a < T; a += aStep) {
        const sc = gridScore(sm, fps, a, T, t0, t1);
        if (sc > best.s) best = { s: sc, T, a };
      }
    }
    return best;
  };
  let best = search(T0 * 0.985, T0 * 1.015, T0 * 0.0003, 0.006);
  best = search(best.T * 0.9996, best.T * 1.0004, best.T * 0.00002, 0.001);
  // ちょうどの BPM（整数・0.5 刻み）に近ければ寄せる
  const bpm = 60 / best.T;
  for (const snap of [Math.round(bpm), Math.round(bpm * 2) / 2]) {
    if (Math.abs(snap - bpm) / bpm < 0.0015) {
      const T = 60 / snap;
      let bs = { s: -1 };
      for (let a = 0; a < T; a += 0.001) { const sc = gridScore(sm, fps, a, T, t0, t1); if (sc > bs.s) bs = { s: sc, T, a }; }
      if (bs.s >= best.s * 0.985) { best = bs; best.snapped = true; break; }
    }
  }
  // 区間ごとに一番合う位相を出し、全体の位相と（半拍ずれも含めて）そろっていれば「一定」
  const T = best.T, Wlen = Math.max(16 * T, 20);
  let agree = 0, wins = 0;
  for (let w0 = t0; w0 + Wlen * 0.5 <= t1; w0 += Wlen) {
    const w1 = Math.min(t1, w0 + Wlen);
    let bs = -1, ba = 0;
    for (let a = 0; a < T; a += 0.004) { const sc = gridScore(sm, fps, a, T, w0, w1); if (sc > bs) { bs = sc; ba = a; } }
    let d = ((ba - best.a) % T + T) % T;
    if (d > T / 2) d -= T;
    wins++;
    if (Math.abs(d) < 0.035 || Math.abs(Math.abs(d) - T / 2) < 0.035) agree++;
  }
  const ratio = wins ? agree / wins : 0;
  if (!(ratio >= 0.75 || (best.snapped && ratio >= 0.55))) return { beats, steady: false, ratio };
  const out = [];
  const k0 = Math.ceil(-best.a / best.T);
  for (let k = k0; ; k++) {
    const t = best.a + k * best.T;
    if (t > duration + 1e-6) break;
    if (t >= -1e-6) out.push(Math.max(0, t));
  }
  return { beats: out, steady: true, T: best.T, ratio, snapped: !!best.snapped };
}

// 表拍か裏拍か：低音の立ち上がり（キック・ベース）と、低音の和音の変わり目が多い方を拍とする
function chromaWindow(B, t0, t1, lo, hi) {
  const c = new Float64Array(12);
  const f0 = Math.max(0, Math.floor(t0 * B.fps)), f1 = Math.min(B.F, Math.ceil(t1 * B.fps));
  for (let f = f0; f < f1; f++) for (let m = lo; m <= hi; m++) {
    const x = B.spec[f * B.NM + (m - B.M0)];
    if (x > 0) c[m % 12] += Math.sqrt(x);
  }
  const mean = c.reduce((a, b) => a + b, 0) / 12;
  return norm2(Array.from(c, (x) => x - mean));
}
function phaseScore(times, B, lowOnset, onset, fps) {
  let lo = 0, on = 0, nov = 0, n = 0;
  for (let i = 1; i < times.length - 1; i++) {
    const t = times[i], T = times[i + 1] - t, Tp = t - times[i - 1];
    lo += peakNear(lowOnset, fps, t, 0.03);
    on += peakNear(onset, fps, t, 0.03);
    const a = chromaWindow(B, t - Tp, t, 28, 55), b = chromaWindow(B, t, t + T, 28, 55);
    let d = 0;
    for (let k = 0; k < 12; k++) d += a[k] * b[k];
    nov += 1 - d;
    n++;
  }
  return { lo: lo / n, on: on / n, nov: nov / n };
}
function chooseBeatPhase(beats, B, lowOnset, onset, fps, duration) {
  if (beats.length < 8) return { beats, shifted: false };
  const mids = [];
  for (let i = 0; i + 1 < beats.length; i++) mids.push((beats[i] + beats[i + 1]) / 2);
  const p = mids.length > 1 ? mids[1] - mids[0] : 0.5;
  if (mids.length && mids[mids.length - 1] + p <= duration) mids.push(mids[mids.length - 1] + p);
  if (mids.length && mids[0] - p >= 0) mids.unshift(mids[0] - p);
  const sa = phaseScore(beats, B, lowOnset, onset, fps), sb = phaseScore(mids, B, lowOnset, onset, fps);
  const score = (x, y) => x.lo / (x.lo + y.lo + 1e-9) + 0.3 * x.on / (x.on + y.on + 1e-9) + 1.0 * x.nov / (x.nov + y.nov + 1e-9);
  const A = score(sa, sb), Bs = score(sb, sa);
  return Bs > A * 1.06 ? { beats: mids, shifted: true } : { beats, shifted: false };
}

export function halfShift(beats, duration) {
  const out = [];
  for (let i = 0; i + 1 < beats.length; i++) out.push((beats[i] + beats[i + 1]) / 2);
  const p = beats.length > 1 ? beats[1] - beats[0] : 0.5;
  if (out.length && out[0] - p >= 0) out.unshift(out[0] - p);
  return out.filter((b) => b < duration);
}

function extendBeats(beats, duration) {
  const out = beats.slice();
  if (out.length < 2) return out;
  let p = out[1] - out[0];
  while (out[0] - p > 0.02) out.unshift(out[0] - p);
  p = out[out.length - 1] - out[out.length - 2];
  while (out[out.length - 1] + p < duration - 0.02) out.push(out[out.length - 1] + p);
  return out;
}

// ───────────────────────── 4. 拍ごとのクロマ
function beatChroma(B, beats, duration) {
  const { F, fps, M0, NM, spec } = B;
  // 全体で正規化
  const vals = [];
  for (let i = 0; i < spec.length; i += 7) if (spec[i] > 0) vals.push(spec[i]);
  const ref = percentile(vals, 0.99) || 1;
  const nb = beats.length;
  const treble = [], bass = [], energy = [];
  for (let i = 0; i < nb; i++) {
    const t0 = beats[i], t1 = i + 1 < nb ? beats[i + 1] : duration;
    let f0 = Math.floor(t0 * fps + 0.5), f1 = Math.max(f0 + 1, Math.floor(t1 * fps + 0.5));
    f1 = Math.min(F, f1);
    const tc = new Float64Array(12), bc = new Float64Array(12);
    let en = 0;
    const cnt = Math.max(1, f1 - f0);
    for (let f = f0; f < f1; f++) {
      const off = f * NM;
      for (let m = 0; m < NM; m++) {
        const x = Math.log(1 + (5 * spec[off + m]) / ref);
        if (x <= 0) continue;
        const midi = M0 + m;
        const pc = midi % 12;
        en += x;
        if (midi >= 48 && midi <= 96) tc[pc] += x * (midi > 84 ? 0.6 : 1);
        if (midi >= 28 && midi <= 52) bc[pc] += x * (midi <= 47 ? 1 : 0.5);
      }
    }
    for (let p = 0; p < 12; p++) { tc[p] /= cnt; bc[p] /= cnt; }
    treble.push(Array.from(tc));
    bass.push(Array.from(bc));
    energy.push(en / cnt);
  }
  return { treble, bass, energy };
}

// ───────────────────────── 5. 小節の頭
function findDownbeat(chroma, lowOnsetAtBeat, onsetAtBeat) {
  const nb = chroma.treble.length;
  const nov = new Float64Array(nb);
  for (let i = 1; i < nb; i++) {
    const a = norm2(chroma.treble[i].concat(chroma.bass[i])), b = norm2(chroma.treble[i - 1].concat(chroma.bass[i - 1]));
    let d = 0;
    for (let k = 0; k < 24; k++) d += a[k] * b[k];
    nov[i] = 1 - d;
  }
  const mean = (x) => x.reduce((s, v) => s + v, 0) / Math.max(1, x.length);
  const mn = mean(Array.from(nov)) || 1, ml = mean(lowOnsetAtBeat) || 1, mo = mean(onsetAtBeat) || 1;
  const contrast = (period) => {
    const s = new Float64Array(period), c = new Float64Array(period);
    for (let i = 1; i < nb; i++) {
      const v = nov[i] / mn + 0.6 * (lowOnsetAtBeat[i] / ml) + 0.2 * (onsetAtBeat[i] / mo);
      s[i % period] += v; c[i % period]++;
    }
    for (let p = 0; p < period; p++) s[p] /= Math.max(1, c[p]);
    let bp = 0;
    for (let p = 1; p < period; p++) if (s[p] > s[bp]) bp = p;
    const avg = mean(Array.from(s));
    return { phase: bp, contrast: (s[bp] - avg) / (avg + 1e-9), scores: Array.from(s) };
  };
  const c4 = contrast(4), c3 = contrast(3);
  // 3拍子はよほどはっきりしているときだけ（ほとんどの曲は4拍子。違えば画面のボタンで直せる）
  const meter = c3.contrast > c4.contrast * 2.5 && c3.contrast > 0.45 ? 3 : 4;
  return { meter, phase: meter === 3 ? c3.phase : c4.phase, c4, c3, novelty: nov };
}

// ───────────────────────── 6. 調（小節ごと・転調あり）
function detectKeys(barChroma) {
  const nb = barChroma.length;
  const profiles = [];
  for (let t = 0; t < 12; t++) {
    profiles.push({ tonic: t, mode: 'maj', p: KK_MAJ.map((_, i) => KK_MAJ[(i - t + 12) % 12]) });
    profiles.push({ tonic: t, mode: 'min', p: KK_MIN.map((_, i) => KK_MIN[(i - t + 12) % 12]) });
  }
  // 全体
  const total = new Float64Array(12);
  for (const c of barChroma) for (let p = 0; p < 12; p++) total[p] += c[p];
  let gi = 0, gv = -2;
  profiles.forEach((pr, i) => { const r = corr(total, pr.p); if (r > gv) { gv = r; gi = i; } });
  // 窓をずらして
  const em = [];
  for (let b = 0; b < nb; b++) {
    const acc = new Float64Array(12);
    for (let d = -8; d <= 8; d++) {
      const j = b + d;
      if (j < 0 || j >= nb) continue;
      const w = Math.exp(-0.5 * (d / 5) ** 2);
      for (let p = 0; p < 12; p++) acc[p] += barChroma[j][p] * w;
    }
    em.push(profiles.map((pr) => corr(acc, pr.p)));
  }
  // ビタビ
  const K = profiles.length, beta = 10, stay = Math.log(0.97), move = Math.log(0.03 / (K - 1));
  let prev = profiles.map((_, k) => beta * em[0][k] + (k === gi ? 1 : 0));
  const back = [];
  for (let b = 1; b < nb; b++) {
    const cur = new Array(K), bk = new Array(K);
    let pmax = -Infinity, parg = 0;
    for (let k = 0; k < K; k++) if (prev[k] > pmax) { pmax = prev[k]; parg = k; }
    for (let k = 0; k < K; k++) {
      const vs = prev[k] + stay, vm = pmax + move;
      if (vs >= vm) { cur[k] = vs; bk[k] = k; } else { cur[k] = vm; bk[k] = parg; }
      cur[k] += beta * em[b][k];
    }
    back.push(bk);
    prev = cur;
  }
  let k = 0;
  for (let q = 1; q < K; q++) if (prev[q] > prev[k]) k = q;
  const path = new Array(nb);
  path[nb - 1] = k;
  for (let b = nb - 1; b > 0; b--) { k = back[b - 1][k]; path[b - 1] = k; }
  // 短すぎる転調はならす
  const segs = [];
  for (let b = 0; b < nb; b++) {
    if (!segs.length || segs[segs.length - 1].k !== path[b]) segs.push({ k: path[b], a: b, e: b + 1 });
    else segs[segs.length - 1].e = b + 1;
  }
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      if (segs.length > 1 && segs[i].e - segs[i].a < 6) {
        const tgt = i > 0 ? i - 1 : i + 1;
        segs[tgt].a = Math.min(segs[tgt].a, segs[i].a);
        segs[tgt].e = Math.max(segs[tgt].e, segs[i].e);
        segs.splice(i, 1);
        changed = true;
        break;
      }
    }
    for (let i = 1; i < segs.length; i++) if (segs[i].k === segs[i - 1].k) { segs[i - 1].e = segs[i].e; segs.splice(i, 1); changed = true; break; }
  }
  // 曲全体の調を基準にする。転調と認めるのは「長く続き、全体の調よりはっきり合う」ときだけ。
  // 平行調（イ短調⇔ハ長調）は同じ音階なので全体の調にまとめる。
  // 属調・下属調（音階の違いが 1 音だけ）は、コードの動きで引っぱられた読み違いが多いので、よほど長く強いときだけ。
  const scaleSet = (k) => new Set(scaleOf(profiles[k]));
  const gSet = scaleSet(gi);
  const diffPcs = (k) => { const s2 = scaleSet(k); let d = 0; for (const p of s2) if (!gSet.has(p)) d++; return d; };
  const accepted = segs.map((sg) => {
    if (sg.k === gi) return { ...sg, k: gi };
    const d = diffPcs(sg.k);
    if (d === 0) return { ...sg, k: gi };
    let margin = 0;
    for (let b = sg.a; b < sg.e; b++) margin += em[b][sg.k] - em[b][gi];
    margin /= sg.e - sg.a;
    const len = sg.e - sg.a;
    const ok = (d >= 2 && len >= 12 && margin >= 0.08) || (d === 1 && len >= 24 && margin >= 0.15);
    return { ...sg, k: ok ? sg.k : gi, margin, d };
  });
  const perBar = new Array(nb);
  for (const sg of accepted) for (let b = sg.a; b < sg.e; b++) perBar[b] = { tonic: profiles[sg.k].tonic, mode: profiles[sg.k].mode };
  return { global: { tonic: profiles[gi].tonic, mode: profiles[gi].mode, conf: gv }, perBar };
}

export function scaleOf(key) {
  return (key.mode === 'min' ? MINOR_SCALE : MAJOR_SCALE).map((iv) => (key.tonic + iv) % 12);
}
function diatonicChords(key) {
  // その調でよく出るコード（根音・種類）
  const t = key.tonic, set = new Set();
  const add = (iv, q) => set.add(`${(t + iv) % 12}:${q}`);
  if (key.mode === 'maj') {
    [[0, 'maj'], [2, 'min'], [4, 'min'], [5, 'maj'], [7, 'maj'], [9, 'min'], [0, 'maj7'], [2, 'min7'], [4, 'min7'], [5, 'maj7'], [7, 'dom7'], [9, 'min7'], [4, 'maj'], [4, 'dom7'], [2, 'maj'], [10, 'maj'], [5, 'min']].forEach(([i, q]) => add(i, q));
  } else {
    [[0, 'min'], [3, 'maj'], [5, 'min'], [7, 'min'], [8, 'maj'], [10, 'maj'], [7, 'maj'], [7, 'dom7'], [0, 'min7'], [5, 'min7'], [3, 'maj7'], [8, 'maj7'], [10, 'dom7'], [2, 'min'], [5, 'maj']].forEach(([i, q]) => add(i, q));
  }
  return set;
}

// ───────────────────────── 7. コード（拍ごと・ビタビ）
function detectChords(chroma, beats, beatInBar, keyOfBeat, meter) {
  const nb = beats.length;
  const states = [];
  for (let r = 0; r < 12; r++) for (const q of QNAMES) {
    const def = QUALITIES[q];
    const tpl = new Float64Array(12);
    def.iv.forEach((iv, i) => (tpl[(r + iv) % 12] = def.w[i]));
    states.push({ root: r, q, tpl: norm2(Array.from(tpl)), pcs: def.iv.map((iv) => (r + iv) % 12) });
  }
  states.push({ root: -1, q: 'N', tpl: null, pcs: [] });
  const S = states.length;
  const medE = median(chroma.energy) || 1;
  const P = { kappa: 9, bass: 0.3, dia: 0.13, sev: 0.06, pBar: 0.5, pHalf: 0.25, pBeat: 0.06 };
  // 型も平均を引いておく（相関）
  const center = (v) => {
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return norm2(v.map((x) => x - m));
  };
  for (const st of states) if (st.tpl) st.ctpl = center(st.tpl);
  const emis = [];
  for (let i = 0; i < nb; i++) {
    const c = center(chroma.treble[i]);
    const bc = center(chroma.bass[i]);
    const dia = diatonicChords(keyOfBeat[i]);
    const row = new Float64Array(S);
    for (let s = 0; s < S - 1; s++) {
      const st = states[s];
      let d = 0;
      for (let p = 0; p < 12; p++) d += st.ctpl[p] * c[p];
      d += P.bass * bc[st.root];
      if (dia.has(`${st.root}:${st.q}`)) d += P.dia;
      if (st.q !== 'maj' && st.q !== 'min') d -= P.sev;
      row[s] = d;
    }
    row[S - 1] = chroma.energy[i] < medE * 0.08 ? 3 : 0.1;
    emis.push(row);
  }
  const kappa = P.kappa;
  const changeLog = (i) => {
    const pos = beatInBar[i];
    let p = P.pBeat;
    if (pos === 0) p = P.pBar;
    else if (meter === 4 && pos === 2) p = P.pHalf;
    return { stay: Math.log(1 - p), move: Math.log(p / 12) };
  };
  let prev = Array.from(emis[0], (v) => kappa * v);
  const back = [];
  for (let i = 1; i < nb; i++) {
    const { stay, move } = changeLog(i);
    let pmax = -Infinity, parg = 0;
    for (let s = 0; s < S; s++) if (prev[s] > pmax) { pmax = prev[s]; parg = s; }
    const cur = new Array(S), bk = new Int32Array(S);
    for (let s = 0; s < S; s++) {
      const vs = prev[s] + stay, vm = pmax + move;
      if (vs >= vm) { cur[s] = vs; bk[s] = s; } else { cur[s] = vm; bk[s] = parg; }
      cur[s] += kappa * emis[i][s];
    }
    back.push(bk);
    prev = cur;
  }
  let s = 0;
  for (let q = 1; q < S; q++) if (prev[q] > prev[s]) s = q;
  const path = new Array(nb);
  path[nb - 1] = s;
  for (let i = nb - 1; i > 0; i--) { s = back[i - 1][s]; path[i - 1] = s; }
  return path.map((si, i) => {
    const st = states[si];
    if (st.q === 'N') return null;
    return { root: st.root, q: st.q, pcs: st.pcs, conf: emis[i][si] };
  });
}

export function chordName(ch, key) {
  if (!ch) return 'N.C.';
  return pcName(ch.root, key) + QUALITIES[ch.q].suffix;
}

// ───────────────────────── 8. 歌の場所
function vocalFromListen(listen, beats, duration) {
  const rows = listen.rows || [];
  const nb = beats.length;
  const prob = new Float64Array(nb);
  const pts = rows.map((r) => {
    const c = r.c || {};
    const v = Math.max(c.singing || 0, c.choir_singing || 0, (c.rapping || 0) * 0.9, (c.humming || 0) * 0.5, c.yodeling || 0);
    return { t: r.t + r.d / 2, v, a: r.t, b: r.t + r.d };
  });
  for (let i = 0; i < nb; i++) {
    const t0 = beats[i], t1 = i + 1 < nb ? beats[i + 1] : duration;
    const tc = (t0 + t1) / 2;
    // 窓の中心が近いものを重みづけ
    let s = 0, w = 0;
    for (const p of pts) {
      if (p.b < t0 - 0.2 || p.a > t1 + 0.2) continue;
      const d = Math.abs(p.t - tc);
      const ww = Math.exp(-0.5 * (d / 0.5) ** 2) + 1e-3;
      s += p.v * ww; w += ww;
    }
    prob[i] = w > 0 ? s / w : 0;
  }
  return prob;
}
function vocalFallback(A, beats, duration) {
  // 真ん中に定位した声の帯域の割合（AI 判定が使えないとき用）
  const nb = beats.length, prob = new Float64Array(nb);
  const vals = [];
  for (let i = 0; i < nb; i++) {
    const t0 = beats[i], t1 = i + 1 < nb ? beats[i + 1] : duration;
    let s = 0, c = 0;
    for (let f = Math.floor(t0 * A.fps); f < Math.min(A.F, Math.ceil(t1 * A.fps)); f++) { s += A.vfrac[f]; c++; }
    vals.push(c ? s / c : 0);
  }
  const lo = percentile(vals, 0.15), hi = percentile(vals, 0.85);
  for (let i = 0; i < nb; i++) prob[i] = Math.min(1, Math.max(0, (vals[i] - lo) / (hi - lo + 1e-9))) * 0.5;
  return prob;
}

// ───────────────────────── 9. 曲の区切り
function buildBars(beats, phase, meter, duration) {
  const bars = [];
  if (phase > 0) bars.push({ b0: 0, n: phase, pickup: true });
  for (let b = phase; b < beats.length; b += meter) bars.push({ b0: b, n: Math.min(meter, beats.length - b) });
  for (const bar of bars) {
    bar.t0 = beats[bar.b0];
    const e = bar.b0 + bar.n;
    bar.t1 = e < beats.length ? beats[e] : duration;
  }
  return bars;
}

function segmentSong(bars, barVocal, barFeat, barEnergy) {
  const nb = bars.length;
  // 歌あり／なしの並び（1小節だけの反転はならす）
  const v = barVocal.slice();
  for (let i = 1; i < nb - 1; i++) if (v[i] !== v[i - 1] && v[i] !== v[i + 1] && v[i - 1] === v[i + 1]) v[i] = v[i - 1];
  const runs = [];
  for (let i = 0; i < nb; i++) {
    if (!runs.length || runs[runs.length - 1].vocal !== v[i]) runs.push({ vocal: v[i], a: i, e: i + 1 });
    else runs[runs.length - 1].e = i + 1;
  }
  // 長い区間は、音の変わり目で分ける
  const sim = (i, j) => {
    let d = 0;
    for (let k = 0; k < barFeat[i].length; k++) d += barFeat[i][k] * barFeat[j][k];
    return d;
  };
  const novelty = new Float64Array(nb);
  const W = 4;
  for (let i = W; i <= nb - W; i++) {
    let s = 0;
    for (let a = i - W; a < i + W; a++) for (let b = i - W; b < i + W; b++) {
      const same = (a < i) === (b < i) ? 1 : -1;
      s += same * sim(a, b);
    }
    novelty[i] = s / (4 * W * W);
  }
  const segs = [];
  for (const r of runs) {
    const len = r.e - r.a;
    const cuts = [r.a];
    if (len >= 12) {
      // 4小節単位の切れ目候補から、変化が大きいところを選ぶ
      const cand = [];
      for (let i = r.a + 4; i <= r.e - 4; i++) {
        const fromStart = i - r.a;
        const grid = fromStart % 4 === 0 ? 1 : fromStart % 2 === 0 ? 0.6 : 0.25;
        cand.push({ i, s: novelty[i] * grid });
      }
      cand.sort((x, y) => y.s - x.s);
      const meanN = cand.reduce((s, c) => s + c.s, 0) / Math.max(1, cand.length);
      for (const c of cand) {
        if (c.s < meanN * 1.6 || c.s <= 0) break;
        if (cuts.some((x) => Math.abs(x - c.i) < 4) || r.e - c.i < 4) continue;
        cuts.push(c.i);
        if (cuts.length > len / 6) break;
      }
      cuts.sort((x, y) => x - y);
    }
    for (let k = 0; k < cuts.length; k++) segs.push({ vocal: r.vocal, a: cuts[k], e: k + 1 < cuts.length ? cuts[k + 1] : r.e });
  }
  // 特徴の平均
  for (const s of segs) {
    const f = new Float64Array(barFeat[0].length);
    let en = 0;
    for (let i = s.a; i < s.e; i++) { for (let k = 0; k < f.length; k++) f[k] += barFeat[i][k]; en += barEnergy[i]; }
    s.feat = norm2(Array.from(f));
    s.energy = en / (s.e - s.a);
  }
  // 似た区間に同じ記号
  let next = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].label != null) continue;
    segs[i].label = next;
    for (let j = i + 1; j < segs.length; j++) {
      if (segs[j].label != null || segs[j].vocal !== segs[i].vocal) continue;
      let d = 0;
      for (let k = 0; k < segs[i].feat.length; k++) d += segs[i].feat[k] * segs[j].feat[k];
      if (d > 0.985) segs[j].label = next;
    }
    next++;
  }
  // 種類
  const voc = segs.filter((s) => s.vocal);
  const byLabel = new Map();
  for (const s of voc) {
    if (!byLabel.has(s.label)) byLabel.set(s.label, []);
    byLabel.get(s.label).push(s);
  }
  // サビ：くり返し出てくる・一番大きい区間。ただし歌の半分以上を占めるなら区別できていないとみなす
  const vocBars = voc.reduce((a, x) => a + (x.e - x.a), 0);
  const vocEs = voc.map((x) => x.energy).sort((a, b) => a - b);
  const medVE = vocEs.length ? vocEs[vocEs.length >> 1] : 0;
  const maxVE = vocEs.length ? vocEs[vocEs.length - 1] : 0;
  const labs = [...byLabel.entries()].map(([lab, list]) => ({
    lab,
    e: list.reduce((a, x) => a + x.energy, 0) / list.length,
    bars: list.reduce((a, x) => a + (x.e - x.a), 0),
    count: list.length,
  })).sort((x, y) => (y.e + (y.count >= 2 ? 1 : 0)) - (x.e + (x.count >= 2 ? 1 : 0)));
  let chorusLabel = null;
  for (const l of labs) {
    if (l.bars <= vocBars * 0.5 && l.e >= medVE + 0.5) { chorusLabel = l.lab; break; }
  }
  // くり返しで決まらないときは、歌の区間の中で大きい方の3分の1をサビとみなす
  const topE = vocEs.length ? vocEs[Math.floor(vocEs.length * 0.66)] : 0;
  const isChorus = (x) => (chorusLabel != null ? x.label === chorusLabel : x.energy >= topE && x.energy >= medVE + 0.3) || (x.energy >= maxVE - 1 && x.energy >= medVE + 1.5);
  const firstVocal = segs.findIndex((x) => x.vocal);
  let lastVocal = -1;
  segs.forEach((x, i) => { if (x.vocal) lastVocal = i; });
  // 歌がまったくない曲（インスト）：最初はイントロ、最後はアウトロ、間は大きい所を間奏・それ以外をAメロ扱い
  const instEs = segs.map((x) => x.energy).sort((a, b) => a - b);
  const instMed = instEs[instEs.length >> 1] || 0;
  segs.forEach((s, i) => {
    if (firstVocal < 0) {
      s.type = i === 0 && segs.length > 1 ? 'intro' : i === segs.length - 1 && segs.length > 2 ? 'outro' : s.energy >= instMed ? 'inter' : 'verse';
    } else if (!s.vocal) {
      s.type = i < firstVocal ? 'intro' : i > lastVocal ? 'outro' : 'inter';
      // 曲の終わりが短い間奏だけならアウトロ
    } else if (isChorus(s)) s.type = 'chorus';
    else s.type = 'verse';
  });
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].type === 'verse' && segs[i + 1].type === 'chorus' && i > 0 && segs[i - 1].type === 'verse' && segs[i].label !== segs[i - 1].label) segs[i].type = 'pre';
  }
  const counts = {};
  for (const s of segs) {
    counts[s.type] = (counts[s.type] || 0) + 1;
    s.n = counts[s.type];
  }
  const lastChorus = [...segs].reverse().find((s) => s.type === 'chorus');
  if (lastChorus) lastChorus.lastChorus = true;
  return segs.map((s) => ({ type: s.type, label: s.label, bar0: s.a, bar1: s.e, vocal: s.vocal, energy: s.energy, n: s.n, lastChorus: !!s.lastChorus }));
}

// ───────────────────────── 10. リフ（目立つ旋律のくり返し）
function detectRiffs(A, beats, bars, sections, keyPerBar, duration, meter) {
  const riffs = [];
  const stepsPerBeat = 4;
  const beatTime = (bi) => {
    const i = Math.floor(bi), f = bi - i;
    if (i + 1 < beats.length) return beats[i] + (beats[i + 1] - beats[i]) * f;
    const p = beats[beats.length - 1] - beats[beats.length - 2];
    return beats[beats.length - 1] + p * (bi - (beats.length - 1));
  };
  // 目立ち具合のしきい値（曲全体の中くらい）
  const sv = [];
  for (let t = 0; t < A.F; t += 3) sv.push(A.melTopS[t * A.TOPK]);
  const thr = Math.max(0.12, percentile(sv, 0.4) * 0.6);
  sections.forEach((sec, si) => {
    if (sec.vocal) return;
    const barList = bars.slice(sec.bar0, sec.bar1).filter((b) => !b.pickup && b.n === meter);
    if (barList.length < 2) return;
    const SP = meter * stepsPerBeat;
    // 16分ごとに「どの高さが、どれくらい鳴っているか」（上位3候補の票）
    const grid = barList.map((bar) => {
      const row = [];
      for (let s = 0; s < SP; s++) {
        const ta = beatTime(bar.b0 + s / stepsPerBeat), tb = beatTime(bar.b0 + (s + 1) / stepsPerBeat);
        // 解析の窓（約 93ms）は前の音も聞いてしまうので、各 16 分の後ろ寄りを見る
        const dt = tb - ta;
        const fa = Math.max(0, Math.floor((ta - ONSET_LAG + RIFF_FROM * dt) * A.fps)), fb = Math.min(A.F, Math.ceil((tb - ONSET_LAG + RIFF_TO * dt) * A.fps));
        const votes = new Map();
        let nf = 0;
        for (let f = fa; f < fb; f++) {
          nf++;
          for (let k = 0; k < A.TOPK; k++) {
            const sal = A.melTopS[f * A.TOPK + k];
            if (sal < thr) continue;
            const m = Math.round(A.melTopP[f * A.TOPK + k] - A.tuning / 100);
            if (m < 52) continue; // E3 より下はベースとみなす（ベースの動きはまねない）
            votes.set(m, (votes.get(m) || 0) + sal);
          }
        }
        if (nf) for (const [m, v] of votes) votes.set(m, v / nf);
        row.push(votes);
      }
      return row;
    });
    const top1 = (votes) => {
      let bm = null, bv = 0;
      for (const [m, v] of votes) if (v > bv) { bv = v; bm = m; }
      return bm;
    };
    const voicedRatio = grid.flat().filter((v) => v.size).length / (grid.length * SP);
    if (voicedRatio < 0.35) return;
    // くり返しの周期：同じ位置どうしの票の重なり
    const overlap = (x, y) => {
      let s = 0, nx = 0, ny = 0;
      for (const [m, v] of x) { nx += v * v; const w = y.get(m); if (w) s += v * w; }
      for (const v of y.values()) ny += v * v;
      return nx && ny ? s / Math.sqrt(nx * ny) : 0;
    };
    const cands = [];
    let best = null;
    for (const P of [1, 2, 4]) {
      if (barList.length < P * 2) continue;
      let sum = 0, n = 0;
      for (let b = 0; b + P < grid.length; b++) for (let s = 0; s < SP; s++) {
        if (!grid[b][s].size && !grid[b + P][s].size) continue;
        sum += overlap(grid[b][s], grid[b + P][s]);
        n++;
      }
      const sim = n ? sum / n : 0;
      cands.push({ P, sim });
      if (!best || sim > best.sim) best = { P, sim };
    }
    if (!best || best.sim < 0.4) return;
    for (const P of [1, 2, 4]) {
      if (P >= best.P) break;
      const c = cands.find((x) => x.P === P);
      if (c && c.sim >= best.sim - 0.08) { best = c; break; }
    }
    // 型：くり返し全部の票を足して、毎回のように鳴っている高さを選ぶ
    const P = best.P, len = P * SP, reps = Math.floor(grid.length / P);
    const tpl = [];
    for (let s = 0; s < len; s++) {
      const total = new Map(), hits = new Map();
      let nrep = 0;
      for (let r = 0; r < reps; r++) {
        const cell = grid[r * P + Math.floor(s / SP)][s % SP];
        nrep++;
        const t1 = top1(cell);
        for (const [m, v] of cell) {
          total.set(m, (total.get(m) || 0) + v);
          if (v >= 0.5 * (cell.get(t1) || 0)) hits.set(m, (hits.get(m) || 0) + 1);
        }
      }
      let bm = null, bv = 0;
      for (const [m, v] of total) if ((hits.get(m) || 0) >= Math.max(2, Math.ceil(nrep * 0.6)) && v > bv) { bv = v; bm = m; }
      tpl.push(bm);
    }
    // 音符にまとめる（同じ高さが続けば伸ばす）
    const notes = [];
    for (let s = 0; s < len; s++) {
      const m = tpl[s];
      if (m == null) continue;
      const last = notes[notes.length - 1];
      if (last && last.midi === m && last.s + last.len === s) last.len++;
      else notes.push({ s, len: 1, midi: m });
    }
    // ベースなど、型の中心から大きく下に外れた音は除く
    const medM = median(notes.map((x) => x.midi));
    for (let i = notes.length - 1; i >= 0; i--) if (notes[i].midi < medM - 10) notes.splice(i, 1);
    if (notes.length < 3) return;
    const key = keyPerBar[sec.bar0] || keyPerBar[0];
    const sc = new Set(scaleOf(key));
    const inScale = notes.filter((n) => sc.has(((n.midi % 12) + 12) % 12)).length / notes.length;
    const conf = best.sim * 0.6 + inScale * 0.3 + Math.min(1, voicedRatio) * 0.1;
    riffs.push({ section: si, periodBars: P, stepsPerBeat, notes, conf, sim: best.sim, inScale, voicedRatio });
  });
  return riffs;
}

// ───────────────────────── 全体
export function analyze(input, opts = {}) {
  const progress = opts.progress || (() => {});
  const { sr } = input;
  const L = input.L, R = input.R || input.L;
  const duration = L.length / sr;
  progress('spectrum', 0);
  const A = stageA(L, R, sr, progress);
  progress('pitch', 0);
  const B = stageB(L, R, sr, A.tuning, progress);
  progress('beats', 0);
  const { onset, lowOnset, bodyOnset } = onsetEnvelope(A);
  let beats, grid;
  if (opts.beats && opts.beats.length > 4) {
    // 画面の手直し（テンポ ×2・÷2・半拍ずらす）：前の拍の並びから作ったものをそのまま使う
    beats = opts.beats.filter((b) => b >= 0 && b < duration);
    const iv = [];
    for (let i = 1; i < beats.length; i++) iv.push(beats[i] - beats[i - 1]);
    const med = median(iv);
    grid = { steady: iv.every((x) => Math.abs(x - med) < 0.012) };
  } else {
    let bpm0 = opts.bpm || estimateTempo(onset, A.fps, opts.preferBpm || 115);
    beats = trackBeats(onset, A.fps, bpm0);
    // 倍のテンポに取っていないか：1つおきの拍で、低〜中音の立ち上がりが大きく違えば半分にする
    if (!opts.bpm && bpm0 > 125) {
      let ev = 0, od = 0;
      beats.forEach((b, i) => { const v = peakNear(bodyOnset, A.fps, b, 0.03); if (i % 2) od += v; else ev += v; });
      const ratio = Math.max(ev, od) / (Math.min(ev, od) + 1e-9);
      if (ratio > 1.7) { bpm0 /= 2; beats = trackBeats(onset, A.fps, bpm0); }
    }
    grid = refineGrid(beats, onset, A.fps, duration);
    beats = grid.steady ? grid.beats : extendBeats(beats, duration);
    const ph = opts.keepPhase ? { beats, shifted: false } : chooseBeatPhase(beats, B, lowOnset, onset, A.fps, duration);
    beats = ph.beats;
    // 変化の検出は窓の分だけ早めに出るので、その分ずらす（合成音で -31〜-32ms を確認）
    beats = beats.map((b) => Math.min(duration, b + ONSET_LAG)).filter((b, i, arr) => i === 0 || b > arr[i - 1] + 0.05);
  }
  const intervals = [];
  for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
  const bpm = 60 / median(intervals);
  progress('chords', 0);
  const chroma = beatChroma(B, beats, duration);
  const lowAt = beats.map((t) => peakNear(lowOnset, A.fps, t));
  const onAt = beats.map((t) => peakNear(onset, A.fps, t));
  const db = findDownbeat(chroma, lowAt, onAt);
  const meter = opts.meter || db.meter;
  let phase = opts.meter ? (opts.meter === 3 ? db.c3.phase : opts.meter === 4 ? db.c4.phase : 0) : db.phase;
  // 画面の「小節の頭をずらす」
  if (opts.downbeatShift) phase = (((phase + opts.downbeatShift) % meter) + meter) % meter;
  const bars = buildBars(beats, phase, meter, duration);
  const beatInBar = new Array(beats.length).fill(0);
  const barOfBeat = new Array(beats.length).fill(0);
  bars.forEach((bar, bi) => {
    for (let k = 0; k < bar.n; k++) {
      beatInBar[bar.b0 + k] = bar.pickup ? meter - bar.n + k : k;
      barOfBeat[bar.b0 + k] = bi;
    }
  });
  const barChroma = bars.map((bar) => {
    const c = new Array(12).fill(0);
    for (let k = 0; k < bar.n; k++) {
      const i = bar.b0 + k;
      for (let p = 0; p < 12; p++) c[p] += chroma.treble[i][p] + 0.5 * chroma.bass[i][p];
    }
    return c;
  });
  const keys = detectKeys(barChroma);
  // 画面で調を指定したとき：全部の小節をその調に
  if (opts.key) { keys.global = { ...opts.key, conf: 1, manual: true }; keys.perBar = keys.perBar.map(() => ({ tonic: opts.key.tonic, mode: opts.key.mode })); }
  const keyOfBeat = beats.map((_, i) => keys.perBar[barOfBeat[i]]);
  const chords = detectChords(chroma, beats, beatInBar, keyOfBeat, meter);
  progress('vocal', 0);
  const vprob = opts.listen ? vocalFromListen(opts.listen, beats, duration) : vocalFallback(A, beats, duration);
  // AI によって数字の大きさが違うので、「歌っている」の境目が 0.15 になるようにそろえる
  const vth = opts.vocalThreshold ?? 0.15;
  if (Math.abs(vth - 0.15) > 1e-9) for (let i = 0; i < vprob.length; i++) vprob[i] = Math.min(1, (vprob[i] * 0.15) / vth);
  const beatVocal = Array.from(vprob, (p) => p >= 0.15);
  const barVocal = bars.map((bar) => {
    let c = 0;
    for (let k = 0; k < bar.n; k++) if (beatVocal[bar.b0 + k]) c++;
    return c / bar.n >= 0.4;
  });
  // 小節の特徴（音の色＋和音）
  const barEnergy = bars.map((bar) => {
    const f0 = Math.floor(bar.t0 * A.fps), f1 = Math.min(A.F, Math.ceil(bar.t1 * A.fps));
    let s = 0;
    for (let f = f0; f < f1; f++) s += A.rms[f] * A.rms[f];
    return 10 * Math.log10(s / Math.max(1, f1 - f0) + 1e-12);
  });
  const barFeat = bars.map((bar, bi) => {
    const f0 = Math.floor(bar.t0 * A.fps), f1 = Math.min(A.F, Math.ceil(bar.t1 * A.fps));
    const tim = new Float64Array(A.NB);
    for (let f = f0; f < f1; f++) for (let b = 0; b < A.NB; b++) tim[b] += A.logmel[f * A.NB + b];
    const cnt = Math.max(1, f1 - f0);
    let mean = 0;
    for (let b = 0; b < A.NB; b++) { tim[b] /= cnt; mean += tim[b]; }
    mean /= A.NB;
    const t = Array.from(tim, (x) => x - mean);
    const c = norm2(barChroma[bi]);
    return norm2(norm2(t).map((x) => x * 0.8).concat(c.map((x) => x * 0.6)));
  });
  progress('sections', 0);
  const sections = segmentSong(bars, barVocal, barFeat, barEnergy);
  progress('riffs', 0);
  const riffs = detectRiffs(A, beats, bars, sections, keys.perBar, duration, meter);
  // 原曲の音量（バイオリンの音量合わせ用）
  const loud = percentile(Array.from(A.rms).filter((x) => x > 0), 0.8);
  progress('done', 1);
  return {
    version: 1,
    duration,
    tuning: A.tuning,
    bpm,
    steadyTempo: grid.steady,
    meter,
    meterGuess: db.meter,
    meterContrast: { c3: Math.round(db.c3.contrast * 1000) / 1000, c4: Math.round(db.c4.contrast * 1000) / 1000 },
    beats,
    beatInBar,
    barOfBeat,
    bars: bars.map((b) => ({ b0: b.b0, n: b.n, t0: b.t0, t1: b.t1, pickup: !!b.pickup })),
    key: keys.global,
    keyPerBar: keys.perBar,
    chords,
    chroma: chroma.treble.map((c) => c.map((x) => Math.round(x * 1000) / 1000)),
    bassChroma: chroma.bass.map((c) => c.map((x) => Math.round(x * 1000) / 1000)),
    beatEnergy: chroma.energy,
    vocalProb: Array.from(vprob),
    vocalSource: opts.listen ? 'ai' : 'fallback',
    barVocal,
    barEnergy,
    sections,
    riffs,
    loudRms: loud,
  };
}
