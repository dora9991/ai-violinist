// アコースティックギター（スチール弦）を鳴らす（Web Audio）。再生と書き出しで同じ作りを使う。
// 音：samples-guitar/（Fluid R3 GM の Steel String Guitar・MIT ／ ミュート音は Shinyguitar・CC0。samples-guitar/LICENSE.txt）
// 音符：{ t, d, midi, vel(0〜1), string(0＝6 弦の低い E … 5＝1 弦の高い E。なくてもよい), stroke('down'|'up'|'pick'|'mute') }
// ・ふつうの音は、録音のまま自然に減っていき、d で手で押さえたように短く消える。録音の終わり（ループ）に入ったら、減衰を付けて下げ続ける
// ・同じ弦で次の音（ミュートも）を弾くと、前の音は 40ms ほどで消える（弦の指定がない音は、同じ高さの音どうしだけ）
// ・強さ：大きさ（vel^1.66）と明るさ（ローパス。弱いほど暗く、高い音ほど明るく。MuseScore General の設定と同じ幅）
// ・'mute'：弦をミュートしてはじいた「チャッ」。録音があればそれを、なければその高さの音から短く作る
// ・ストロークは音がとても多い（3 分で数千音）。全部を先につなぐと、まだ鳴らない音までグラフに残って重くなる（3 分で書き出しに
//   2 分半）ので、鳴らす少し前に作ってつなぎ、鳴り終わったら外す：書き出し（OfflineAudioContext）は 2 秒ごとに suspend して足し、
//   再生（AudioContext）は 0.2 秒ごとのタイマーで 3 秒先まで足す

const OPEN = [40, 45, 50, 55, 59, 64]; // 開放弦（標準チューニング）
const DB = 20 / Math.LN10; // dB/秒 → setTargetAtTime の時定数：tau = DB / (dB/秒)

export async function loadGuitar(ctx, base = 'samples-guitar/', onProgress) {
  const man = await fetch(base + 'manifest.json').then((r) => {
    if (!r.ok) throw new Error('ギターの音がまだ準備できていません');
    return r.json();
  });
  let done = 0;
  const samples = await Promise.all(
    man.samples.map(async (s) => {
      const ab = await fetch(base + s.file).then((r) => {
        if (!r.ok) throw new Error('ギターの音を読み込めません: ' + s.file);
        return r.arrayBuffer();
      });
      const buffer = await ctx.decodeAudioData(ab);
      done++;
      onProgress && onProgress(done / man.samples.length);
      return { ...s, buffer };
    }),
  );
  const notes = samples.filter((s) => s.art !== 'mute').sort((a, b) => a.midi - b.midi);
  const mutes = samples.filter((s) => s.art === 'mute');
  return { man, samples, notes, mutes };
}

