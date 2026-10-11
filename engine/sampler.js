// バイオリンを鳴らす（Web Audio）。再生と書き出しで同じ作りを使う。
export async function loadViolin(ctx, base = '/samples/', onProgress) {
  const man = await fetch(base + 'manifest.json').then((r) => {
    if (!r.ok) throw new Error('バイオリンの音がまだ準備できていません');
    return r.json();
  });
  let done = 0;
  const samples = await Promise.all(
    man.samples.map(async (s) => {
      const ab = await fetch(base + s.file).then((r) => r.arrayBuffer());
      const buffer = await ctx.decodeAudioData(ab);
      done++;
      onProgress && onProgress(done / man.samples.length);
      return { ...s, buffer };
    }),
  );
  const byArt = {};
  // Logic の音：sus / sneak / mrc。フリーの音（VSCO）：arco-p / arco-f（弱・強）と spic-v1 / spic-v2（短い音）、
  // pizz-f（ピチカート）、trem-v1 / trem-v2（トレモロ）
  for (const s of samples) (byArt[s.layer ? `${s.art}-${s.layer}` : s.art] ||= []).push(s);
  for (const k in byArt) byArt[k].sort((a, b) => a.midi - b.midi);
  return { man, samples, byArt, kind: man.kind || 'logic', rr: 0 };
}

function nearest(list, midi, violin) {
  // いちばん近い高さ。同じ高さが複数（弾き直し用の録音）あれば交互に
  let bd = Infinity;
  for (const s of list) bd = Math.min(bd, Math.abs(s.midi - midi));
  const same = list.filter((s) => Math.abs(s.midi - midi) === bd);
  return same[(violin.rr++) % same.length];
}
function pickSample(violin, art, midi, n, legatoIn) {
  if (violin.kind === 'vsco') {
    const B = violin.byArt;
    // ピチカート（はじく）・トレモロ（弓をこまかく往復）
    if (art === 'pizz' && B['pizz-f']) return nearest(B['pizz-f'], midi, violin);
    if (art === 'trem' && (B['trem-v1'] || B['trem-v2'])) return nearest((n.vel < 0.5 ? B['trem-v1'] : B['trem-v2']) || B['trem-v1'] || B['trem-v2'], midi, violin);
    // 短く切る音（刻み・はねる音）は spiccato の録音
    const short = !legatoIn && !n.legato && (n.d < 0.2 || (n.role === 'rhythm' && n.d < 0.4));
    if (short && B['spic-v1']) return nearest(n.vel < 0.5 ? B['spic-v1'] : B['spic-v2'] || B['spic-v1'], midi, violin);
    const soft = art === 'sneak' || (art !== 'mrc' && n.vel < 0.5);
    return nearest((soft ? B['arco-p'] : B['arco-f']) || B['arco-p'] || B['arco-f'], midi, violin);
  }
  // Logic の音にはピチカート・トレモロがないので、短い音（mrc）と長い音（sus）で代わりに鳴らす
  const list = violin.byArt[art === 'pizz' ? 'mrc' : art === 'trem' ? 'sus' : art] || violin.byArt.sus;
  let best = list[0];
  for (const s of list) if (Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
  return best;
}

// 残響（作った響き）
export function makeImpulse(ctx, seconds = 2.3, seed = 7) {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr);
  const ir = ctx.createBuffer(2, n, sr);
  let x = seed;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const pre = Math.floor(0.018 * sr);
  const tau = seconds / 6.9;
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      // 時間がたつほど暗く
      const a = 0.25 + 0.6 * Math.exp(-t / 0.35);
      lp += a * (rnd() - lp);
      d[i] = lp * Math.exp(-t / tau);
    }
    // 初期反射
    for (const [ms, g] of [[11, 0.5], [19, 0.35], [27, 0.3], [41, 0.22], [53, 0.18]]) {
      const i = pre + Math.floor(((ms + c * 3) / 1000) * sr);
      if (i < n) d[i] += g * (c ? -1 : 1);
    }
  }
  return ir;
}

// バイオリン用の音の通り道：低音カット → 少し明るく → 軽い圧縮 → 定位 → 響き
export function makeViolinBus(ctx, dest, opt = {}) {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 170; hp.Q.value = 0.7;
  const pres = ctx.createBiquadFilter();
  pres.type = 'peaking'; pres.frequency.value = 2800; pres.Q.value = 0.9; pres.gain.value = 1.5;
  const air = ctx.createBiquadFilter();
  air.type = 'highshelf'; air.frequency.value = 9000; air.gain.value = -2;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 2.5; comp.attack.value = 0.01; comp.release.value = 0.25;
  const pan = ctx.createStereoPanner();
  pan.pan.value = opt.pan ?? 0.12;
  const dry = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.buffer = makeImpulse(ctx, opt.reverbSeconds ?? 2.3);
  const wet = ctx.createGain();
  wet.gain.value = opt.reverb ?? 0.28;
  const out = ctx.createGain();
  out.gain.value = opt.volume ?? 1;
  input.connect(hp).connect(pres).connect(air).connect(comp);
  comp.connect(pan).connect(dry).connect(out);
  comp.connect(conv).connect(wet).connect(out);
  out.connect(dest);
  return {
    input, out, wet,
    setVolume(v, t = ctx.currentTime) { out.gain.setTargetAtTime(v, t, 0.03); },
    setReverb(v, t = ctx.currentTime) { wet.gain.setTargetAtTime(v, t, 0.03); },
    disconnect() { try { out.disconnect(); } catch {} },
  };
}

