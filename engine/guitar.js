// アコギの伴奏を作る（歌＋アコギ＋バイオリンで再アレンジするとき）
// ・コードの押さえ方：標準チューニング（E2 A2 D3 G3 B3 E4）で、指 4 本（セーハ 1 本）で押さえられ、低い方の弦の休み（ミュート）だけの形を探す。
//   一番低い音は根音、3 度（7th のコードは 7 度も）は必ず入れる。開放弦が多く低いポジションほど響きがよい。前のコードから近い形を選ぶ
// ・弾き方：区間の強さ（compose.js の段階と同じ 0〜4）で、アルペジオ（指弾き）とストローク（ダウン・アップ）を使い分ける。
//   ストロークは弦を低い方から（アップは高い方から）少しずつずらして鳴らす。弦は次にその弦を弾くか、コードが変わるまで鳴らしておく
export const TUNING = [40, 45, 50, 55, 59, 64];
const QIV = { maj: [0, 4, 7], min: [0, 3, 7], dom7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10] };
const pcOf = (m) => ((m % 12) + 12) % 12;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ストローク：16 分ごとに D＝ダウン・U＝アップ・d／u＝弱く・x＝ブラッシング（音程のない刻み）・.＝休み
export const STRUMS = {
  q4: ['4分のストローク', 'D...D...D...D...'],
  pop: ['ポップスの定番（D D U U D U）', 'D...D.U...U.D.U.'],
  eighth: ['8分のアップダウン', 'D.u.D.u.D.u.D.u.'],
  chuck: ['2・4 拍にブラッシング', 'D.u.x.u.D.u.x.u.'],
  ballad: ['バラード（1 拍目を伸ばす）', 'D.....u.D.u.D.u.'],
  drive: ['16分の刻み', 'D.UuD.UuD.UuD.Uu'],
};
// アルペジオ：B＝根音の弦（ベース）・A＝もう 1 本のベース・1/2/3＝高い方から 1・2・3 本目の弦・P＝ベースと 1 本目を同時・.＝休み
export const PICKS = {
  arp8: ['8分のアルペジオ', 'B.3.2.1.A.3.2.1.'],
  updown: ['上り下りのアルペジオ', 'B.3.2.1.2.3.2.3.'],
  travis: ['スリーフィンガー（トラビス）', 'P.2.A.1.B.2.A.1.'],
  slow: ['4分のアルペジオ', 'B...3...A...2...'],
};
export const GUITAR_STYLES = { auto: 'おまかせ', arp: 'アルペジオ中心', strum: 'ストローク中心' };

