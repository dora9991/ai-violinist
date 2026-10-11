// 歌と伴奏を分ける（ボーカル分離）。Deezer の Spleeter（2stems・MIT）を ONNX にしたものを、ブラウザの中で動かす。曲はどこにも送らない。
// 手順：44.1kHz にそろえる → STFT（4096 点・1024 ずつ・ハン窓）→ 0〜11kHz（1024 本）の大きさを AI に入れる（512 フレーム≒11.9 秒ずつ）
//      → AI が出す「歌の大きさ」「伴奏の大きさ」から歌の割合（マスク）を作る → 元の STFT に掛けて逆 STFT → 元のサンプリング周波数に戻す
// ブロックは少し重ねて、重なりはマスクをなめらかに混ぜる（11.9 秒ごとのつなぎ目に段差が出ないように）。
// 前処理・後処理は sherpa-onnx（scripts/spleeter/separate_onnx.py・offline-source-separation-spleeter-impl.h）と Spleeter 本家にそろえた。
import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { FFT } from './fft.js';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1; // GitHub Pages では複数スレッド（SharedArrayBuffer）が使えないため

export const SR = 44100;                 // AI のサンプリング周波数
const N = 4096, H = 1024, K = N / 2 + 1; // STFT の長さ・ずらし幅・周波数の本数
const F = 1024, T = 512;                 // AI に入れる周波数の本数（0〜11kHz）・1 回のフレーム数
const P = N - H;                         // 頭に足す無音（最初のサンプルも 4 つの窓で覆うため）
const EPS = 1e-10;
export const MODEL_FILES = { vocals: 'spleeter-vocals.onnx', accomp: 'spleeter-accompaniment.onnx' };

// ───────────────────────── サンプリング周波数の変換（カイザー窓つき sinc・位相 2048 段の表）
// 遅れなし。長さは outLen（省略時は round(長さ × to / from)）
function bessel0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-12 * s) break; }
  return s;
}
export function resample(x, from, to, outLen) {
  if (from === to && (outLen == null || outLen === x.length)) return x;
  const r = to / from;
  const n = outLen ?? Math.round(x.length * r);
  const y = new Float32Array(n);
  const sc = Math.min(1, r);       // 下げるときは、低い方のナイキスト周波数で切る
  const fc = 0.5 * sc * 0.96;      // 切る周波数（入力 1 サンプルあたり）
  const half = Math.ceil(16 / sc); // 片側のタップ数（入力のサンプル数）
  const W = 2 * half, PH = 2048, beta = 8.6, ib = bessel0(beta);
  const tab = new Float32Array((PH + 1) * W);
  for (let p = 0; p <= PH; p++) {
    for (let k = 0; k < W; k++) {
      const u = k - half + 1 - p / PH;
      const s = u === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * u) / (Math.PI * u);
      const z = u / half;
      tab[p * W + k] = Math.abs(z) >= 1 ? 0 : (s * bessel0(beta * Math.sqrt(1 - z * z))) / ib;
    }
  }
  const len = x.length;
  for (let j = 0; j < n; j++) {
    const t = j / r, i0 = Math.floor(t);
    const base = Math.round((t - i0) * PH) * W, s0 = i0 - half + 1;
    let acc = 0;
    if (s0 >= 0 && s0 + W <= len) for (let k = 0; k < W; k++) acc += x[s0 + k] * tab[base + k];
    else for (let k = 0; k < W; k++) { const i = s0 + k; if (i >= 0 && i < len) acc += x[i] * tab[base + k]; }
    y[j] = acc;
  }
  return y;
}

