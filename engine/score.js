// 楽譜：バイオリンの音を、拍と小節にそろえて（16分音符の細かさで）楽譜の形にする。
// ・音価の分け方（拍をまたぐ音はタイでつなぐ） ・調号と臨時記号 ・区間名・強弱・コードネーム
import { QUALITIES, pcName } from './analyze.js';
import { ROLE_LABEL, TYPE_LABEL } from './compose.js';

const Q = 4; // 1拍 = 16分音符 4 つ

// 秒 → 拍（an.beats[0] が 0 拍）
export function beatMapper(beats) {
  const nb = beats.length;
  const T0 = nb > 1 ? beats[1] - beats[0] : 0.5;
  const Tl = nb > 1 ? beats[nb - 1] - beats[nb - 2] : 0.5;
  return (t) => {
    if (t <= beats[0]) return (t - beats[0]) / T0;
    if (t >= beats[nb - 1]) return nb - 1 + (t - beats[nb - 1]) / Tl;
    let lo = 0, hi = nb - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beats[m] <= t) lo = m; else hi = m; }
    return lo + (t - beats[lo]) / (beats[lo + 1] - beats[lo]);
  };
}

// 調号（♯の数＋、♭の数－）
const MAJOR_FIFTHS = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5 };
export function keyFifths(key) {
  const majTonic = key.mode === 'min' ? (key.tonic + 3) % 12 : key.tonic;
  return MAJOR_FIFTHS[majTonic];
}
const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_PC = [0, 2, 4, 5, 7, 9, 11];
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
export function keyAlters(fifths) {
  const a = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  if (fifths > 0) for (let i = 0; i < fifths; i++) a[SHARP_ORDER[i]] = 1;
  if (fifths < 0) for (let i = 0; i < -fifths; i++) a[FLAT_ORDER[i]] = -1;
  return a;
}
// 音名のつづり（調に合わせる）
export function spell(midi, fifths) {
  const pc = ((midi % 12) + 12) % 12;
  const ka = keyAlters(fifths);
  // まず調号どおりの音で表せるか
  for (let i = 0; i < 7; i++) {
    const s = STEPS[i];
    if ((STEP_PC[i] + ka[s] + 12) % 12 === pc) return mk(s, ka[s], midi);
  }
  // 臨時記号：♯系の調は♯、♭系の調は♭で
  if (fifths >= 0) {
    for (let i = 0; i < 7; i++) if ((STEP_PC[i] + 1) % 12 === pc) return mk(STEPS[i], 1, midi);
  } else {
    for (let i = 0; i < 7; i++) if ((STEP_PC[i] + 11) % 12 === pc) return mk(STEPS[i], -1, midi);
  }
  for (let i = 0; i < 7; i++) if (STEP_PC[i] === pc) return mk(STEPS[i], 0, midi);
  return mk('C', 0, midi);
}
function mk(step, alter, midi) {
  // オクターブ：音名の基準の高さから求める（B#・Cb のずれも扱う）
  const base = STEP_PC[STEPS.indexOf(step)] + alter;
  const octave = Math.round((midi - base) / 12) - 1;
  return { step, alter, octave, midi };
}

const TYPE_OF = { 1: ['16th', 0], 2: ['eighth', 0], 3: ['eighth', 1], 4: ['quarter', 0], 6: ['quarter', 1], 7: ['quarter', 2], 8: ['half', 0], 12: ['half', 1], 14: ['half', 2], 16: ['whole', 0], 24: ['whole', 1] };

// 小節の中の位置 p（16分単位）から始まる長さ L を、読みやすい音価に分ける
function splitDur(p, L, barLen, meter, isRest) {
  const out = [];
  while (L > 0) {
    let v = 0;
    const inBeat = p % Q;
    if (isRest && p === 0 && L === barLen) v = barLen; // 全休符（1小節）
    else if (inBeat !== 0) {
      // 拍の途中：次の拍をまたがない
      const toBeat = Q - inBeat;
      const cands = [3, 2, 1].filter((x) => x <= Math.min(L, toBeat) && !(x === 3 && inBeat !== 1) && !(x === 2 && inBeat % 2 !== 0));
      v = cands[0] || 1;
    } else {
      const cands = [];
      if (meter === 4) {
        if (p === 0) cands.push(16, 12);
        if (p % 8 === 0) cands.push(8, 6);
        cands.push(4);
      } else if (meter === 3) {
        if (p === 0) cands.push(12, 8, 6);
        if (p === 4) cands.push(8);
        cands.push(4);
      } else {
        if (p % 8 === 0) cands.push(8);
        cands.push(4);
      }
      if (isRest) for (let i = cands.length - 1; i >= 0; i--) if (TYPE_OF[cands[i]][1]) cands.splice(i, 1); // 休符に付点は使わない
      v = cands.find((x) => x <= L && p + x <= barLen) || 0;
      if (!v) {
        // 拍より短い
        v = [3, 2, 1].find((x) => x <= L) || 1;
        if (v === 3 && isRest) v = 2;
      }
    }
    if (!TYPE_OF[v]) v = [16, 12, 8, 6, 4, 3, 2, 1].find((x) => x <= v) || 1;
    out.push({ p, dur: v });
    p += v;
    L -= v;
  }
  return out;
}

