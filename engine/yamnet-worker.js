// 歌の場所を、ブラウザの中で AI（Google の YAMNet・音の分類）が調べる。曲はどこにも送らない。
// 入力：16kHz・モノラルの波形（Float32Array）。出力：0.48 秒ごとの「歌っていそうな度合い」
// （Mac 版の SoundAnalysis と同じ形 { t, d, c: { singing, choir_singing, rapping, humming, yodeling } } で返す）
import * as ort from '../vendor/ort/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1; // GitHub Pages では複数スレッド（SharedArrayBuffer）が使えないため

// YAMNet の分類の番号（yamnet_class_map.csv）
const IDX = { singing: 24, choir: 25, yodeling: 26, childSinging: 29, syntheticSinging: 30, rapping: 31, humming: 32, music: 132 };
const SR = 16000, HOP = 7680, WIN = 15360; // 0.48 秒ずつ・0.96 秒の窓

let session = null;
self.onmessage = async (e) => {
  const { pcm } = e.data;
  try {
    if (!session) {
      self.postMessage({ type: 'progress', p: 0, note: 'AI を読み込んでいます' });
      session = await ort.InferenceSession.create(new URL('../models/yamnet.onnx', import.meta.url).href, { executionProviders: ['wasm'] });
    }
    const inName = session.inputNames[0], outName = session.outputNames[0];
    const rows = [];
    const framesPer = 60; // 1 回に約 29 秒ぶん
    const chunk = WIN + HOP * (framesPer - 1);
    for (let start = 0; start < pcm.length; start += HOP * framesPer) {
      let seg = pcm.subarray(start, Math.min(pcm.length, start + chunk));
      if (seg.length < WIN) { const pad = new Float32Array(WIN); pad.set(seg); seg = pad; }
      const out = await session.run({ [inName]: new ort.Tensor('float32', Float32Array.from(seg), [seg.length]) });
      const sc = out[outName];
      const [nf, nc] = sc.dims;
      const d = sc.data;
      for (let f = 0; f < nf; f++) {
        const o = f * nc;
        const t = (start + f * HOP) / SR;
        if (t * SR >= pcm.length) break;
        rows.push({
          t: Math.round(t * 1000) / 1000, d: WIN / SR,
          c: {
            singing: Math.max(d[o + IDX.singing], d[o + IDX.childSinging], d[o + IDX.syntheticSinging]),
            choir_singing: d[o + IDX.choir], rapping: d[o + IDX.rapping], humming: d[o + IDX.humming], yodeling: d[o + IDX.yodeling], music: d[o + IDX.music],
          },
        });
      }
      self.postMessage({ type: 'progress', p: Math.min(1, (start + chunk) / pcm.length) });
    }
    self.postMessage({ type: 'done', rows });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
