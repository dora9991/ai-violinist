// ソロ（間奏・イントロ・アウトロ）：ギタリストの実際のソロ（GuitarSet）から学んだフレーズを、この曲のコードに合わせて置きかえる
//  ・フレーズのリズムと入る位置（裏拍から入る、など）は、そのまま使う
//  ・音の高さは「その時のコードに対して何度の音か」を守って置きかえる（3度だった音は、新しいコードの 3度へ）
//  ・コードの音でない音は「調の何番目の音か」で置きかえる。上がる／下がるの形（輪郭）は保つ
//  ・フレーズとフレーズの間は休む（息つぎ）。だんだん音が増え、高くなり、最後は長い音で決める
import { MAJOR_SCALE, MINOR_SCALE } from './analyze.js';

let PHR = null;
export function setPhrases(json) {
  if (!json || !json.phrases) { PHR = null; return; }
  // 小さい形（配列）でも、ふつうの形でも読む
  const norm = (n) => (Array.isArray(n) ? { o: n[0], d: n[1], role: n[2] < 0 ? null : n[2], ct: !!n[3], deg: n[4], iv: n[5] } : n);
  const list = json.phrases.map((p) => ({ ...p, notes: p.notes.map(norm) })).filter((p) => p.notes.length >= 3 && p.lenQ >= 4).map(straighten);
  // 倍の速さ版（8 分以上だけのフレーズを 16 分に）：「激しく」で使う
  const fast = list.filter((p) => p.notes.every((n) => n.o % 2 === 0 && n.d % 2 === 0) && p.lenQ >= 8).map((p) => ({
    ...p, lenQ: p.lenQ / 2, barPos: Math.round(p.barPos * 2) / 4 * 2 / 2, double: true,
    notes: p.notes.map((n) => ({ ...n, o: n.o / 2, d: n.d / 2 })),
  }));
  PHR = { list, fast, source: json.source, license: json.license };
}
// 付点 8 分＋16 分（タッカ）は、8 分 2 つに直す（不自然に聞こえやすいので）
function straighten(p) {
  const notes = p.notes.map((n) => ({ ...n }));
  for (let i = 0; i + 1 < notes.length; i++) {
    const a = notes[i], b = notes[i + 1];
    if (a.d === 3 && b.o === a.o + 3 && b.d === 1 && a.o % 2 === 0) { a.d = 2; b.o = a.o + 2; b.d = 2; }
  }
  return { ...p, notes };
}
export function phraseInfo() {
  return PHR ? { count: PHR.list.length, source: PHR.source } : null;
}

const pcOf = (m) => ((m % 12) + 12) % 12;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function pentatonic(key) {
  const base = key.mode === 'min' ? MINOR_SCALE : MAJOR_SCALE;
  const drop = key.mode === 'min' ? [1, 5] : [3, 6];
  return base.map((iv, i) => (drop.includes(i) ? null : (key.tonic + iv) % 12)).filter((v) => v != null);
}