function dynMark(v) {
  return v < 0.3 ? 'pp' : v < 0.45 ? 'p' : v < 0.6 ? 'mp' : v < 0.75 ? 'mf' : 'f';
}

const KIND = { maj: 'major', min: 'minor', dom7: 'dominant', maj7: 'major-seventh', min7: 'minor-seventh' };

export function buildScore(an, notes, plan, opt = {}) {
  const meter = an.meter || 4;
  const toBeat = beatMapper(an.beats);
  // 1. 16分の格子にそろえる
  let ev = notes.map((n) => {
    const s = Math.round(toBeat(n.t) * Q);
    let e = Math.round(toBeat(n.t + n.d) * Q);
    if (e <= s) e = s + 1;
    return { s, e, n };
  }).sort((a, b) => a.s - b.s);
  for (let i = 0; i + 1 < ev.length; i++) {
    const a = ev[i], b = ev[i + 1];
    if (b.s <= a.s) { b.s = a.s + 1; if (b.e <= b.s) b.e = b.s + 1; }
    if (a.e > b.s) a.e = b.s;
    // 16分以下のすき間は、前の音をのばしてうめる（細かい休符で読みにくくしない）
    if (b.s - a.e === 1 && a.e - a.s >= 2) a.e = b.s;
  }
  ev = ev.filter((x) => x.e > x.s);
  // 2. 小節ごと
  const bars = an.bars;
  const firstBeat = bars.length ? bars[0].b0 : 0;
  const measures = [];
  let ei = 0;
  let prevFifths = null, prevDyn = null;
  const secStart = new Map();
  an.sections.forEach((s, i) => secStart.set(s.bar0, i));
  // 調の決め方：小節の調（解析）をそのまま
  bars.forEach((bar, bi) => {
    const barLen = bar.n * Q;
    const B0 = bar.b0 * Q, B1 = B0 + barLen;
    const key = an.keyPerBar[bi] || an.key;
    const fifths = keyFifths(key);
    const m = { index: bi, b0: bar.b0, number: bar.pickup ? 0 : bi + (bars[0].pickup ? 0 : 1), pickup: !!bar.pickup, beats: bar.n, barLen, t0: bar.t0, fifths, mode: key.mode, keyChange: fifths !== prevFifths, events: [], marks: [], chords: [] };
    prevFifths = fifths;
    // 区間の始まり
    if (secStart.has(bi)) {
      const si = secStart.get(bi);
      const s = an.sections[si];
      const p = plan && plan[si];
      m.section = { name: `${TYPE_LABEL[s.type]}${s.n}`, role: p ? ROLE_LABEL[p.role] : '', rest: p && p.role === 'rest' };
      const secNotes = notes.filter((n) => n.sec === si);
      if (secNotes.length) {
        const avg = secNotes.reduce((a, n) => a + n.vel, 0) / secNotes.length;
        const d = dynMark(avg);
        if (d !== prevDyn) { m.dynamic = d; prevDyn = d; }
      }
    }
    // コードネーム（変わったところだけ）
    let lastName = measures.length ? measures[measures.length - 1].lastChord : null;
    for (let k = 0; k < bar.n; k++) {
      const ch = an.chords[bar.b0 + k];
      const name = ch ? pcName(ch.root, key) + QUALITIES[ch.q].suffix : null;
      if (name && name !== lastName) m.chords.push({ pos: k * Q, name, root: spell(60 + ch.root, fifths), kind: KIND[ch.q] || 'major' });
      if (name) lastName = name;
    }
    m.lastChord = lastName;
    // 音と休符
    let p = B0;
    while (ei < ev.length && ev[ei].e <= B0) ei++;
    const evs = [];
    for (let j = ei; j < ev.length && ev[j].s < B1; j++) evs.push(ev[j]);
    for (const x of evs) {
      const s = Math.max(B0, x.s), e = Math.min(B1, x.e);
      if (s > p) for (const r of splitDur(p - B0, s - p, barLen, meter, true)) m.events.push({ rest: true, pos: r.p, dur: r.dur });
      const parts = splitDur(s - B0, e - s, barLen, meter, false);
      const pitch = spell(x.n.midi, fifths);
      parts.forEach((pt, k) => {
        m.events.push({
          rest: false, pos: pt.p, dur: pt.dur, pitch,
          tieStop: k > 0 || x.s < B0, tieStart: k < parts.length - 1 || x.e > B1,
          first: k === 0 && x.s >= B0, n: x.n,
        });
      });
      p = e;
    }
    if (p < B1) for (const r of splitDur(p - B0, B1 - p, barLen, meter, true)) m.events.push({ rest: true, pos: r.p, dur: r.dur });
    // 臨時記号（小節の中で、調号やそれまでの音と違うときだけ）
    const ka = keyAlters(fifths);
    const state = {};
    for (const e of m.events) {
      if (e.rest) continue;
      const k = e.pitch.step + e.pitch.octave;
      const cur = k in state ? state[k] : ka[e.pitch.step];
      if (e.tieStop && !e.first) { state[k] = e.pitch.alter; continue; }
      if (e.pitch.alter !== cur) e.accidental = e.pitch.alter === 1 ? 'sharp' : e.pitch.alter === -1 ? 'flat' : 'natural';
      state[k] = e.pitch.alter;
    }
    // 連桁（8分・16分を拍ごとにまとめる）
    let group = [];
    const flush = () => {
      if (group.length >= 2) group.forEach((e, i) => (e.beam = i === 0 ? 'begin' : i === group.length - 1 ? 'end' : 'continue'));
      group = [];
    };
    for (const e of m.events) {
      const short = !e.rest && e.dur < Q && TYPE_OF[e.dur][0] !== 'quarter';
      const beat = Math.floor(e.pos / Q);
      if (!short) { flush(); continue; }
      if (group.length && Math.floor(group[0].pos / Q) !== beat) flush();
      group.push(e);
      if ((e.pos + e.dur) % Q === 0) flush();
    }
    flush();
    // 記号（トリル・すべり上げ）
    for (const e of m.events) {
      if (e.rest || !e.first) continue;
      if (e.n.trill) e.trill = true;
      if (e.n.slide || e.n.bend) e.slide = true;
      if (e.n.grace) e.grace = spell(e.n.midi + e.n.grace, fifths);
      if (e.n.art === 'mrc' && e.dur <= 2) e.accent = true;
    }
    for (const e of m.events) e.type = TYPE_OF[e.dur][0], e.dots = TYPE_OF[e.dur][1];
    measures.push(m);
  });
  // 前の小節から続くタイで、最初の音が前の小節にあるもの
  void firstBeat;
  const bpm = an.bpm;
  return { title: opt.title || 'Violin', meter, bpm: Math.round(bpm), steady: an.steadyTempo, measures, keyFirst: measures[0]?.fifths ?? 0 };
}

