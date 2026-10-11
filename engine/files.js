// 書き出し：WAV と MIDI（Logic にそのまま入れられるよう、拍の位置をテンポ情報として入れる）

export function audioBufferToWav(buf) {
  const ch = Math.min(2, buf.numberOfChannels);
  const n = buf.length, sr = buf.sampleRate;
  const out = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(out);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, data[c][i]));
      v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true);
      o += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

function vlq(n) {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return bytes;
}
function chunk(id, body) {
  const len = body.length;
  return [...id].map((c) => c.charCodeAt(0)).concat([(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255], body);
}
function textEvent(type, s) {
  const bytes = Array.from(new TextEncoder().encode(s));
  return [0xff, type, ...vlq(bytes.length), ...bytes];
}

// 秒 → MIDI の拍（小数）。曲の最初の小節の頭が、MIDI の小節線にぴったり来るようにする。
// 曲の頭（0 秒）から最初の拍までは「前置き」の拍として、その長さに合わせたテンポを入れる。
export function makeTimeMap(beats, bars = [], meter = 4) {
  const nb = beats.length;
  const T0 = nb > 1 ? beats[1] - beats[0] : 0.5;
  const first = bars.find((b) => !b.pickup);
  const barStartBeat = first ? first.b0 : 0; // 最初の小節の頭（拍の番号）
  // 前置きの拍数（ごく短いとき＝0.07 秒未満は、ずれが小さいので前置きなし）
  const pre = beats[0] < 0.07 ? 0 : Math.max(1, Math.round(beats[0] / T0));
  const leadBeats = pre + barStartBeat; // 最初の小節の頭までの MIDI の拍数（この長さの拍子の小節を1つ置く）
  const toBeat = (t) => {
    if (t <= beats[0]) return pre > 0 && beats[0] > 0 ? (pre * t) / beats[0] : 0;
    let lo = 0, hi = nb - 1;
    if (t >= beats[hi]) return pre + hi + (t - beats[hi]) / (beats[hi] - beats[hi - 1]);
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beats[m] <= t) lo = m; else hi = m; }
    return pre + lo + (t - beats[lo]) / (beats[lo + 1] - beats[lo]);
  };
  return { toBeat, pre, T0, preTempo: pre > 0 ? beats[0] / pre : T0, leadBeats };
}

export function notesToMidi(notes, an, opt = {}) {
  const PPQ = 480;
  const beats = an.beats;
  const meter = an.meter || 4;
  const { toBeat, pre, T0, preTempo, leadBeats } = makeTimeMap(beats, an.bars, meter);
  const tick = (t) => Math.max(0, Math.round(toBeat(t) * PPQ));
  // テンポ（拍ごと。変わらなければ出さない）
  const tempoEvents = [];
  const pushTempo = (atTick, secPerBeat) => {
    const us = Math.max(1, Math.round(secPerBeat * 1e6));
    const last = tempoEvents[tempoEvents.length - 1];
    if (last && Math.abs(last.us - us) / us < 0.0005) return;
    tempoEvents.push({ tick: atTick, us });
  };
  pushTempo(0, pre > 0 ? preTempo : T0);
  for (let i = 0; i + 1 < beats.length; i++) pushTempo(Math.round((pre + i) * PPQ), beats[i + 1] - beats[i]);
  const t0 = [];
  let last = 0;
  const ev = (tk, bytes) => { t0.push(...vlq(tk - last), ...bytes); last = tk; };
  ev(0, textEvent(0x03, opt.title || 'AI Violinist'));
  // 拍子：前置きが半端な長さなら、その長さの小節（例 1/4）を最初に置き、曲の最初の小節から本来の拍子
  const meta = tempoEvents.map((te) => ({ tick: te.tick, bytes: [0xff, 0x51, 0x03, (te.us >> 16) & 255, (te.us >> 8) & 255, te.us & 255] }));
  if (leadBeats % meter !== 0) {
    meta.push({ tick: 0, ts: true, bytes: [0xff, 0x58, 0x04, leadBeats, 2, 24, 8] });
    meta.push({ tick: leadBeats * PPQ, ts: true, bytes: [0xff, 0x58, 0x04, meter, 2, 24, 8] });
  } else meta.push({ tick: 0, ts: true, bytes: [0xff, 0x58, 0x04, meter, 2, 24, 8] });
  meta.sort((a, b) => a.tick - b.tick || (b.ts ? 1 : 0) - (a.ts ? 1 : 0));
  for (const e of meta) ev(e.tick, e.bytes);
  ev(last, [0xff, 0x2f, 0x00]);
  // 音符
  const list = [];
  let techNow = 'arco';
  for (const n of notes) {
    const a = tick(n.t), b = Math.max(a + 1, tick(n.t + n.d));
    // 弓で弾く／はじく／トレモロの切りかえは、文字のイベントで残す（DAW の画面に出る）
    const tech = n.art === 'pizz' ? 'pizz.' : n.art === 'trem' ? 'trem.' : 'arco';
    if (tech !== techNow) { list.push({ tk: a, order: 0.5, bytes: textEvent(0x01, tech) }); techNow = tech; }
    const vel = Math.max(1, Math.min(127, Math.round(25 + 100 * n.vel)));
    list.push({ tk: a, order: 1, bytes: [0x90, n.midi, vel] });
    list.push({ tk: b, order: 0, bytes: [0x80, n.midi, 0] });
    if (n.dbl != null) { list.push({ tk: a, order: 1, bytes: [0x90, n.dbl, Math.max(1, vel - 8)] }); list.push({ tk: b, order: 0, bytes: [0x80, n.dbl, 0] }); }
  }
  list.sort((x, y) => x.tk - y.tk || x.order - y.order);
  const trackOf = (name, program, ch, evs) => {
    const tr = [];
    let lt = 0;
    const put = (tk, bytes) => { tr.push(...vlq(tk - lt), ...bytes); lt = tk; };
    put(0, textEvent(0x03, name));
    put(0, [0xc0 | ch, program]);
    for (const e of evs) put(e.tk, e.bytes.length === 3 && (e.bytes[0] & 0xe0) === 0x80 ? [(e.bytes[0] & 0xf0) | ch, e.bytes[1], e.bytes[2]] : e.bytes);
    put(lt, [0xff, 0x2f, 0x00]);
    return tr;
  };
  const tracks = [trackOf('Violin', 40, 0, list)];
  // ほかの楽器（再アレンジのアコギなど）：{ name, program（GM 番号 0〜127）, channel, notes: [{ t, d, midi, vel }] }
  for (const xt of opt.extraTracks || []) {
    const evs = [];
    for (const n of xt.notes) {
      const a = tick(n.t), b = Math.max(a + 1, tick(n.t + n.d));
      const vel = Math.max(1, Math.min(127, Math.round(20 + 100 * n.vel)));
      evs.push({ tk: a, order: 1, bytes: [0x90, n.midi, vel] }, { tk: b, order: 0, bytes: [0x80, n.midi, 0] });
    }
    evs.sort((x, y) => x.tk - y.tk || x.order - y.order);
    tracks.push(trackOf(xt.name, xt.program ?? 25, xt.channel ?? tracks.length, evs));
  }
  const header = chunk('MThd', [0, 1, 0, 1 + tracks.length, (PPQ >> 8) & 255, PPQ & 255]);
  const bytes = new Uint8Array([...header, ...chunk('MTrk', t0), ...tracks.flatMap((tr) => chunk('MTrk', tr))]);
  return new Blob([bytes], { type: 'audio/midi' });
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