// ───────────────────────── 分離の本体（44.1kHz の L, R → 歌の L, R）
// run(x) → Promise<{ v, a }>：x は AI の入力 [2, 1, 512, 1024]（左右・ブロック・フレーム・周波数）。v・a は歌・伴奏の大きさの推定（a は mask='ratio' のときだけ）
// opt.overlap：ブロックの重なりの最小フレーム数（既定 64 ≒ 1.5 秒）
// opt.mask：'ratio'（歌と伴奏の AI の比・Spleeter と同じ）| 'vocal'（歌の AI だけ）
// opt.high：11kHz より上の扱い。'zeros'（Spleeter 2stems と同じ。歌に高い音を入れない）| 'average'（その時刻のマスクの平均）
// opt.onBlock(i, n)：ブロックが 1 つ終わるたびに呼ぶ
export async function separateCore(L, R, run, opt = {}) {
  const n = L.length;
  const mono = !R || R === L;
  if (mono) R = L;
  const ovMin = Math.max(0, Math.min(T / 2, opt.overlap ?? 64));
  const ratio = (opt.mask || 'ratio') === 'ratio';
  const highAvg = opt.high === 'average';
  const M = Math.floor((n - 1 + P) / H) + 1; // フレームの数
  // ブロックの始まり：必要な数だけ、等間隔に並べる（重なりは ovMin 以上）
  const nb = M <= T ? 1 : Math.ceil((M - T) / (T - ovMin)) + 1;
  const starts = [];
  for (let b = 0; b < nb; b++) starts.push(nb === 1 ? 0 : Math.round((b * (M - T)) / (nb - 1)));
  const win = new Float64Array(N);
  for (let j = 0; j < N; j++) win[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / N);
  const fft = new FFT(N);
  const zr = new Float64Array(N), zi = new Float64Array(N);
  // T フレームぶんの輪：複素スペクトル（左右）・マスクの重みつき和・重みの和
  const specR = new Float32Array(T * 2 * K), specI = new Float32Array(T * 2 * K);
  const macc = new Float32Array(T * 2 * F), wacc = new Float32Array(T);
  const x = new Float32Array(2 * T * F);
  const outL = new Float32Array(n), outR = mono ? null : new Float32Array(n);

  // 左右を 1 回の複素 FFT で変換する（実部に左、虚部に右）
  function stftFrame(f) {
    const off = f * H - P;
    for (let j = 0; j < N; j++) {
      const i = off + j;
      if (i >= 0 && i < n) { zr[j] = L[i] * win[j]; zi[j] = R[i] * win[j]; } else { zr[j] = 0; zi[j] = 0; }
    }
    fft.transform(zr, zi);
    const sL = (f % T) * 2 * K, sR = sL + K;
    for (let k = 0; k < K; k++) {
      const k2 = (N - k) & (N - 1);
      const ar = zr[k], ai = zi[k], br = zr[k2], bi = zi[k2];
      specR[sL + k] = (ar + br) / 2; specI[sL + k] = (ai - bi) / 2;
      specR[sR + k] = (ai + bi) / 2; specI[sR + k] = (br - ar) / 2;
    }
  }
  // マスクを掛けて逆 FFT し、窓を掛けて重ね合わせる（ハン窓・1/4 ずらしなら窓の 2 乗の和は 1.5）
  function finishFrame(f) {
    const slot = f % T, wsum = wacc[slot] || 1;
    const sL = slot * 2 * K, sR = sL + K, mL = slot * 2 * F, mR = mL + F;
    let hiL = 0, hiR = 0;
    if (highAvg) {
      for (let k = 0; k < F; k++) { hiL += macc[mL + k]; hiR += macc[mR + k]; }
      hiL /= F * wsum; hiR /= F * wsum;
    }
    for (let k = 0; k < K; k++) {
      const gl = k < F ? macc[mL + k] / wsum : hiL;
      const gr = k < F ? macc[mR + k] / wsum : hiR;
      const lr = specR[sL + k] * gl, li = specI[sL + k] * gl, rr = specR[sR + k] * gr, ri = specI[sR + k] * gr;
      // Z[k] = Y_L + iY_R、Z[N-k] = conj(Y_L) + i conj(Y_R)。逆変換のため共役にしておく
      zr[k] = lr - ri; zi[k] = -(li + rr);
      if (k > 0 && k < N / 2) { zr[N - k] = lr + ri; zi[N - k] = li - rr; }
    }
    fft.transform(zr, zi);
    const off = f * H - P, g = 1 / (N * 1.5);
    for (let j = 0; j < N; j++) {
      const i = off + j;
      if (i < 0 || i >= n) continue;
      const w = win[j] * g;
      outL[i] += zr[j] * w;
      if (outR) outR[i] -= zi[j] * w;
    }
    macc.fill(0, mL, mL + 2 * F);
    wacc[slot] = 0;
  }

  let have = 0, fin = 0;
  for (let b = 0; b < nb; b++) {
    const s = starts[b];
    for (; have < Math.min(s + T, M); have++) stftFrame(have);
    // AI の入力：大きさ（0〜1023 本）。曲より後ろは 0
    for (let c = 0; c < 2; c++) {
      for (let j = 0; j < T; j++) {
        const f = s + j, o = c * T * F + j * F;
        if (f >= M) { x.fill(0, o, o + F); continue; }
        const so = (f % T) * 2 * K + c * K;
        for (let k = 0; k < F; k++) { const re = specR[so + k], im = specI[so + k]; x[o + k] = Math.sqrt(re * re + im * im); }
      }
    }
    const { v, a } = await run(x);
    // マスクを、ブロックの端ほど軽い重みで足していく
    const inOv = b > 0 ? starts[b - 1] + T - s : 0;
    const outOv = b < nb - 1 ? s + T - starts[b + 1] : 0;
    for (let j = 0; j < T; j++) {
      const f = s + j;
      if (f >= M) break;
      let w = 1;
      if (j < inOv) w *= Math.sin((Math.PI / 2) * ((j + 0.5) / inOv)) ** 2;
      if (j >= T - outOv) w *= Math.sin((Math.PI / 2) * ((T - j - 0.5) / outOv)) ** 2;
      const slot = f % T;
      for (let c = 0; c < 2; c++) {
        const o = c * T * F + j * F, mo = slot * 2 * F + c * F;
        if (ratio) {
          for (let k = 0; k < F; k++) {
            const vv = v[o + k] * v[o + k], aa = a[o + k] * a[o + k];
            macc[mo + k] += (w * (vv + EPS / 2)) / (vv + aa + EPS);
          }
        } else {
          for (let k = 0; k < F; k++) { const xx = x[o + k]; macc[mo + k] += xx > 1e-9 ? w * Math.min(1, v[o + k] / xx) : 0; }
        }
      }
      wacc[slot] += w;
    }
    // この先のブロックに入らないフレームを仕上げる
    const upto = b < nb - 1 ? starts[b + 1] : M;
    for (; fin < upto; fin++) finishFrame(fin);
    if (opt.onBlock) opt.onBlock(b + 1, nb);
  }
  return { L: outL, R: outR || outL, blocks: nb };
}