// ───────────────────────── MusicXML
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function scoreToMusicXML(score) {
  const div = Q; // 4分音符 = 4
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="3.1">');
  out.push(`<work><work-title>${esc(score.title)}</work-title></work>`);
  out.push('<identification><creator type="composer">AIバイオリニスト</creator><encoding><software>AIバイオリニスト</software></encoding></identification>');
  out.push('<part-list><score-part id="P1"><part-name>Violin</part-name><score-instrument id="P1-I1"><instrument-name>Violin</instrument-name></score-instrument><midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>41</midi-program></midi-instrument></score-part></part-list>');
  out.push('<part id="P1">');
  score.measures.forEach((m, mi) => {
    out.push(`<measure number="${m.number}"${m.pickup ? ' implicit="yes"' : ''}>`);
    if (mi === 0 || m.keyChange) {
      out.push('<attributes>');
      if (mi === 0) out.push(`<divisions>${div}</divisions>`);
      out.push(`<key><fifths>${m.fifths}</fifths><mode>${m.mode === 'min' ? 'minor' : 'major'}</mode></key>`);
      if (mi === 0) out.push(`<time><beats>${score.meter}</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef>`);
      out.push('</attributes>');
    }
    if (mi === 0) out.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.bpm}</per-minute></metronome></direction-type><sound tempo="${score.bpm}"/></direction>`);
    if (m.section) out.push(`<direction placement="above"><direction-type><rehearsal font-weight="bold">${esc(m.section.name)}</rehearsal></direction-type></direction>`, m.section.role ? `<direction placement="above"><direction-type><words font-size="9">${esc(m.section.role)}</words></direction-type></direction>` : '');
    if (m.dynamic) out.push(`<direction placement="below"><direction-type><dynamics><${m.dynamic}/></dynamics></direction-type></direction>`);
    let pos = 0;
    let ci = 0;
    for (const e of m.events) {
      while (ci < m.chords.length && m.chords[ci].pos <= e.pos) {
        const c = m.chords[ci];
        // コードの位置が音の途中なら、そこまで進める（offset）
        const off = c.pos - pos;
        out.push(`<harmony print-frame="no"><root><root-step>${c.root.step}</root-step>${c.root.alter ? `<root-alter>${c.root.alter}</root-alter>` : ''}</root><kind text="${esc(c.name.replace(/^[A-G][#b]?/, ''))}">${c.kind}</kind>${off ? `<offset>${off}</offset>` : ''}</harmony>`);
        ci++;
      }
      if (e.grace) out.push(`<note><grace slash="yes"/><pitch><step>${e.grace.step}</step>${e.grace.alter ? `<alter>${e.grace.alter}</alter>` : ''}<octave>${e.grace.octave}</octave></pitch><voice>1</voice><type>16th</type><stem>up</stem></note>`);
      const parts = ['<note>'];
      if (e.rest) parts.push(e.dur === m.barLen ? '<rest measure="yes"/>' : '<rest/>');
      else parts.push(`<pitch><step>${e.pitch.step}</step>${e.pitch.alter ? `<alter>${e.pitch.alter}</alter>` : ''}<octave>${e.pitch.octave}</octave></pitch>`);
      parts.push(`<duration>${e.dur}</duration>`);
      if (!e.rest && e.tieStop) parts.push('<tie type="stop"/>');
      if (!e.rest && e.tieStart) parts.push('<tie type="start"/>');
      parts.push('<voice>1</voice>');
      if (!(e.rest && e.dur === m.barLen)) parts.push(`<type>${e.type}</type>`);
      for (let d = 0; d < e.dots; d++) parts.push('<dot/>');
      if (e.accidental) parts.push(`<accidental>${e.accidental}</accidental>`);
      if (e.beam) parts.push(`<beam number="1">${e.beam}</beam>${e.type === '16th' ? `<beam number="2">${e.beam}</beam>` : ''}`);
      const nots = [];
      if (!e.rest && e.tieStop) nots.push('<tied type="stop"/>');
      if (!e.rest && e.tieStart) nots.push('<tied type="start"/>');
      const orn = [];
      if (e.trill) orn.push('<trill-mark/>');
      if (orn.length) nots.push(`<ornaments>${orn.join('')}</ornaments>`);
      if (e.accent) nots.push('<articulations><accent/></articulations>');
      if (e.slide) nots.push('<articulations><scoop/></articulations>');
      if (nots.length) parts.push(`<notations>${nots.join('')}</notations>`);
      parts.push('</note>');
      out.push(parts.join(''));
      pos = e.pos + e.dur;
    }
    if (mi === score.measures.length - 1) out.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
    out.push('</measure>');
  });
  out.push('</part>');
  out.push('</score-partwise>');
  return out.filter(Boolean).join('\n');
}

// 楽譜にそろえた音（MIDI 用）：拍の位置と長さ（拍）。タイはつなげて1音に
export function quantizedNotes(score) {
  const list = [];
  let open = null;
  for (const m of score.measures) {
    for (const e of m.events) {
      if (e.rest) { open = null; continue; }
      if (e.tieStop && open && open.midi === e.pitch.midi) {
        open.dur += e.dur / Q;
        if (!e.tieStart) open = null;
        continue;
      }
      const it = { beat: m.b0 + e.pos / Q, dur: e.dur / Q, midi: e.pitch.midi, vel: e.n.vel };
      list.push(it);
      open = e.tieStart ? it : null;
    }
  }
  return list;
}

// 拍 → 秒
export function beatToTime(beats, b) {
  const nb = beats.length;
  if (b <= 0) return beats[0] + b * (nb > 1 ? beats[1] - beats[0] : 0.5);
  const i = Math.floor(b);
  if (i + 1 < nb) return beats[i] + (beats[i + 1] - beats[i]) * (b - i);
  const T = nb > 1 ? beats[nb - 1] - beats[nb - 2] : 0.5;
  return beats[nb - 1] + T * (b - (nb - 1));
}