// コードに対する役割（元のフレーズ）→ この曲のコードの同じ役割の音
function roleToPc(role, ctx, x) {
  const an = ctx.an;
  const ch = an.chords[clamp(Math.floor(x + 1e-6), 0, an.chords.length - 1)];
  const scale = ctx.scalePcs(x);
  const root = ch ? ch.root : ctx.chordRoot(x);
  const minor = ch ? ch.q === 'min' || ch.q === 'min7' : !scale.includes((root + 4) % 12);
  const inKey = (iv) => scale.includes((root + iv) % 12);
  switch (role) {
    case 0: return root;
    case 3: case 4: return (root + (minor ? 3 : 4)) % 12;
    case 7: case 6: case 8: return (root + 7) % 12;
    case 10: case 11: {
      // 7度：コードに 7度があればそれ、なければ調に合う方の 7度、どちらもなければ根音
      if (ch && ch.q === 'maj7') return (root + 11) % 12;
      if (ch && (ch.q === 'dom7' || ch.q === 'min7')) return (root + 10) % 12;
      if (inKey(10)) return (root + 10) % 12;
      if (inKey(11)) return (root + 11) % 12;
      return root;
    }
    case 2: return inKey(2) ? (root + 2) % 12 : root; // 9度
    case 9: return inKey(9) ? (root + 9) % 12 : (root + 7) % 12; // 6度
    case 5: return inKey(5) ? (root + 5) % 12 : (root + (minor ? 3 : 4)) % 12; // 4度（11度）
    default: return root;
  }
}
// 調の何番目の音か（元の調）→ この曲の調の同じ番目の音
function degreeToPc(deg, origMode, key) {
  const o = origMode === 'min' ? MINOR_SCALE : MAJOR_SCALE;
  const nw = key.mode === 'min' ? MINOR_SCALE : MAJOR_SCALE;
  const i = o.indexOf(deg);
  if (i >= 0) return (key.tonic + nw[i]) % 12;
  // 音階の外（ブルーノートなど）：すぐ下の音階の音から同じだけずらす
  let j = 0;
  for (let k = 0; k < 7; k++) if (o[k] < deg) j = k;
  return (key.tonic + nw[j] + (deg - o[j])) % 12;
}
// pc の音のうち、ref にいちばん近いもの（dir があれば、prev からその向きへ）
function place(pc, ref, prev, dir, lo, hi) {
  let best = null, bd = Infinity;
  for (let m = lo; m <= hi; m++) {
    if (pcOf(m) !== pc) continue;
    if (prev != null && dir > 0 && m <= prev) continue;
    if (prev != null && dir < 0 && m >= prev) continue;
    const d = Math.abs(m - ref);
    if (d < bd) { bd = d; best = m; }
  }
  if (best == null) for (let m = lo; m <= hi; m++) if (pcOf(m) === pc && Math.abs(m - ref) < bd) { bd = Math.abs(m - ref); best = m; }
  return best ?? clamp(ref, lo, hi);
}
function nearestPc(m, pcs, lo, hi) {
  for (let d = 0; d <= 12; d++) for (const s of [m + d, m - d]) if (s >= lo && s <= hi && pcs.includes(pcOf(s))) return s;
  return clamp(m, lo, hi);
}

// 弾き方ごとに、どのジャンルのソロを多めに使うか
const STYLE_GENRE = {
  rock: { Rock: 2.2, Funk: 1, SS: 0.9 },
  emotional: { SS: 2, Rock: 1.3, Funk: 0.6 },
  classical: { SS: 2.2, Rock: 0.6, Funk: 0.3 },
  celtic: { SS: 1.4, Rock: 1.1, Funk: 1 },
};

// フレーズを、拍 s から置く（音の高さを置きかえる）
function mapPhrase(ctx, ph, s, startRef, lo, hi, shiftRole) {
  const res = [];
  ph.notes.forEach((n, i) => {
    const x = s + n.o / 4;
    const len = n.d / 4;
    const key = ctx.keyAt(x);
    let pc;
    // こたえのフレーズは、役割を少しずらす（根音→3度、3度→5度…）＝同じリズムで高さが変わる
    if (n.ct && n.role != null) pc = roleToPc(shiftRole ? ({ 0: 4, 3: 7, 4: 7, 7: 0, 10: 0, 11: 0 }[n.role] ?? n.role) : n.role, ctx, x);
    else pc = degreeToPc(n.deg, ph.mode, key);
    const prev = i ? res[i - 1].midi : null;
    const ref = i ? prev + n.iv : startRef;
    let m = place(pc, ref, prev, i ? Math.sign(n.iv) : 0, lo, hi);
    // 音階の外の音は、ごく短いとき（経過音）だけ
    const sc = ctx.scalePcs(x);
    if (!sc.includes(pcOf(m)) && len > 0.26) m = nearestPc(m, sc, lo, hi);
    // 長めの音は、続く間も原曲と濁らないこと
    if (len >= 0.5) {
      let bad = false;
      for (let k = 0; k < len - 0.01; k += 0.5) if (ctx.tension(m, x + k) > 1) bad = true;
      if (bad) m = nearestPc(m, ctx.chordPcs(x), lo, hi);
    }
    res.push({ x, len, midi: m, ct: n.ct, onBeat: n.o % 4 === 0 });
  });
  return res;
}

