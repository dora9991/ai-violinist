// ボーカル分離（曲から歌だけを取り出す）。重い計算は Worker（separate-worker.js）で行い、画面を止めない。曲はどこにも送らない。
// AI：Deezer の Spleeter 2stems（MIT）を ONNX にしたもの（models-sep/。重みを 8bit で保存・計算は float32）
//
// separateVocals(input, opt) → Promise<{ vocal: [L, R], accomp: [L, R] | null, sampleRate, info }>
//   input：AudioBuffer（またはその形のもの：sampleRate・numberOfChannels・length・getChannelData(c)）か { L, R, sr }
//          （R は省略可＝モノラル）。File / Blob / ArrayBuffer も可（44.1kHz で読み込む）
//   返り値：vocal・accomp は Float32Array。長さとサンプリング周波数（sampleRate）は入力と同じ
//          （AI は 44.1kHz で動くので、ほかの周波数は中で変換して戻す。File などを渡したときは 44100）。
//          モノラルの入力なら左右は同じ配列。accomp は opt.accomp のときだけ（＝入力 − 歌。足すと元どおり）
//          info：{ ms, loadMs, resampleMs, blocks, mask, high }（かかった時間など）
//   opt.onProgress(p, { stage, note, stageP })：p は全体の 0〜1（増えるだけ）。stage は 'load'（AI の読み込み・初回は約 20MB）| 'separate' | 'finish'。
//          stageP はその段階の中での 0〜1（読み込みの % を出したいときなど）
//   opt.base：AI のファイルを置いた場所の URL（既定はこのファイルから見た ../models-sep/。相対ならページから見た場所）
//   opt.accomp：伴奏も返す（既定 false）
//   opt.keep：Worker と AI を残して、次の分離を速くする（既定 false＝終わったら片付ける。disposeSeparator() で片付く）
//   opt.signal：AbortSignal（中止すると AbortError）
//   opt.transfer：{ L, R } の配列をコピーせずに Worker へ渡す（渡した配列は使えなくなる。大きな曲でメモリを節約）
//   opt.overlap・opt.mask・opt.high：細かい設定（separate-worker.js の separateCore を参照。ふつうは既定のままでよい）
export const SEPARATOR_INFO = {
  model: 'Spleeter 2stems（Deezer・MIT）／ONNX 変換：sherpa-onnx（Apache-2.0）',
  sampleRate: 44100,
  files: ['spleeter-vocals.onnx', 'spleeter-accompaniment.onnx'],
  bytes: 19751552, // 初回に読み込む大きさ（2 つの合計・約 20 MB）
};
const NOTE = { load: '歌を聞き分ける AI を読み込んでいます', separate: '歌と伴奏を分けています', finish: '仕上げています' };
// 進み具合の配分（読み込み 8%・分離 88%・仕上げ 4%）
const SPAN = { load: [0, 0.08], separate: [0.08, 0.96], finish: [0.96, 1] };

let shared = null; // keep: true のときの Worker（{ w, busy }）

export function disposeSeparator() {
  if (shared) { shared.w.terminate(); shared = null; }
}

async function decode44k(data) {
  const ab = data instanceof ArrayBuffer ? data.slice(0) : await data.arrayBuffer();
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw new Error('このブラウザでは音声を読み込めません');
  const oc = new OAC(2, 1, 44100);
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('この形式の音声は開けませんでした'));
    const p = oc.decodeAudioData(ab, resolve, fail);
    if (p && p.then) p.then(resolve, fail);
  });
}

function abortError() {
  try { return new DOMException('分離を中止しました', 'AbortError'); }
  catch (e) { const err = new Error('分離を中止しました'); err.name = 'AbortError'; return err; }
}

export async function separateVocals(input, opt = {}) {
  if (input instanceof ArrayBuffer || (typeof Blob !== 'undefined' && input instanceof Blob)) input = await decode44k(input);
  let L, R, sr;
  if (input && typeof input.getChannelData === 'function') {
    sr = input.sampleRate;
    L = input.getChannelData(0).slice();
    R = input.numberOfChannels > 1 ? input.getChannelData(1).slice() : null;
  } else if (input && input.L) {
    sr = input.sr || input.sampleRate;
    const mono = !input.R || input.R === input.L;
    L = opt.transfer ? input.L : input.L.slice();
    R = mono ? null : opt.transfer ? input.R : input.R.slice();
  } else {
    throw new Error('分ける曲がありません');
  }
  if (!(L instanceof Float32Array) || !L.length || (R && (!(R instanceof Float32Array) || R.length !== L.length))) throw new Error('曲のデータの形が正しくありません（Float32Array・左右同じ長さ）');
  if (!(sr > 0)) throw new Error('サンプリング周波数がわかりません');
  if (opt.signal && opt.signal.aborted) throw abortError();
  const base = (opt.base ? new URL(opt.base, location.href) : new URL('../models-sep/', import.meta.url)).href.replace(/\/?$/, '/');
  const onProgress = (p, info) => { try { opt.onProgress && opt.onProgress(p, info); } catch (e) { console.warn(e); } };

  return new Promise((resolve, reject) => {
    let slot = opt.keep && shared && !shared.busy ? shared : null;
    try { if (!slot) slot = { w: new Worker(new URL('./separate-worker.js', import.meta.url), { type: 'module' }), busy: false }; }
    catch (e) { reject(new Error('分離の Worker を起動できませんでした：' + (e.message || e))); return; }
    if (opt.keep && !shared) shared = slot;
    const w = slot.w;
    slot.busy = true;
    let last = 0, finished = false;
    const done = (ok, x) => {
      if (finished) return;
      finished = true;
      slot.busy = false;
      w.onmessage = null; w.onerror = null;
      if (opt.signal) opt.signal.removeEventListener('abort', onAbort);
      // 片付ける：残す指定がないとき・失敗や中止のとき（途中の Worker は使い回さない）
      if (slot !== shared || !ok) { w.terminate(); if (shared === slot) shared = null; }
      (ok ? resolve : reject)(x);
    };
    const onAbort = () => done(false, abortError());
    if (opt.signal) opt.signal.addEventListener('abort', onAbort, { once: true });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        const [a, b] = SPAN[m.stage] || [0, 1];
        const sp = Math.min(1, m.p || 0);
        last = Math.max(last, a + (b - a) * sp);
        onProgress(last, { stage: m.stage, note: NOTE[m.stage] || '', stageP: sp });
      } else if (m.type === 'done') {
        onProgress(1, { stage: 'finish', note: NOTE.finish, stageP: 1 });
        done(true, { vocal: m.vocal, accomp: m.accomp, sampleRate: m.sampleRate, info: m.info });
      } else if (m.type === 'error') {
        done(false, new Error(m.message));
      }
    };
    w.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      done(false, new Error('分離の AI を動かせませんでした' + (e && e.message ? '：' + e.message : '')));
    };
    const tr = [...new Set(R ? [L.buffer, R.buffer] : [L.buffer])];
    w.postMessage({ type: 'separate', L, R, sr, base, accomp: !!opt.accomp, overlap: opt.overlap, mask: opt.mask, high: opt.high }, tr);
  });
}