const velAmp = (v) => Math.pow(10, ((v - 0.85) * 30) / 20);

// 音符を予約する。songStart: 曲の 0 秒にあたる ctx の時刻。from: 何秒目から鳴らすか
export function scheduleViolin(ctx, violin, notes, dest, opt = {}) {
  const songStart = opt.songStart ?? ctx.currentTime;
  const from = opt.from ?? 0;
  const tuning = opt.tuning ?? 0;
  const nodes = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.t + n.d + 0.3 < from) continue;
    const next = notes[i + 1];
    const nextLegato = !!(next && next.legato && next.t - (n.t + n.d) < 0.03);
    const legatoIn = !!(n.legato && i > 0 && n.t - (notes[i - 1].t + notes[i - 1].d) < 0.03);
    let art = n.art || 'sus';
    if (legatoIn && art === 'sneak') art = 'sus';
    // 重音（n.dbl）：同じ弓で 2 本の弦を鳴らす。下の音は少し小さく
    const voices = n.dbl != null ? [[n.midi, 1], [n.dbl, 0.8]] : [[n.midi, 1]];
    for (const [vMidi, vMul] of voices) {
      const s = pickSample(violin, art, vMidi, n, legatoIn);
      const looped = s.loopStart != null && s.loopEnd != null;
      const pizz = art === 'pizz';
      const fakeTrem = art === 'trem' && s.art !== 'trem'; // トレモロの録音がない音源では、音量をこまかくゆらして近づける
      const rate = Math.pow(2, (vMidi - s.midi) / 12 + (tuning - s.cents) / 1200);
      // 時刻
      let t0 = songStart + n.t;
      let offset = 0;
      if (legatoIn && art !== 'mrc' && looped) offset = Math.min(0.2, s.loopStart * 0.5); // 弓を返さずにつなぐ：立ち上がりを飛ばす
      const lateBy = from - n.t;
      if (lateBy > 0) { t0 = songStart + from; offset += lateBy * rate; }
      if (looped && offset > s.loopStart) offset = s.loopStart + ((offset - s.loopStart) % (s.loopEnd - s.loopStart));
      if (!looped && offset >= s.buffer.duration - 0.02) continue;
      let dur = Math.max(0.03, n.d - Math.max(0, lateBy));
      // ピチカートは、はじいた音が自然に消えるまで（次の音まで）鳴らす
      if (pizz) dur = Math.min(Math.max(dur, 0.35), s.art === 'pizz' ? (s.buffer.duration - offset) / rate : 0.18);
      const tEnd = t0 + dur;
      const src = ctx.createBufferSource();
      src.buffer = s.buffer;
      src.loop = looped;
      if (looped) { src.loopStart = s.loopStart; src.loopEnd = s.loopEnd; }
      const pr = src.playbackRate;
      pr.setValueAtTime(rate, t0);
      if (lateBy <= 0 && !pizz) {
        if (n.bend) {
          // チョーキングのように、下からゆっくりずり上げる
          pr.setValueAtTime(rate * Math.pow(2, -n.bend / 12), t0);
          pr.linearRampToValueAtTime(rate, t0 + Math.min(0.17, dur * 0.45));
        } else if (n.slide) {
          pr.setValueAtTime(rate * Math.pow(2, n.slide / 12), t0);
          pr.exponentialRampToValueAtTime(rate, t0 + Math.min(0.11, dur * 0.4));
        } else if (n.grace) {
          pr.setValueAtTime(rate * Math.pow(2, n.grace / 12), t0);
          pr.setValueAtTime(rate, t0 + Math.min(0.05, dur * 0.3));
        }
        if (n.trill && dur > 0.5) {
          const up = rate * Math.pow(2, n.trill / 12);
          let k = 0;
          for (let t = t0 + dur * 0.3; t < tEnd - 0.1; t += 0.068, k++) pr.setValueAtTime(k % 2 ? rate : up, t);
          pr.setValueAtTime(rate, tEnd - 0.1);
        }
      }
      // 明るさ（弱い音ほど暗く）
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800 + 9500 * Math.pow(n.vel, 1.5);
      lp.Q.value = 0.6;
      const g = ctx.createGain();
      const level = s.gain * velAmp(n.vel) * (opt.level ?? 1) * vMul;
      const attack = pizz ? 0.002 : legatoIn ? 0.045 : art === 'mrc' || s.art === 'spic' ? 0.004 : art === 'sneak' ? 0.02 : 0.02;
      const gp = g.gain;
      gp.setValueAtTime(0, t0);
      const startK = n.shape === 'swell' && dur > 0.6 ? 0.62 : n.shape === 'cresc' && dur > 0.4 ? 0.45 : 1; // 山なり・だんだん強くは、小さく入る
      gp.linearRampToValueAtTime(level * startK, t0 + attack);
      if (n.shape === 'swell' && dur > 0.6) {
        // 長い音は、小さく入ってふくらみ、少しおさめる（弦の打ち込みでいちばん効く、と多くの講座が言う山なりの抑揚）
        gp.linearRampToValueAtTime(level * 1.05, t0 + dur * 0.55);
        gp.linearRampToValueAtTime(level * 0.8, tEnd);
      } else if (n.shape === 'cresc' && dur > 0.4) {
        // だんだん強く（Bメロの終わり・イントロの保続音）
        gp.linearRampToValueAtTime(level * 1.15, tEnd);
      } else if (n.shape === 'fade') {
        gp.setValueAtTime(level, t0 + Math.min(dur * 0.25, 0.6));
        gp.exponentialRampToValueAtTime(Math.max(1e-4, level * 0.03), tEnd);
      } else {
        gp.setValueAtTime(level, Math.max(t0 + attack, tEnd - 0.01));
      }
      if (fakeTrem && dur > 0.3) {
        // 1 秒に 13 回ほど、音量を 0.55〜1 倍でゆらす
        for (let t = t0 + attack, k = 0; t < tEnd - 0.04; t += 0.038, k++) gp.setValueAtTime(level * (k % 2 ? 0.55 : 1), t);
        gp.setValueAtTime(level, tEnd - 0.04);
      }
      const tau = pizz ? 0.05 : nextLegato ? 0.03 : dur < 0.3 ? 0.06 : 0.13;
      gp.setTargetAtTime(0, tEnd, tau);
      src.connect(lp).connect(g).connect(dest);
      // 頂点などはビブラートを少し足す
      let osc = null;
      if (n.vib && dur > 0.6 && !pizz) {
        osc = ctx.createOscillator();
        osc.frequency.value = 5.6;
        const vg = ctx.createGain();
        vg.gain.setValueAtTime(0, t0);
        vg.gain.linearRampToValueAtTime(rate * 0.008, t0 + Math.min(0.7, dur * 0.5));
        osc.connect(vg).connect(pr);
        osc.start(t0);
        osc.stop(tEnd + tau * 7);
      }
      src.start(t0, offset);
      src.stop(tEnd + tau * 7);
      nodes.push({ src, g, osc });
    }
  }
  return {
    stop() {
      for (const x of nodes) {
        try { x.src.stop(); } catch {}
        try { x.osc && x.osc.stop(); } catch {}
        try { x.g.disconnect(); } catch {}
      }
    },
    count: nodes.length,
  };
}