// 受け持ちの範囲に入る録音（複数なら基準の高さがいちばん近いもの）。どれにも入らなければ、いちばん近いもの
function pickNote(guitar, midi) {
  let best = guitar.notes[0], bd = Infinity;
  for (const s of guitar.notes) {
    const d = Math.abs(s.midi - midi) + (midi >= s.lo && midi <= s.hi ? 0 : 1000);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
// 弦の指定がないミュート：その高さを鳴らせるいちばん高い開放弦
const stringOf = (midi) => { let k = 0; for (let i = 0; i < 6; i++) if (midi >= OPEN[i]) k = i; return k; };
// 音ごとの小さなゆらぎ（同じ音符なら毎回同じ。途中から再生しても変わらない）
function jitter(t, midi, k) {
  const x = Math.sin(t * 127.1 + midi * 311.7 + k * 74.7) * 43758.5453;
  return x - Math.floor(x);
}
const velAmp = (v) => Math.pow(Math.max(0, Math.min(1, v)), 1.66);
// 明るさ：SF2 の書き方（セント）で、強さ 1 で全開・0 で 4200 セント下・音の高さで ±1000 セント
const cutoffHz = (ctx, vel, midi, extraCents) => Math.max(300, Math.min(ctx.sampleRate * 0.45, 8.176 * Math.pow(2, (13500 - 4200 * (1 - vel) + (1000 * (midi - 64)) / 64 + extraCents) / 1200)));

// 音符を予約する。songStart: 曲の 0 秒にあたる ctx の時刻。from: 何秒目から鳴らすか（それより前に終わる音は鳴らさない）
// 返り値 { stop(), count }（count＝鳴らす音の数）
export function scheduleGuitar(ctx, guitar, notes, dest, opt = {}) {
  const songStart = opt.songStart ?? ctx.currentTime;
  // ctx の 0 秒より前は鳴らせない（start に負の時刻を渡すとエラー）ので、そこまでは「途中から」と同じ扱い
  const o = { songStart, from: Math.max(opt.from ?? 0, -songStart), tuning: opt.tuning ?? 0, level: opt.level ?? 1 };
  // 時刻順に並べ、同じ弦で次に弾く時刻を調べておく（弦が 1 本なので、次の音で前の音は止まる）
  const order = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n && Number.isFinite(n.t) && Number.isFinite(n.midi) && Number.isFinite(n.d)) order.push(i);
  }
  order.sort((a, b) => notes[a].t - notes[b].t || a - b);
  const cutAt = new Map(), last = new Map();
  for (const i of order) {
    const n = notes[i];
    const key = n.string != null ? 's' + n.string : 'm' + n.midi;
    if (last.has(key)) cutAt.set(last.get(key), n.t);
    last.set(key, i);
  }
  // 鳴らし方を先に全部決める（数字だけ）。ノードは鳴らす少し前に作る
  const plans = [];
  for (const i of order) {
    const n = notes[i];
    const p = n.stroke === 'mute' ? planMute(ctx, guitar, n, cutAt.has(i) ? cutAt.get(i) : Infinity, o) : planNote(ctx, guitar, n, cutAt.has(i) ? cutAt.get(i) : Infinity, o);
    if (p) plans.push(p);
  }
  plans.sort((a, b) => a.t0 - b.t0);

  const live = [];
  let next = 0, stopped = false, timer = null;
  const feed = (horizon) => { while (next < plans.length && plans[next].t0 < horizon) live.push(makeVoice(ctx, plans[next++], dest)); };
  const sweep = (now) => {
    let k = 0;
    for (const v of live) { if (v.end < now) { try { v.g.disconnect(); } catch {} } else live[k++] = v; }
    live.length = k;
  };
  if (typeof ctx.startRendering === 'function') {
    // 書き出し：2 秒ごとに止めて、次の 2 秒（＋余裕 0.5 秒）に始まる音を足す
    const C = 2, M = 0.5, base = ctx.currentTime, end = Number.isFinite(ctx.length) ? ctx.length / ctx.sampleRate : Infinity;
    feed(base + C + M);
    const ks = [...new Set(plans.slice(next).map((p) => Math.floor((p.t0 - M) / C)))].sort((a, b) => a - b);
    for (const k of ks) {
      const T = k * C;
      if (T >= end) break;
      if (T <= base + 0.01) { feed(T + C + M); continue; }
      if (!atOfflineTime(ctx, T, () => { if (!stopped) { sweep(T); feed(T + C + M); } })) { feed(Infinity); break; }
    }
  } else {
    // 再生：3 秒先までをつないでおき、0.2 秒ごとに足す。鳴り終わった音は外す
    const LOOK = 3;
    feed(ctx.currentTime + LOOK);
    const tick = () => {
      if (stopped) return;
      if (ctx.state === 'closed') { clearInterval(timer); timer = null; return; }
      sweep(ctx.currentTime - 0.05);
      feed(ctx.currentTime + LOOK);
      if (next >= plans.length && !live.length) { clearInterval(timer); timer = null; }
    };
    timer = setInterval(tick, 200);
  }
  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      for (const v of live) {
        try { v.src.stop(); } catch {}
        try { v.g.disconnect(); } catch {}
      }
      live.length = 0;
      next = plans.length;
    },
    count: plans.length,
  };
}