// ───────── 押さえ方
const cache = new Map();
export function voicingsFor(root, q) {
  const key = `${root}:${q}`;
  if (cache.has(key)) return cache.get(key);
  const iv = QIV[q] || QIV.maj;
  const pcs = iv.map((v) => (root + v) % 12);
  const third = pcs[1], fifth = pcs[2], seventh = pcs.length > 3 ? pcs[3] : null;
  const found = new Map();
  const evaluate = (fr) => {
    const idx = [];
    for (let s = 0; s < 6; s++) if (fr[s] != null) idx.push(s);
    if (idx.length < 4) return;
    const first = idx[0];
    for (let s = first; s < 6; s++) if (fr[s] == null) return; // 休ませるのは低い方の弦だけ（ストロークで弾けるように）
    const notes = fr.map((f, s) => (f == null ? null : TUNING[s] + f));
    if (pcOf(notes[first]) !== root) return; // 一番低い音は根音
    const have = new Set(idx.map((s) => pcOf(notes[s])));
    if (!have.has(third) || (seventh != null && !have.has(seventh))) return;
    const fretted = idx.filter((s) => fr[s] > 0);
    let fingers = 0, barre = false, minF = 0, maxF = 0;
    if (fretted.length) {
      const fs = fretted.map((s) => fr[s]);
      minF = Math.min(...fs); maxF = Math.max(...fs);
      if (maxF - minF > 3) return;
      // セーハ：一番低いフレットを、その弦から 1 弦まで人差し指 1 本で押さえる（その間に開放弦があってはいけない）
      const lowS = fretted.find((s) => fr[s] === minF);
      const canBarre = fretted.filter((s) => fr[s] === minF).length >= 2 && idx.every((s) => s < lowS || fr[s] >= minF);
      if (canBarre) { barre = true; fingers = 1 + fretted.filter((s) => fr[s] > minF).length; } else fingers = fretted.length;
      if (fingers > 4) return;
      // 同じフレットを離れた 2 本の弦で押さえ、そのあいだにもっと高いフレットがある形は、指が交差して押さえられない（セーハのときは別）
      if (!barre) for (let a = 0; a < fretted.length; a++) for (let b = a + 1; b < fretted.length; b++) {
        const sa = fretted[a], sb = fretted[b];
        if (fr[sa] !== fr[sb] || sb - sa < 2) continue;
        for (let m = sa + 1; m < sb; m++) if (fr[m] > fr[sa]) return;
      }
    }
    const open = idx.filter((s) => fr[s] === 0).length;
    const thirds = idx.filter((s) => pcOf(notes[s]) === third).length;
    // 押さえた弦にはさまれた開放弦（ポジションが 2 フレット以上のとき）は押さえにくく、響きもばらばら
    let innerOpen = 0;
    if (minF >= 2) for (const s of idx) if (fr[s] === 0 && fretted.some((q) => q < s) && fretted.some((q) => q > s)) innerOpen++;
    // 開放弦は、手がナットの近く（2 フレットまで）なら響きがよい。高いポジションでは、手から離れた音になる
    let score = 0.9 * (idx.length - 4) + (minF <= 2 ? 0.55 : -0.2) * open + (have.has(fifth) ? 0.5 : 0) - 0.3 * Math.max(0, thirds - 1) - 0.3 * minF - (barre ? 1.2 : 0) - 0.15 * fingers - 0.3 * (maxF - minF) - 1.0 * innerOpen;
    if (minF >= 5) score -= 0.8; // 高いポジションは響きが細く、ストロークの伴奏には向かない
    if (minF >= 7) score -= 1.6;
    const k = fr.map((f) => (f == null ? 'x' : f)).join(',');
    if (!found.has(k) || found.get(k).score < score) found.set(k, { frets: fr.slice(), notes, score, barre, pos: minF });
  };
  const cur = new Array(6);
  for (let pos = 0; pos <= 9; pos++) {
    const opts = TUNING.map((open) => {
      const o = [null];
      if (pcs.includes(pcOf(open))) o.push(0);
      for (let f = Math.max(1, pos); f <= pos + 3; f++) if (pcs.includes(pcOf(open + f))) o.push(f);
      return o;
    });
    const rec = (s) => { if (s === 6) { evaluate(cur); return; } for (const f of opts[s]) { cur[s] = f; rec(s + 1); } };
    rec(0);
  }
  const list = [...found.values()].sort((a, b) => b.score - a.score).slice(0, 10);
  cache.set(key, list);
  return list;
}
export function fretText(v) { return v.frets.map((f) => (f == null ? 'x' : f)).join(''); }
const handPos = (v) => { const fs = v.frets.filter((f) => f > 0); return fs.length ? fs.reduce((a, b) => a + b, 0) / fs.length : 0; };

// コードの並びに、なるべく手が動かない押さえ方を当てる（動的計画法）
function chooseVoicings(segs) {
  const cand = segs.map((sg) => voicingsFor(sg.root, sg.q).slice(0, 8));
  const N = segs.length;
  if (!N) return [];
  const cost = cand.map((c) => c.map(() => Infinity)), back = cand.map((c) => c.map(() => -1));
  cand[0].forEach((v, j) => (cost[0][j] = -v.score));
  for (let i = 1; i < N; i++) {
    cand[i].forEach((v, j) => {
      cand[i - 1].forEach((u, k) => {
        let changed = 0;
        for (let s = 0; s < 6; s++) if (u.frets[s] !== v.frets[s]) changed++;
        const c = cost[i - 1][k] - v.score + 0.18 * Math.abs(handPos(u) - handPos(v)) + 0.08 * changed;
        if (c < cost[i][j]) { cost[i][j] = c; back[i][j] = k; }
      });
    });
  }
  let j = 0;
  for (let q = 1; q < cand[N - 1].length; q++) if (cost[N - 1][q] < cost[N - 1][j]) j = q;
  const out = new Array(N);
  for (let i = N - 1; i >= 0; i--) { out[i] = cand[i][j]; j = back[i][j]; }
  return out;
}