export function genSoloV3(ctx, item, out, prevNote, nextIsVocal, bars) {
  const { an, rand, style } = ctx;
  if (!bars.length) return prevNote;
  if (!PHR || an.meter !== 4) return simpleSolo(ctx, item, out, prevNote, nextIsVocal, bars);
  const sec = item.sec;
  const isIntro = sec.type === 'intro', isOutro = sec.type === 'outro';
  const motion = ctx.settings.soloMotion ?? 1; // 0 ゆったり 1 ふつう 2 激しく
  const beatSec = 60 / an.bpm;
  const start = bars[0].b0, end = bars[bars.length - 1].b0 + bars[bars.length - 1].n;
  const total = end - start;
  const lo = 62, hi = isIntro || isOutro ? 86 : 91;
  const gw = STYLE_GENRE[ctx.settings.style] || STYLE_GENRE.emotional;
  // 1 秒あたりの音の数のめやす（はじめ → 終わり）
  const nps = [[1.2, 3.0], [2.0, 5.2], [3.0, 7.5]][motion];
  const npsMax = [3.6, 6.5, 9.5][motion];
  const inten = item.intensity;
  const placed = [];
  let p = start + (rand() < 0.5 ? 0 : 0.5);
  let ref = prevNote ? clamp(prevNote.midi, 69, 81) : 74;
  let prevPh = null;
  let guard = 0;
  while (p < end - 1.5 && guard++ < 64) {
    const prog = (p - start) / Math.max(1, total);
    const want = (nps[0] + (nps[1] - nps[0]) * Math.min(1, prog * 1.15)) * (isOutro ? 0.8 : 1);
    const remain = end - p;
    // 前のフレーズをもう一度（呼びかけ→こたえ：リズムは同じ、音は役割をずらして）
    let ph = null, shift = false;
    if (prevPh && rand() < 0.3 && prevPh.lenQ / 4 <= remain - 0.5) { ph = prevPh; shift = true; }
    if (!ph) {
      const cands = [];
      const pool = motion === 2 ? PHR.list.concat(PHR.fast) : PHR.list;
      for (const q of pool) {
        const lenB = q.lenQ / 4;
        if (lenB > remain - 0.25) continue;
        const r = q.n / (lenB * beatSec);
        if (r > npsMax) continue;
        const w = (gw[q.g] || 0.5) * Math.exp(-Math.abs(r - want) / 0.7) * (lenB >= 2 ? 1 : 0.6) * (q.double ? 0.8 : 1);
        cands.push([q, w]);
      }
      if (!cands.length) break;
      let r = rand() * cands.reduce((a, c) => a + c[1], 0);
      for (const [q, w] of cands) { r -= w; if (r <= 0) { ph = q; break; } }
      ph = ph || cands[cands.length - 1][0];
    }
    // 小節の中の入る位置を、元のフレーズと同じにする
    const barStart = start + Math.floor((p - start) / 4) * 4;
    let s = barStart + ph.barPos;
    while (s < p - 1e-6) s += 4;
    if (s + ph.lenQ / 4 > end) s = p;
    // 高さのめやす：だんだん上がる（一気に飛ばない）
    const regTarget = clamp(72 + 6 * inten + 8 * prog, 70, hi - 5);
    const startRef = Math.round(ref + clamp(regTarget - ref, -5, 5));
    const ns = mapPhrase(ctx, ph, s, startRef, lo, hi, shift);
    // 音域からはみ出した音は、オクターブ折り返す。フレーズの中も、前のフレーズからも 12 半音より大きく跳ばない
    for (let i = 0; i < ns.length; i++) {
      const before = i ? ns[i - 1].midi : ref;
      while (ns[i].midi > hi || ns[i].midi - before > 12) ns[i].midi -= 12;
      while (ns[i].midi < lo || before - ns[i].midi > 12) ns[i].midi += 12;
      if (ns[i].midi > hi) ns[i].midi -= 12;
    }
    placed.push({ ns, prog });
    ref = ns[ns.length - 1].midi;
    prevPh = ph;
    // 息つぎ
    const gap = motion === 2 ? 0.25 + rand() * 0.75 : motion === 1 ? 0.5 + rand() * 1.25 : 1 + rand() * 1.5;
    p = s + ph.lenQ / 4 + gap;
  }
  if (!placed.length) return simpleSolo(ctx, item, out, prevNote, nextIsVocal, bars);
  // 最後の音：長くのばして決める（次が歌なら少し手前で切る）
  const lastPh = placed[placed.length - 1].ns;
  const last = lastPh[lastPh.length - 1];
  const endX = end - (nextIsVocal ? 0.5 : 0);
  if (endX - last.x > last.len) last.len = Math.min(endX - last.x, Math.max(last.len, 4));
  last.midi = nearestPc(last.midi, ctx.chordPcs(last.x), lo, hi);
  last.final = true;
  const all = placed.flatMap((pl) => pl.ns.map((n) => ({ ...n, prog: pl.prog })));
  let peak = null;
  for (const n of all) if (n.len >= 0.75 && (!peak || n.midi > peak.midi)) peak = n;
  let lastOut = prevNote;
  all.forEach((n, i) => {
    const t = ctx.beatTime(n.x), te = ctx.beatTime(n.x + n.len);
    const d = te - t;
    const prevN = all[i - 1];
    const touching = prevN && Math.abs(prevN.x + prevN.len - n.x) < 1e-6;
    const it = inten * (0.7 + 0.3 * n.prog);
    const vel = clamp(0.45 + 0.4 * it + (n.onBeat ? 0.05 : 0) + (n === peak ? 0.08 : 0), 0.25, 1);
    const note = { t, d, midi: n.midi, vel, art: !touching && d < 0.3 && n.onBeat && it > 0.6 ? 'mrc' : 'sus', legato: !!touching, shape: d >= 0.8 ? 'swell' : 'flat', role: 'solo', sec: item.si };
    if (!touching && d > 0.9) note.art = 'sneak';
    if (d >= 0.6 && prevN && n.midi - prevN.midi >= 4 && rand() < style.slide) note.slide = -2;
    if (n === peak && d >= 0.8) { note.vib = 1; if (rand() < 0.5) note.bend = 1; }
    if (n.final) { note.vib = 1; note.shape = nextIsVocal ? 'fade' : 'swell'; }
    if (d >= 1.2 && n.final && rand() < style.trill * 0.5) note.trill = 2;
    out.push(note);
    lastOut = note;
  });
  return lastOut;
}