// 書き出し（OfflineAudioContext）の途中、時刻 t で一度止めて fn を呼び、続ける。同じ時刻は 1 回の suspend にまとめる
// （同じ時刻に suspend を 2 回たのむとエラーになるので、ほかの所でも suspend を使うなら、これを通す）。できなければ false
const hooks = new WeakMap();
export function atOfflineTime(ctx, t, fn) {
  let m = hooks.get(ctx);
  if (!m) hooks.set(ctx, (m = new Map()));
  const q = Math.round((t * ctx.sampleRate) / 128); // 128 サンプルごとの区切りにそろえる
  if (m.has(q)) { m.get(q).push(fn); return true; }
  const list = [fn];
  try {
    const run = () => { for (const f of list) { try { f(); } catch (e) { console.error(e); } } };
    // 止められなかった（書き出しの長さを超える・すでに過ぎた・ほかで同じ時刻を使っている）ときは、すぐに呼ぶ
    ctx.suspend((q * 128) / ctx.sampleRate).then(() => { run(); ctx.resume(); }, run);
  } catch (e) {
    return false;
  }
  m.set(q, list);
  return true;
}

function makeVoice(ctx, p, dest) {
  const src = ctx.createBufferSource();
  src.buffer = p.buffer;
  src.playbackRate.value = p.rate;
  if (p.loop) { src.loop = true; src.loopStart = p.loop[0]; src.loopEnd = p.loop[1]; }
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = p.fc;
  lp.Q.value = 0;
  const g = ctx.createGain();
  const gp = g.gain;
  for (const e of p.gain) {
    if (e[0] === 'set') gp.setValueAtTime(e[1], e[2]);
    else if (e[0] === 'lin') gp.linearRampToValueAtTime(e[1], e[2]);
    else gp.setTargetAtTime(0, e[1], e[2]);
  }
  src.connect(lp).connect(g).connect(dest);
  src.start(p.t0, p.offset);
  src.stop(p.stopAt);
  return { src, g, end: p.stopAt };
}

// ふつうの音
function planNote(ctx, guitar, n, next, o) {
  const s = pickNote(guitar, n.midi);
  if (!s) return null;
  const vel = Math.max(0, Math.min(1, n.vel ?? 0.8)) * (n.stroke === 'up' ? 0.94 : 1);
  if (!(vel > 0)) return null;
  const j1 = jitter(n.t, n.midi, 1), j2 = jitter(n.t, n.midi, 2);
  const rate = Math.pow(2, (n.midi - s.midi) / 12 + (o.tuning - s.cents) / 1200);
  const looped = s.loopStart != null && s.loopEnd != null;
  // 録音の終わり（ループの頭）に着くまでの時間（曲の秒）と、そこからの寿命（-45dB まで）
  const toLoop = looped ? s.loopStart / rate : (s.buffer.duration - 0.01) / rate;
  const env = s.envDecay || 0, dec = Math.max(3, s.decay || 20);
  const life = looped ? toLoop + 45 / dec : toLoop;
  // 止まる時刻：d まで（手で押さえる）・同じ弦の次の音・寿命のうち早いもの。
  // d が次の音のところ（30ms 以内）で終わるなら、手で止めたのではなく弾き直しなので、すぐ消す
  const cut = next < n.t + n.d + 0.03;
  const end = Math.min(n.t + n.d, next, n.t + life);
  const relTau = cut ? 0.012 : 0.07;
  // 途中から鳴らす：その時点まで進めた位置から
  const late = Math.max(0, o.from - n.t);
  if (late >= end - n.t) return null;
  const tn = o.songStart + n.t, t0 = tn + late;
  let offset = late * rate;
  if (looped && offset > s.loopStart) offset = s.loopStart + ((offset - s.loopStart) % (s.loopEnd - s.loopStart));
  if (!looped && offset >= s.buffer.duration - 0.01) return null;
  const fadeIn = late > 0 ? 0.01 : 0.0015;
  const tEnd = Math.max(o.songStart + end, t0 + fadeIn + 0.005);
  // 大きさ：録音の gain × 強さ × 全体。途中からなら、その時点までの減衰を引いておく
  const att = env * Math.min(late, toLoop) + dec * Math.max(0, late - toLoop);
  const amp = s.gain * velAmp(vel) * o.level * (0.96 + 0.08 * j1) * Math.pow(10, -att / 20);
  const gain = [['set', 0, t0], ['lin', amp, t0 + fadeIn]];
  // 減衰：録音の部分は SF2 の減衰だけ足す（録音そのものが減っていくので）。ループに入ったら全部を音量で付ける
  const tLoop = tn + toLoop;
  if (late < toLoop) {
    if (env > 0) gain.push(['tgt', t0 + fadeIn, DB / env]);
    if (looped && tLoop > t0 + fadeIn + 0.001 && tLoop < tEnd) gain.push(['tgt', tLoop, DB / dec]);
  } else {
    gain.push(['tgt', t0 + fadeIn, DB / dec]);
  }
  // 消す：手で押さえる（70ms）／同じ弦の次の音（12ms ＝ 40ms ほどで聞こえなくなる）
  gain.push(['tgt', tEnd, relTau]);
  return {
    t0, buffer: s.buffer, rate, offset,
    loop: looped ? [s.loopStart, s.loopEnd] : null,
    fc: cutoffHz(ctx, vel, n.midi, (n.stroke === 'up' ? 250 : 0) + (j2 - 0.5) * 120),
    gain, stopAt: tEnd + relTau * 8,
  };
}