// 曲＋バイオリンを書き出す（OfflineAudioContext）
export async function renderMix({ song, violin, notes, includeSong = true, includeViolin = true, songVolume = 1, violinVolume = 1, reverb = 0.28, tuning = 0, violinLevel = 1, tail = 2.5, sampleRate = 44100 }) {
  const len = Math.ceil((song.duration + tail) * sampleRate);
  const oc = new OfflineAudioContext(2, len, sampleRate);
  const limiter = oc.createDynamicsCompressor();
  limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.1;
  limiter.connect(oc.destination);
  if (includeSong) {
    const s = oc.createBufferSource();
    s.buffer = song;
    const g = oc.createGain();
    g.gain.value = songVolume;
    s.connect(g).connect(limiter);
    s.start(0);
  }
  if (includeViolin) {
    const bus = makeViolinBus(oc, limiter, { reverb, volume: violinVolume });
    scheduleViolin(oc, violin, notes, bus.input, { songStart: 0, from: 0, tuning, level: violinLevel });
  }
  return oc.startRendering();
}

// 曲の大きさ（大きい部分の RMS）から、バイオリンの基準の大きさを決める
export function loudnessOf(buffer) {
  const ch = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) ch.push(buffer.getChannelData(c));
  const n = buffer.length, hop = Math.floor(buffer.sampleRate * 0.4);
  const vals = [];
  for (let i = 0; i + hop <= n; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j += 4) for (const d of ch) s += d[j] * d[j];
    vals.push(Math.sqrt(s / ((hop / 4) * ch.length)));
  }
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.8)] || 0.1;
}