// ───────────────────────── AI の読み込み（進み具合つき）
async function fetchBytes(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText || ''}`.trim());
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !res.body.getReader) { const b = new Uint8Array(await res.arrayBuffer()); onBytes(b.length, b.length); return b; }
  const rd = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value); got += value.length;
    onBytes(got, Math.max(total, got));
  }
  const out = new Uint8Array(got);
  let p = 0;
  for (const c of parts) { out.set(c, p); p += c.length; }
  return out;
}

let cache = null; // { base, vocals, accomp }（Worker を残したときに使い回す）
async function loadSessions(base, needAccomp, post) {
  if (cache && cache.base === base && (cache.accomp || !needAccomp)) return cache;
  const names = needAccomp ? ['vocals', 'accomp'] : ['vocals'];
  const got = {}, tot = {};
  const bufs = await Promise.all(names.map((k) => fetchBytes(new URL(MODEL_FILES[k], base).href, (g, t) => {
    got[k] = g; tot[k] = t;
    const G = names.reduce((s, x) => s + (got[x] || 0), 0), Tt = names.reduce((s, x) => s + (tot[x] || 0), 0);
    post({ type: 'progress', stage: 'load', p: Tt ? G / Tt : 0 });
  }).catch((e) => { throw new Error(`分離の AI（${MODEL_FILES[k]}）を読み込めませんでした：${e.message || e}`); })));
  // メモリの置き場（arena）を 2 つのモデルで別々に持たない（4 分の曲で約 180MB 少ない・速さは同じ）
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false };
  const s = { base };
  for (let i = 0; i < names.length; i++) {
    try { s[names[i]] = await ort.InferenceSession.create(bufs[i], opts); }
    catch (e) { throw new Error(`分離の AI（${MODEL_FILES[names[i]]}）を動かせませんでした：${e.message || e}`); }
  }
  if (cache) { for (const k of ['vocals', 'accomp']) if (cache[k] && cache[k] !== s[k]) cache[k].release(); }
  cache = s;
  return s;
}

function makeRun(s, ratio) {
  const shape = [2, 1, T, F];
  return async (x) => {
    const feed = (sess) => ({ [sess.inputNames[0]]: new ort.Tensor('float32', x, shape) });
    const v = (await s.vocals.run(feed(s.vocals)))[s.vocals.outputNames[0]].data;
    const a = ratio ? (await s.accomp.run(feed(s.accomp)))[s.accomp.outputNames[0]].data : null;
    return { v, a };
  };
}

// ───────────────────────── Worker として動くとき
// 受け取る：{ type: 'separate', L, R(省略可), sr, base, accomp, overlap, mask, high }
// 返す：{ type: 'progress', stage: 'load'|'separate'|'finish', p } … / { type: 'done', vocal: [L, R], accomp: [L, R] | null, sampleRate, info } / { type: 'error', message }
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = async (e) => {
    const m = e.data || {};
    if (m.type !== 'separate') return;
    let lastLoad = 0;
    const post = (x, tr) => {
      // 読み込みの進み具合は送りすぎない（0.1 秒に 1 回）
      if (x.type === 'progress' && x.stage === 'load' && x.p < 1) { const now = performance.now(); if (now - lastLoad < 100) return; lastLoad = now; }
      self.postMessage(x, tr || []);
    };
    try {
      const t0 = performance.now();
      const ratio = (m.mask || 'ratio') === 'ratio';
      const sess = await loadSessions(m.base || new URL('../models-sep/', import.meta.url).href, ratio, post);
      const tLoad = performance.now() - t0;
      const sr = m.sr, n = m.L.length;
      const mono = !m.R;
      post({ type: 'progress', stage: 'separate', p: 0 });
      // AI は 44.1kHz で動く。ほかの周波数なら変換する
      let t1 = performance.now();
      let L44 = resample(m.L, sr, SR), R44 = mono ? null : resample(m.R, sr, SR);
      let tRes = performance.now() - t1;
      // 伴奏を返さないなら、元の音はもう使わない（大きな曲でメモリを空ける）
      const srcL = m.accomp ? m.L : null, srcR = m.accomp ? m.R : null;
      m.L = m.R = null;
      const res = await separateCore(L44, R44, makeRun(sess, ratio), {
        overlap: m.overlap, mask: m.mask, high: m.high,
        onBlock: (i, nb) => post({ type: 'progress', stage: 'separate', p: i / nb }),
      });
      L44 = R44 = null;
      post({ type: 'progress', stage: 'finish', p: 0 });
      t1 = performance.now();
      const vL = resample(res.L, SR, sr, n), vR = mono ? vL : resample(res.R, SR, sr, n);
      tRes += performance.now() - t1;
      // 伴奏 ＝ 元の音 − 歌（足すと元どおりになる）。受け取った配列をそのまま使う
      let acc = null;
      if (srcL) {
        for (let i = 0; i < n; i++) srcL[i] -= vL[i];
        if (srcR) for (let i = 0; i < n; i++) srcR[i] -= vR[i];
        acc = [srcL, srcR || srcL];
      }
      const info = { ms: Math.round(performance.now() - t0), loadMs: Math.round(tLoad), resampleMs: Math.round(tRes), blocks: res.blocks, mask: ratio ? 'ratio' : 'vocal', high: m.high || 'zeros' };
      const tr = new Set([vL.buffer, vR.buffer]);
      if (acc) { tr.add(acc[0].buffer); tr.add(acc[1].buffer); }
      post({ type: 'done', vocal: [vL, vR], accomp: acc, sampleRate: sr, info }, [...tr]);
    } catch (err) {
      post({ type: 'error', message: String((err && err.message) || err) });
    }
  };
}