// 学んだフレーズがないとき（3 拍子など）：音階でうたう簡単なソロ
function simpleSolo(ctx, item, out, prevNote, nextIsVocal, bars) {
  const { rand } = ctx;
  let m = prevNote ? clamp(prevNote.midi, 69, 81) : 74;
  let last = prevNote;
  bars.forEach((bar, bi) => {
    const lens = bar.n === 3 ? [1, 0.5, 0.5, 1] : [1.5, 0.5, 1, 1];
    let pos = 0;
    lens.forEach((len, k) => {
      if (pos + len > bar.n + 1e-6) return;
      const x = bar.b0 + pos;
      const sc = ctx.scalePcs(x);
      const step = [1, -1, 2, -2, 1][Math.floor(rand() * 5)];
      let cand = m + step;
      while (!sc.includes(pcOf(cand))) cand += Math.sign(step) || 1;
      m = k === 0 ? nearestPc(cand, ctx.chordPcs(x), 64, 88) : clamp(cand, 64, 88);
      const t = ctx.beatTime(x), te = ctx.beatTime(x + len);
      const n = { t, d: te - t, midi: m, vel: 0.5 + 0.3 * item.intensity, art: 'sus', legato: k > 0, shape: 'flat', role: 'solo', sec: item.si };
      if (bi === bars.length - 1 && k === lens.length - 1) { n.vib = 1; if (nextIsVocal) n.d *= 0.6; }
      out.push(n);
      last = n;
      pos += len;
    });
  });
  return last;
}