// ミュートしてはじいた音（空ピッキング・ブラッシング）
function planMute(ctx, guitar, n, next, o) {
  const late = Math.max(0, o.from - n.t);
  if (late > 0.02) return null;
  const vel = Math.max(0, Math.min(1, n.vel ?? 0.8));
  if (!(vel > 0)) return null;
  const j1 = jitter(n.t, n.midi, 1), j2 = jitter(n.t, n.midi, 2);
  const t0 = o.songStart + n.t + late;
  if (guitar.mutes.length) {
    const str = n.string != null ? n.string : stringOf(n.midi);
    const same = guitar.mutes.filter((m) => m.string === str);
    const list = same.length ? same : guitar.mutes;
    const m = list[Math.floor(j1 * list.length) % list.length];
    const amp = m.gain * velAmp(vel) * o.level;
    // 録音そのものが短く消える。d が短くても 0.15 秒は残す（指で止めるまでの響き）
    const tEnd = Math.max(t0 + 0.004, Math.min(t0 + Math.max(n.d, 0.15), t0 + m.length - 0.002, o.songStart + next));
    return {
      t0, buffer: m.buffer, offset: 0, loop: null,
      rate: Math.pow(2, ((j2 - 0.5) * 40) / 1200), // ±20 セントほどゆらす（同じ音が続く感じを消す）
      fc: cutoffHz(ctx, vel, 64, 0),
      gain: [['set', 0, t0], ['lin', amp, t0 + 0.001], ['set', amp, Math.max(t0 + 0.001, tEnd - 0.001)], ['tgt', tEnd, 0.008]],
      stopAt: tEnd + 0.07,
    };
  }
  // 録音がないとき：その高さの音の頭だけを、暗くして 50ms ほどで止める
  const s = pickNote(guitar, n.midi);
  if (!s) return null;
  const amp = s.gain * velAmp(vel) * o.level * 0.9;
  const tEnd = Math.max(t0 + 0.004, Math.min(t0 + 0.12, o.songStart + next));
  return {
    t0, buffer: s.buffer, offset: 0, loop: null,
    rate: Math.pow(2, (n.midi - s.midi) / 12 + (o.tuning - s.cents) / 1200),
    fc: 700 + 1800 * vel,
    gain: [['set', 0, t0], ['lin', amp, t0 + 0.001], ['tgt', t0 + 0.003, 0.02], ['tgt', tEnd, 0.008]],
    stopAt: tEnd + 0.07,
  };
}