// ───────── 伴奏
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// 区間ごとの弾き方：0〜1＝アルペジオ（静か）、2＝ポップスのストローク、3〜4＝ブラッシング入りの元気なストローク。速い曲は細かくしない
export function guitarStyleFor(level, bpm, pref = 'auto', vocal = true) {
  const fast = bpm >= 135, slow = bpm < 78;
  if (pref === 'arp') return { kind: 'pick', id: level >= 3 ? 'travis' : fast ? 'slow' : 'arp8' };
  if (pref === 'strum') return { kind: 'strum', id: level <= 1 ? (slow ? 'ballad' : 'q4') : level === 2 ? 'pop' : fast ? 'eighth' : 'chuck' };
  if (level <= 0) return { kind: 'pick', id: fast ? 'slow' : 'arp8' };
  if (level === 1) return vocal ? { kind: 'pick', id: fast ? 'slow' : slow ? 'arp8' : 'travis' } : { kind: 'strum', id: slow ? 'ballad' : 'q4' };
  if (level === 2) return { kind: 'strum', id: slow ? 'ballad' : 'pop' };
  return { kind: 'strum', id: fast ? 'eighth' : slow ? 'pop' : 'chuck' };
}

// an＝曲の解析、plan＝compose の区間の計画（level・type を使う）。返り値 { notes, chords, plan }
//   notes＝[{ t, d, midi, vel, string, stroke }]（guitar-sampler.js の scheduleGuitar にそのまま渡せる）
export function arrangeGuitar(an, plan, settings = {}) {
  const rand = mulberry32((settings.seed ?? 1) * 104729 + 7);
  const beats = an.beats, nb = beats.length;
  const beatTime = (x) => { if (x <= 0) return beats[0]; const i = Math.floor(x), f = x - i; if (i + 1 < nb) return beats[i] + (beats[i + 1] - beats[i]) * f; const T = nb > 1 ? beats[nb - 1] - beats[nb - 2] : 0.5; return beats[nb - 1] + T * (x - (nb - 1)); };
  // コードのまとまり（拍ごとのコードを、同じコードが続く所でまとめる）
  const segs = [];
  for (let i = 0; i < an.chords.length; i++) {
    const c = an.chords[i];
    const last = segs[segs.length - 1];
    if (!c) { if (last && last.root != null) segs.push({ x0: i, x1: i + 1, root: null }); else if (last) last.x1 = i + 1; continue; }
    if (last && last.root === c.root && last.q === c.q) last.x1 = i + 1;
    else segs.push({ x0: i, x1: i + 1, root: c.root, q: c.q in QIV ? c.q : 'maj' });
  }
  const real = segs.filter((s) => s.root != null);
  const vs = chooseVoicings(real);
  real.forEach((s, i) => (s.v = vs[i]));
  const segAt = (x) => { let lo = 0, hi = segs.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].x0 <= x + 1e-6) lo = m; else hi = m - 1; } return segs[lo]; };
  const G = an.groove || null;
  const accentAt = (x) => {
    if (!G) return 0.5;
    const bi = an.barOfBeat[clamp(Math.floor(x + 1e-6), 0, an.barOfBeat.length - 1)];
    const g = G[bi], bar = an.bars[bi];
    if (!g || !bar) return 0.5;
    const k = clamp(Math.round((x - bar.b0) * 4), 0, g.k.length - 1);
    return Math.min(1, 0.6 * g.k[k] + 0.7 * g.s[k] + 0.25 * g.h[k]);
  };
  const raw = []; // { t, midi, vel, string, stroke, x }
  const secPlan = [];
  const pref = settings.guitarStyle || 'auto';
  plan.forEach((p) => {
    const sec = an.sections[p.si];
    if (p.guitar === 'rest') { secPlan.push({ si: p.si, kind: 'rest' }); return; }
    const st = guitarStyleFor(p.level ?? 2, an.bpm, p.guitar || pref, sec.vocal);
    secPlan.push({ si: p.si, ...st, name: (st.kind === 'pick' ? PICKS : STRUMS)[st.id][0] });
    const inten = clamp(0.45 + 0.12 * (p.level ?? 2) + (sec.vocal ? -0.05 : 0.05), 0.3, 1);
    const pat = (st.kind === 'pick' ? PICKS : STRUMS)[st.id][1];
    for (let b = sec.bar0; b < sec.bar1; b++) {
      const bar = an.bars[b];
      if (!bar) continue;
      const steps = bar.n * 4;
      for (let k = 0; k < steps; k++) {
        const ch = pat[k % 16];
        if (ch === '.') continue;
        const x = bar.b0 + k / 4;
        const sg = segAt(x);
        if (!sg || sg.root == null || !sg.v) continue;
        const v = sg.v;
        const t = beatTime(x);
        const acc = accentAt(x);
        const sounding = [];
        for (let s = 0; s < 6; s++) if (v.frets[s] != null) sounding.push(s);
        if (st.kind === 'strum') {
          const up = ch === 'U' || ch === 'u';
          const soft = ch === 'd' || ch === 'u';
          const mute = ch === 'x';
          // アップは高い方の 3〜4 本、ダウンは全部（弱いダウンは低い方を 1 本省く）
          let strings = up ? sounding.slice(-(3 + (rand() < 0.5 ? 1 : 0))).reverse() : soft ? sounding.slice(1) : sounding;
          const spread = (up ? 0.009 : soft ? 0.02 : 0.014) * (0.8 + 0.4 * rand());
          const base = (up ? 0.5 : soft ? 0.55 : mute ? 0.5 : 0.72) * inten * (0.9 + 0.25 * acc) + (k % 16 === 0 ? 0.05 : 0);
          const jit = (rand() - 0.5) * 0.008;
          strings.forEach((s, i) => raw.push({ t: t + jit + (i * spread) / Math.max(1, strings.length - 1), midi: v.notes[s], vel: clamp(base * (0.92 + 0.12 * rand()) + (up ? 0 : 0.04 * (1 - i / strings.length)), 0.12, 1), string: s, stroke: mute ? 'mute' : up ? 'up' : 'down', x }));
        } else {
          const bassS = sounding[0];
          const altS = sounding.find((s) => s > bassS && pcOf(v.notes[s]) !== pcOf(v.notes[bassS])) ?? sounding[1];
          const top = (n) => sounding[sounding.length - n];
          const pick = [];
          if (ch === 'B') pick.push(bassS);
          else if (ch === 'A') pick.push(altS);
          else if (ch === 'P') pick.push(bassS, top(1));
          else pick.push(top(Number(ch)));
          for (const s of pick) {
            if (s == null) continue;
            const isBass = s === bassS || s === altS;
            raw.push({ t: t + (rand() - 0.5) * 0.01, midi: v.notes[s], vel: clamp((isBass ? 0.85 : 0.72) * inten * (0.9 + 0.2 * acc) + (k % 16 === 0 ? 0.05 : 0) + (rand() - 0.5) * 0.06, 0.12, 1), string: s, stroke: 'pick', x });
          }
        }
      }
    }
  });
  // 音の長さ：その弦を次に弾くまで（コードが変わったら、その少し前で止める＝左手を離す）。最後は 3 秒まで
  raw.sort((a, b) => a.t - b.t);
  const nextOnString = new Array(6).fill(Infinity);
  for (let i = raw.length - 1; i >= 0; i--) {
    const n = raw[i];
    const sg = segAt(n.x);
    const chordEnd = sg ? beatTime(sg.x1) - 0.03 : n.t + 2;
    n.d = Math.max(0.05, Math.min(nextOnString[n.string] - n.t, chordEnd - n.t, n.stroke === 'mute' ? 0.06 : 3.2));
    nextOnString[n.string] = n.t;
  }
  const notes = raw.map((n) => ({ t: Math.round(n.t * 10000) / 10000, d: Math.round(n.d * 10000) / 10000, midi: n.midi, vel: Math.round(n.vel * 1000) / 1000, string: n.string, stroke: n.stroke }));
  const chords = real.map((s) => ({ x0: s.x0, x1: s.x1, t0: beatTime(s.x0), root: s.root, q: s.q, frets: s.v ? fretText(s.v) : null }));
  return { notes, chords, plan: secPlan };
}

// 再アレンジのときにバイオリンが聞く「鳴っている音」：原曲の代わりに、アコギの押さえ方の音（＋歌のメロディ）
export function trioChroma(an, guitar) {
  const nb = an.beats.length;
  const ch = Array.from({ length: nb }, () => new Array(12).fill(0.03));
  for (const c of guitar.chords) {
    const v = voicingsFor(c.root, c.q).find((q) => fretText(q) === c.frets);
    if (!v) continue;
    for (let x = c.x0; x < Math.min(c.x1, nb); x++) for (const m of v.notes) if (m != null) ch[x][pcOf(m)] = Math.min(1, ch[x][pcOf(m)] + 0.5);
  }
  if (an.vocalLine) for (let st = 0; st < an.vocalLine.length; st++) { const v = an.vocalLine[st], x = st >> 2; if (v >= 0 && x < nb) ch[x][pcOf(v)] = Math.max(ch[x][pcOf(v)], 0.6); }
  return ch;
}
