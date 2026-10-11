// バイオリンのパートを作る。
// 歌の裏：そっと長い音（そっと伴奏）／サビ：動きのある対旋律／間奏・イントロ：ソロ／目立つリフ：まねる
import { scaleOf, MAJOR_SCALE, MINOR_SCALE } from './analyze.js';
import { genSoloV3 } from './solo.js';
import { genLine, hasLineModel, connectLp, dynamicsFor } from './line.js';
export { setPhrases, phraseInfo } from './solo.js';
export { setLineModel, lineModelInfo, lineScore } from './line.js';

export const LOW = 55; // G3
export const HIGH = 91; // G6
export const ROLE_LABEL = { auto: 'おまかせ', rest: '休む', pad: 'そっと伴奏', arp: '分散和音', rhythm: '刻み', counter: '対旋律', answer: '掛け合い', double: 'メロディを弾く', solo: 'ソロ', riff: 'リフをまねる' };
export const TYPE_LABEL = { intro: 'イントロ', verse: 'Aメロ', pre: 'Bメロ', chorus: 'サビ', inter: '間奏', outro: 'アウトロ' };
export const STYLES = {
  emotional: { label: 'エモーショナル', slide: 0.35, grace: 0.08, trill: 0.1, density: 0.55, nine: true, pent: 0.2 },
  classical: { label: 'クラシカル', slide: 0.1, grace: 0.12, trill: 0.35, density: 0.6, nine: false, pent: 0 },
  rock: { label: 'ロック', slide: 0.45, grace: 0.05, trill: 0.05, density: 0.75, nine: false, pent: 0.7 },
  celtic: { label: 'ケルト', slide: 0.05, grace: 0.45, trill: 0.15, density: 0.8, nine: false, pent: 0.35 },
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pcOf = (m) => ((m % 12) + 12) % 12;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ───────────────────────── 文脈（時間・和音の引き方）
function makeCtx(an, settings) {
  const rand = mulberry32((settings.seed ?? 1) * 7919 + 17);
  const beats = an.beats;
  const nb = beats.length;
  const lastP = nb > 1 ? beats[nb - 1] - beats[nb - 2] : 0.5;
  const beatTime = (x) => {
    if (x <= 0) return beats[0] + x * (nb > 1 ? beats[1] - beats[0] : 0.5);
    const i = Math.floor(x), f = x - i;
    if (i + 1 < nb) return beats[i] + (beats[i + 1] - beats[i]) * f;
    return beats[nb - 1] + lastP * (x - (nb - 1));
  };
  const beatLen = (x) => {
    const i = clamp(Math.floor(x), 0, nb - 2);
    return beats[i + 1] - beats[i];
  };
  const bi = (x) => clamp(Math.floor(x + 1e-6), 0, nb - 1);
  const beatOf = (t) => { let lo = 0, hi = nb - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beats[m] <= t) lo = m; else hi = m; } return lo + (t - beats[lo]) / Math.max(1e-6, (beats[lo + 1] ?? beats[lo] + lastP) - beats[lo]); };
  // 和音（無いときは、その拍で鳴っている強い音）
  const chordPcs = (x) => {
    const i = bi(x);
    const ch = an.chords[i];
    if (ch) return ch.pcs.slice();
    const c = an.chroma[i];
    const mx = Math.max(...c);
    return c.map((v, p) => [v, p]).filter(([v]) => v >= mx * 0.8).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, p]) => p);
  };
  const chordRoot = (x) => {
    const ch = an.chords[bi(x)];
    return ch ? ch.root : chordPcs(x)[0];
  };
  const keyAt = (x) => an.keyPerBar[an.barOfBeat[bi(x)]] || an.key;
  const scalePcs = (x) => scaleOf(keyAt(x));
  // 原曲で実際に鳴っている強さ（0〜1）
  const heard = (pc, x) => {
    const c = an.chroma[bi(x)];
    const mx = Math.max(...c) || 1;
    return c[((pc % 12) + 12) % 12] / mx;
  };
  // 和音の音のうち、使ってよいもの：曲の調の音階にある音か、調の外でも原曲で強く鳴っている音
  // （例：イ短調の E のコードの G# は、原曲で鳴っていれば使う。読み違いの和音の音は使わない）
  const safeChordPcs = (x) => {
    const sc = scalePcs(x);
    const all = chordPcs(x);
    // 原曲で鳴っていない 7 度などが、半音となりの強い音とぶつかるなら使わない（例：F のコードを FM7 と読んだときの E）
    const ok = all.filter((pc) => (sc.includes(pc) || heard(pc, x) >= 0.55) && !clashes(pc, x));
    if (ok.length) return ok;
    const inKey = all.filter((pc) => sc.includes(pc));
    return inKey.length ? inKey : all;
  };
  // 半音となりに、原曲で強く鳴っている音があって、自分は鳴っていない（＝長く弾くと濁る）
  const clashes = (pc, x) => heard(pc, x) < 0.35 && Math.max(heard(pc + 1, x), heard(pc + 11, x)) >= 0.7;
  // 鳴っている音として安全か（和音の音＝0、音階の音＝1、外れ・ぶつかる＝2）
  const tension = (m, x) => {
    const pc = pcOf(m);
    if (safeChordPcs(x).includes(pc)) return 0;
    if (scalePcs(x).includes(pc) && !clashes(pc, x)) return 1;
    return 2;
  };
  const vocalAt = (x) => an.vocalProb[bi(x)] || 0;
  // 歌のメロディ（推定・16 分ごと）：息つぎの場所・次に歌い出す音
  const VL = an.vocalLine || null;
  const vocalPitch = (step) => { if (!VL || step < 0 || step >= VL.length) return null; const v = VL[step]; return v >= 0 ? v : null; };
  let nextOn = null;
  if (VL) {
    nextOn = new Int32Array(VL.length);
    let nx = 1e9;
    for (let s = VL.length - 1; s >= 0; s--) { if (VL[s] >= 0 && (s === 0 || VL[s - 1] !== VL[s])) nx = s; nextOn[s] = Math.min(1e6, nx - s); }
  }
  const vocalState = (step) => {
    if (!VL || step < 0 || step >= VL.length) return null;
    const v = VL[step];
    const state = v < 0 ? 'rest' : step > 0 && VL[step - 1] === v ? 'hold' : 'on';
    const u = nextOn[step];
    return { state, ub: u <= 1 ? 0 : u <= 3 ? 1 : u <= 7 ? 2 : u <= 15 ? 3 : 4 };
  };
  const nextVocalNote = (step) => { if (!VL || step < 0 || step >= VL.length) return null; const u = nextOn[step]; return u < 32 ? VL[step + u] : null; };
  // ドラム・ベースのリズム（小節ごと）。強さ＝キック・スネア・ハイハットを足したもの
  const G = an.groove || null;
  const grooveAt = (beat) => {
    if (!G) return null;
    const b = an.barOfBeat[clamp(Math.floor(beat + 1e-6), 0, an.barOfBeat.length - 1)];
    const g = G[b];
    if (!g) return null;
    if (g.mean == null) { let m = 0; for (let k = 0; k < g.k.length; k++) m += 0.6 * g.k[k] + 0.7 * g.s[k] + 0.25 * g.h[k]; g.mean = m / g.k.length; }
    return g;
  };
  const accentAtStep = (step) => {
    const g = grooveAt(step / 4);
    if (!g) return 0.5;
    const bar = an.bars[an.barOfBeat[clamp(Math.floor(step / 4), 0, an.barOfBeat.length - 1)]];
    const k = clamp(step - bar.b0 * 4, 0, g.k.length - 1);
    return Math.min(1, 0.6 * g.k[k] + 0.7 * g.s[k] + 0.25 * g.h[k]);
  };
  // 曲全体の歌の高さの真ん中（伴奏を歌の下に置くか上に置くかは、曲で 1 つに決める。区間ごとに変えると大きく跳ぶ）
  let vocalMed = null, vocalLo = null, vocalHi = null;
  if (VL) {
    const vs = [];
    for (let i = 0; i < VL.length; i++) if (VL[i] >= 0) vs.push(VL[i]);
    if (vs.length >= 32) { vs.sort((a, b) => a - b); vocalMed = vs[vs.length >> 1]; vocalLo = vs[Math.floor(vs.length * 0.1)]; vocalHi = vs[Math.floor(vs.length * 0.9)]; }
  }
  const LL = an.leadLine || null;
  const leadPitch = (step) => { if (!LL || step < 0 || step >= LL.length) return null; const v = LL[step]; return v >= 0 ? v : null; };
  return { an, settings, rand, beatTime, beatOf, beatLen, chordPcs: safeChordPcs, rawChordPcs: chordPcs, chordRoot, keyAt, scalePcs, tension, heard, clashes, vocalAt, vocalPitch, vocalState, nextVocalNote, hasVocalLine: !!VL, vocalMed, vocalLo, vocalHi, grooveAt: G ? grooveAt : null, accentAtStep, leadPitch, nb, style: STYLES[settings.style] || STYLES.emotional };
}

// 区間の中の小節（拍の位置）
function sectionBars(an, sec) {
  return an.bars.slice(sec.bar0, sec.bar1).map((b, k) => ({ ...b, idx: sec.bar0 + k }));
}

// 歌のない区間に、はっきりした楽器のメロディ（ギター・ピアノ・シンセなど）があるか
//  ＝16 分の 4 割以上で高さが取れていて、いろいろな高さに動いている（同じ音の連打や伴奏の和音ではない）
export function leadStrong(an, sec) {
  if (!an.leadLine || sec.vocal) return false;
  const s0 = an.bars[sec.bar0].b0 * 4, s1 = Math.min(an.leadLine.length, (an.bars[sec.bar1 - 1].b0 + an.bars[sec.bar1 - 1].n) * 4);
  let on = 0;
  const pitches = new Set();
  let moves = 0;
  for (let st = s0; st < s1; st++) {
    const v = an.leadLine[st];
    if (v < 0) continue;
    on++;
    pitches.add(v);
    if (st > s0 && an.leadLine[st - 1] >= 0 && an.leadLine[st - 1] !== v) moves++;
  }
  const len = Math.max(1, s1 - s0);
  return on / len >= 0.3 && pitches.size >= 4 && moves >= len / 24;
}

// ───────────────────────── 役割を決める
export function planRoles(an, settings) {
  const presence = settings.presence ?? 0.6;
  const motion = settings.motion ?? 1;
  const riffBySec = new Map();
  for (const r of an.riffs || []) riffBySec.set(r.section, r);
  const plan = an.sections.map((sec, si) => {
    const nBars = sec.bar1 - sec.bar0;
    const riff = riffBySec.get(si);
    const hasRiff = riff && riff.conf >= 0.55;
    let role = 'pad', intensity = 0.5;
    switch (sec.type) {
      case 'intro':
        role = hasRiff ? 'riff' : leadStrong(an, sec) ? 'double' : nBars >= 4 ? 'solo' : 'pad';
        intensity = 0.45;
        break;
      case 'verse':
        // 伴奏の動き：0 しっとり（長い音）／1 ほどよく（つなぎの音つき）／2 リズミカル（分散和音）
        role = sec.n === 1 && presence < 0.45 ? 'rest' : motion >= 2 ? (sec.n % 2 === 0 ? 'rhythm' : 'arp') : 'pad';
        intensity = sec.n === 1 ? 0.25 : 0.4;
        break;
      case 'pre':
        role = motion >= 2 ? 'rhythm' : 'pad';
        intensity = 0.55;
        break;
      case 'chorus':
        role = presence < 0.45 ? 'pad' : 'counter';
        intensity = sec.lastChorus ? 0.9 : 0.7;
        break;
      case 'inter':
        role = hasRiff && nBars < 6 ? 'riff' : leadStrong(an, sec) ? 'double' : 'solo';
        intensity = 0.9;
        break;
      case 'outro':
        role = hasRiff ? 'riff' : leadStrong(an, sec) ? 'double' : 'solo';
        intensity = 0.5;
        break;
    }
    if (nBars <= 1 && (role === 'solo' || role === 'riff')) role = 'pad';
    const over = settings.roles && settings.roles[si];
    if (over && over !== 'auto') role = over;
    if (role === 'riff' && !riff) role = 'solo';
    return { si, sec, role, intensity: clamp(intensity * (0.6 + 0.6 * presence), 0.1, 1), riff: riff || null, auto: !(over && over !== 'auto') };
  });
  levelsOf(an, plan, presence);
  return plan;
}

// 区間ごとの強さの段階（0〜4）：最初は薄く低く、後ろほど足して高く、最後のサビが頂点。最後のサビより前に全力を出さない
// （YouTube の弦アレンジ・バイオリン講座 61 本で、いちばん多く一致していたこと）
//   0＝1番の Aメロ（低い長い音）／1＝2番の Aメロ・1番の Bメロ／2＝1回目のサビ・2番の Bメロ／3＝途中のサビ・間奏／4＝最後のサビ
function levelsOf(an, plan, presence) {
  const K = plan.filter((p) => p.sec.type === 'chorus').length;
  let k = 0;
  plan.forEach((p, i) => {
    const t = p.sec.type;
    p.prevType = i > 0 ? plan[i - 1].sec.type : null;
    p.nextType = i + 1 < plan.length ? plan[i + 1].sec.type : null;
    if (t === 'chorus') {
      p.chorusK = k; p.chorusCount = K;
      p.level = K === 1 ? 3 : k === K - 1 ? 4 : k === 0 ? 2 : 3;
      k++;
    } else if (t === 'verse') p.level = k === 0 ? 0 : 1;
    else if (t === 'pre') p.level = k === 0 ? 1 : 2;
    else if (t === 'inter') p.level = 3;
    else if (t === 'intro') p.level = 1;
    else p.level = 2;
  });
  // サビが見つからない曲（歌の大きさの差が小さい）：歌の区間の順番で、後ろほど少しずつ上げる（最後の 2 割はサビのつもりで対旋律）
  if (!K) {
    const voc = plan.filter((p) => p.sec.vocal);
    voc.forEach((p, j) => {
      const r = j / Math.max(1, voc.length - 1);
      p.level = r < 0.25 ? 0 : r < 0.5 ? 1 : r < 0.8 ? 2 : 3;
      if (p.level === 3 && p.auto && p.role === 'pad' && presence >= 0.45) p.role = 'counter';
    });
  }
  // 歌の区間の強さ（音量）も段階に合わせる
  for (const p of plan) if (p.sec.vocal) p.intensity = clamp([0.25, 0.38, 0.55, 0.72, 0.9][p.level] * (0.6 + 0.6 * presence), 0.1, 1);
}

// 区間の歌の高さ（10%・真ん中・90%）
function vocalRangeOf(ctx, item) {
  const an = ctx.an;
  if (!an.vocalLine || !item.sec.vocal) return null;
  const s0 = an.bars[item.sec.bar0].b0 * 4, s1 = (an.bars[item.sec.bar1 - 1].b0 + an.bars[item.sec.bar1 - 1].n) * 4;
  const vs = [];
  for (let st = s0; st < s1; st++) { const v = an.vocalLine[st]; if (v >= 0) vs.push(v); }
  if (vs.length < 8) return null;
  vs.sort((a, b) => a - b);
  return { lo: vs[Math.floor(vs.length * 0.1)], med: vs[vs.length >> 1], hi: vs[Math.floor(vs.length * 0.9)] };
}

// バイオリンの音域：歌と同じ音域でかぶせない。歌の下で長い音（1番の Aメロは G 線・D 線のあたり）、
// サビの対旋律は歌から離して上へ、サビのたびに少しずつ上げ、最後のサビがいちばん高い
function registerFor(ctx, item, kind) {
  const vr = vocalRangeOf(ctx, item);
  const lv = item.level ?? 2;
  if (kind === 'pad') {
    const vLo = ctx.vocalLo, vHi = ctx.vocalHi;
    if (vLo == null) { const hi = [69, 72, 76, 79, 81][lv]; return { lo: 55, hi, center: hi - 7 }; }
    // 歌の下に 5 度以上の余地があれば、歌の下（G 線・D 線のあたり）で支える
    if (vLo >= 64 && lv <= 2) { const hi = Math.max(60, Math.min(vLo - 1, 62 + 2 * lv)); return { lo: 55, hi, center: Math.round((55 + hi) / 2) + 1 }; }
    // 余地がなければ歌の上で（どちらにするかは曲で 1 つに決まる。区間ごとに変えると大きく跳ぶ）
    const lo = clamp(vHi + 1, 62, 80);
    return { lo, hi: Math.min(88, lo + 10 + lv), center: lo + 3 + lv };
  }
  // 対旋律（サビ）
  const med = vr ? vr.med : 70;
  const center = lv <= 2 ? clamp(med + 5, 70, 79) : lv === 3 ? clamp(med + 9, 74, 84) : clamp(med + 12, 77, 86);
  return { lo: lv <= 2 ? 62 : 66, hi: Math.min(lv >= 4 ? 93 : 89, center + 8), center };
}

// ───────────────────────── 和音のまとまり（区間の中）
function chordSpans(ctx, bars, maxBeats) {
  const spans = [];
  for (const bar of bars) {
    for (let k = 0; k < bar.n; k++) {
      const x = bar.b0 + k;
      const pcs = ctx.chordPcs(x);
      const key = pcs.slice().sort().join(',');
      const last = spans[spans.length - 1];
      const startsBar = k === 0;
      if (last && last.key === key && last.len < maxBeats && !(startsBar && last.len >= maxBeats / 2 && (bar.idx % 2 === 0))) {
        last.len++;
      } else spans.push({ x, len: 1, key, pcs });
    }
  }
  // 1拍だけの和音は前につなぐ（長い音の伴奏では細かく追わない）
  for (let i = spans.length - 1; i > 0; i--) {
    if (spans[i].len === 1 && spans[i - 1].len >= 1) {
      spans[i - 1].len += 1;
      spans.splice(i, 1);
    }
  }
  return spans;
}

const PC_ROLE_COST = (m, ctx, x) => {
  const root = ctx.chordRoot(x);
  const iv = pcOf(m - root);
  if (iv === 3 || iv === 4) return 0; // 3度
  if (iv === 10 || iv === 11) return 0.1; // 7度
  if (iv === 7) return 0.4; // 5度
  if (iv === 0) return 1.0; // 根音（ベースの役目。長い音・強拍では避ける）
  if (iv === 2) return 0.3; // 9度
  return 0.6;
};

// ───────────────────────── そっと伴奏（歌の裏）
function genPad(ctx, item, out, prevNote) {
  const { an, rand } = ctx;
  const sec = item.sec;
  const bars = sectionBars(an, sec).filter((b) => !b.pickup);
  if (!bars.length) return prevNote;
  const inten = item.intensity;
  const lv = item.level ?? 2;
  const sparse = lv === 0 && sec.n === 1;
  const spans = chordSpans(ctx, bars, lv <= 1 ? 8 : 4);
  // 音域：歌と同じ音域でかぶせない（1番の Aメロは G 線・D 線のあたりの低い長い音）
  const reg = registerFor(ctx, item, 'pad');
  const low = item.registerLow ?? reg.lo;
  const high = item.registerHigh ?? (sec.type === 'pre' ? Math.min(86, reg.hi + 5) : reg.hi);
  const center0 = reg.center;
  // 1番の最初の Aメロは、後半から静かに入る（最初は薄く）
  let startIdx = 0;
  if (sparse && spans.length > 2) startIdx = Math.floor(spans.length / 2);
  const dom = (ctx.keyAt(bars[0].b0).tonic + 7) % 12; // 調の 5 度（低い段階では、合う間はのばす土台にする）
  // 動的計画法で、なめらかに動く音の並びを選ぶ
  const cand = spans.map((sp, i) => {
    const list = [];
    for (let m = low; m <= high; m++) {
      const pc = pcOf(m);
      const inChord = sp.pcs.includes(pc);
      const nine = ctx.style.nine && pcOf(m - ctx.chordRoot(sp.x)) === 2 && ctx.scalePcs(sp.x).includes(pc);
      if (!inChord && !nine) continue;
      // 和音が変わる途中の拍でも濁らないか（全拍で和音の音か音階の音）
      let ok = true;
      for (let k = 0; k < sp.len; k++) if (ctx.tension(m, sp.x + k) > 1) ok = false;
      if (!ok) continue;
      list.push(m);
    }
    if (!list.length) list.push(clamp(Math.round(center0), low, high));
    return list;
  });
  const rising = sec.type === 'pre';
  const centerAt = (i) => (rising ? low + 3 + ((high - low - 4) * i) / Math.max(1, spans.length - 1) : center0);
  const N = spans.length;
  const cost = [], back = [];
  for (let i = 0; i < N; i++) {
    cost.push(new Array(cand[i].length).fill(Infinity));
    back.push(new Array(cand[i].length).fill(-1));
    for (let j = 0; j < cand[i].length; j++) {
      const m = cand[i][j];
      let local = PC_ROLE_COST(m, ctx, spans[i].x) + 0.07 * Math.abs(m - centerAt(i)) + rand() * 0.05;
      if (lv <= 1 && pcOf(m) === dom && pcOf(m - ctx.chordRoot(spans[i].x)) !== 0) local -= 0.2;
      // 歌とこすれない（歌の音と 2度でぶつかる長い音は避ける）。歌と同じ音名（同じ高さ・オクターブ）も重ねない
      if (ctx.hasVocalLine) {
        let rub = 0, same = 0, cnt = 0;
        for (let k = 0; k < spans[i].len * 4; k++) { const v = ctx.vocalPitch(spans[i].x * 4 + k); if (v != null) { cnt++; const d = Math.abs(m - v) % 12; if (d === 1 || d === 2 || d === 11 || d === 10) rub++; if (d === 0) same++; } }
        local += 0.15 * rub + (cnt ? 0.8 * (same / cnt) : 0);
      }
      if (i === 0) {
        const from = prevNote ? prevNote.midi : Math.round(centerAt(0));
        cost[i][j] = local + 0.25 * Math.abs(m - from);
        continue;
      }
      for (let q = 0; q < cand[i - 1].length; q++) {
        const p = cand[i - 1][q];
        const iv = Math.abs(m - p);
        // 前後の和音に共通する音は、のばしたまま（動くなら半音・全音。跳ばない）
        let tc = iv === 0 ? -0.05 : iv <= 2 ? 0.05 : iv <= 4 ? 0.3 : iv <= 7 ? 1.2 : 3;
        if (rising && m < p) tc += 0.5;
        // 学んだ「コードが変わる所のつながり」（例：次のコードの 4度にいた音は 3度へ）
        if (hasLineModel()) {
          const r = ctx.chordRoot(spans[i].x);
          const c = connectLp(pcOf(p - r), pcOf(m - r));
          if (c != null) tc -= 0.35 * (c + 2.3);
        }
        const v = cost[i - 1][q] + tc + local;
        if (v < cost[i][j]) { cost[i][j] = v; back[i][j] = q; }
      }
    }
  }
  let j = 0;
  for (let q = 1; q < cand[N - 1].length; q++) if (cost[N - 1][q] < cost[N - 1][j]) j = q;
  const pick = new Array(N);
  for (let i = N - 1; i >= 0; i--) { pick[i] = cand[i][j]; j = back[i][j]; }
  const motion = ctx.settings.motion ?? 1;
  const unit = an.bpm >= 140 ? 1 : 0.5; // つなぎの音の長さ（拍）
  const maxHold = Math.max(4, Math.min(8, Math.floor(6.5 / (60 / an.bpm)))); // 1 回の弓でのばせる長さ（拍）
  let last = prevNote;
  let held = null, heldX = 0, heldLen = 0; // 共通音でのばしている音
  for (let i = startIdx; i < N; i++) {
    const sp = spans[i];
    const m = pick[i];
    const next = i + 1 < N ? pick[i + 1] : null;
    // 伴奏の動き「ほどよく」以上：次の和音の音へ、音階でつなぐ（例：ミ〜〜〜 レ↘ド）
    let approach = [];
    const xEndA = sp.x + sp.len;
    let vocalMoves = false;
    for (let st = Math.round((xEndA - 1) * 4); st < Math.round(xEndA * 4); st++) { const vs = ctx.vocalState(st); if (vs && vs.state === 'on') vocalMoves = true; }
    if (motion >= 1 && next != null && next !== m && sp.len >= 2 && !vocalMoves && rand() < (motion >= 2 ? 0.8 : 0.55)) {
      const n2 = Math.min(2, Math.round(1 / unit));
      const xEnd = sp.x + sp.len;
      const dir = next > m ? -1 : 1; // 次の音へ、反対側から近づく
      const sc = ctx.scalePcs(xEnd - 0.5);
      let p = next;
      const seq = [];
      for (let k = 0; k < n2; k++) { p = stepScale(p, dir, sc); seq.unshift(p); }
      const ok = seq.every((q, k) => ctx.tension(q, xEnd - (n2 - k) * unit) <= 1 && Math.abs(q - m) <= 7);
      if (ok) approach = seq.map((q, k) => ({ x: xEnd - (n2 - k) * unit, len: unit, midi: q }));
    }
    const mainLen = sp.len - approach.length * unit;
    const phrasePos = (i - startIdx) / Math.max(1, N - startIdx - 1);
    const vel = clamp(0.22 + 0.4 * inten + (rising ? 0.2 * phrasePos : 0.06 * Math.sin(Math.PI * phrasePos)), 0.15, 0.85);
    if (held && held.midi === m && heldLen + mainLen <= maxHold) {
      // 前の和音と同じ音：弓を返さずにのばす（タイ）
      heldLen += mainLen;
      held.d = ctx.beatTime(heldX + heldLen) - held.t;
    } else {
      let x0 = sp.x, len0 = mainLen;
      // 掛留：前の音が新しい和音でも濁らず（和音の外の音）、次の音のとなりなら、1 拍残してから解決する
      if (held && motion >= 1 && len0 >= 2 && Math.abs(held.midi - m) <= 2 && !ctx.chordPcs(sp.x).includes(pcOf(held.midi)) && ctx.tension(held.midi, sp.x) <= 1 && ctx.tension(held.midi, sp.x + 0.75) <= 1 && rand() < 0.4) {
        heldLen += 1;
        held.d = ctx.beatTime(heldX + heldLen) - held.t;
        held.vib = 1;
        x0 += 1; len0 -= 1;
      }
      const t = ctx.beatTime(x0), te = ctx.beatTime(x0 + len0);
      const n = { t, d: te - t, midi: m, vel, art: te - t > 1.2 ? 'sneak' : 'sus', legato: !!last && last.midi !== m && Math.abs(last.t + last.d - t) < 0.05, shape: 'swell', role: 'pad', sec: item.si };
      out.push(n);
      last = n;
      held = n; heldX = x0; heldLen = len0;
    }
    if (approach.length) held = null;
    for (const a of approach) {
      const ta = ctx.beatTime(a.x), tb = ctx.beatTime(a.x + a.len);
      const an2 = { t: ta, d: tb - ta, midi: a.midi, vel: clamp(vel * 0.9, 0.15, 0.8), art: 'sus', legato: true, shape: 'flat', role: 'pad', sec: item.si };
      out.push(an2);
      last = an2;
    }
  }
  return last;
}

// ───────────────────────── 分散和音（アルペジオ）：和音の音を 8 分で上り下り
const ARP_PATTERNS = [[0, 1, 2, 1], [0, 2, 1, 2], [0, 1, 2, 3], [2, 1, 0, 1], [0, 2, 3, 1]];
function genArp(ctx, item, out, prevNote) {
  const { an, rand } = ctx;
  const bars = sectionBars(an, item.sec).filter((b) => !b.pickup);
  if (!bars.length) return prevNote;
  const unit = an.bpm >= 140 ? 1 : 0.5;
  const pat = ARP_PATTERNS[Math.floor(rand() * ARP_PATTERNS.length)];
  const lo = 60, hi = 81;
  let base = prevNote ? clamp(prevNote.midi - 5, 62, 70) : 65;
  let last = prevNote;
  let k = 0;
  const inten = item.intensity;
  // 1 番の Aメロなど低い段階は、弦をはじくピチカートで軽く（弓の分散和音と質感を変える）
  const pizz = (item.level ?? 2) <= 1 && item.sec.vocal;
  for (const bar of bars) {
    for (let pos = 0; pos < bar.n - 1e-6; pos += unit, k++) {
      const x = bar.b0 + pos;
      const pcs = ctx.chordPcs(x);
      const tones = [];
      for (let m = lo; m <= hi; m++) if (pcs.includes(pcOf(m))) tones.push(m);
      if (!tones.length) continue;
      // 前の形に近い、下から 4 つの音
      let st = tones.findIndex((m) => m >= base - 1);
      if (st < 0) st = Math.max(0, tones.length - 4);
      const voicing = tones.slice(st, st + 4);
      while (voicing.length < 4 && st > 0) voicing.unshift(tones[--st]);
      if (pos === 0) base = voicing[0];
      const m = voicing[Math.min(voicing.length - 1, pat[k % pat.length])];
      const t = ctx.beatTime(x), te = ctx.beatTime(x + unit);
      const accent = pos === 0 ? 0.06 : 0;
      const n = pizz
        ? { t, d: (te - t) * 0.95, midi: m, vel: clamp(0.36 + 0.22 * inten + accent, 0.2, 0.75), art: 'pizz', legato: false, shape: 'flat', role: 'arp', sec: item.si }
        : { t, d: (te - t) * 0.95, midi: m, vel: clamp(0.24 + 0.22 * inten + accent, 0.15, 0.6), art: 'sus', legato: pos > 0, shape: 'flat', role: 'arp', sec: item.si };
      out.push(n);
      last = n;
    }
  }
  return last;
}

// ───────────────────────── 刻み：同じ音をリズムでくり返す（ポップスの弦の定番）
const RHYTHM_PATTERNS = {
  eighth: [0, 2, 4, 6, 8, 10, 12, 14],
  sync332: [0, 3, 6, 8, 11, 14], // 3+3+2 のシンコペーション
  gallop: [0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15],
  offbeat: [2, 6, 10, 14], // 裏拍だけ
};
function genRhythm(ctx, item, out, prevNote) {
  const { an, rand } = ctx;
  const bars = sectionBars(an, item.sec).filter((b) => !b.pickup && b.n === an.meter);
  if (!bars.length) return prevNote;
  const fast = an.bpm >= 140;
  const names = fast ? ['eighth', 'sync332', 'offbeat'] : ['eighth', 'sync332', 'gallop', 'sync332'];
  let pat = RHYTHM_PATTERNS[names[Math.floor(rand() * names.length)]].filter((s) => s < an.meter * 4);
  // この曲のドラム・ベースのリズムに乗る：区間の中で、キック・ベースとスネアが強い 16 分を刻む
  if (ctx.grooveAt && an.meter === 4) {
    const acc = new Array(16).fill(0);
    let nb = 0;
    for (const bar of bars) { const g = ctx.grooveAt(bar.b0); if (!g) continue; nb++; for (let k = 0; k < 16; k++) acc[k] += 0.7 * g.k[k] + 0.6 * g.s[k] + 0.15 * g.h[k]; }
    if (nb) {
      for (let k = 0; k < 16; k++) acc[k] /= nb;
      const order = acc.map((v, k) => [v, k]).sort((a, b) => b[0] - a[0]);
      const want = fast ? 4 : (ctx.settings.motion ?? 1) >= 2 ? 7 : 5; // 刻む数（速い曲は少なめ）
      const thr = Math.max(0.3, order[Math.min(15, want - 1)][0] * 0.95);
      const picked = order.filter(([v]) => v >= thr).slice(0, want + 2).map(([, k]) => k).filter((k) => fast ? k % 2 === 0 : true).sort((a, b) => a - b);
      if (picked.length >= 3) pat = picked;
    }
  }
  const lvR = item.level ?? 2;
  if (an.meter === 4 && lvR <= 1) pat = (rand() < 0.6 ? [2, 6, 10, 14] : [4, 12]); // 静かな所は裏拍（または 2・4 拍）だけ
  else if (an.meter === 4 && lvR === 2 && !fast) pat = [0, 2, 4, 6, 8, 10, 12, 14];
  const rising = item.sec.type === 'pre';
  let m = prevNote ? clamp(prevNote.midi, 69, 81) : 74;
  let last = prevNote;
  bars.forEach((bar, bi) => {
    // 2 小節に 1 回、16 分を 1 つ足して押す（4 分・8 分を並べただけの機械的な刻みにしない）
    let pb = pat;
    if (bi % 2 === 1 && pat.length >= 2 && an.meter === 4) {
      const lastS = pat[pat.length - 1];
      if (lastS - 1 > pat[pat.length - 2]) pb = [...pat.slice(0, -1), lastS - 1, lastS];
    }
    pb.forEach((s16, k) => {
      const x = bar.b0 + s16 / 4;
      const pcs = ctx.chordPcs(x);
      if (!pcs.includes(pcOf(m))) m = nearestIn(m, pcs, 67, 84);
      const nextS = k + 1 < pb.length ? pb[k + 1] : an.meter * 4;
      const t = ctx.beatTime(x), te = ctx.beatTime(bar.b0 + nextS / 4);
      const prog = (bi + k / pb.length) / bars.length;
      const vel = clamp((rising ? 0.28 + 0.4 * prog : 0.3 + 0.3 * item.intensity) + 0.12 * (ctx.accentAtStep(bar.b0 * 4 + s16) - 0.4), 0.15, 0.85);
      const n = { t, d: Math.min(te - t, ctx.beatLen(x) * 0.5) * 0.9, midi: m, vel, art: 'mrc', legato: false, shape: 'flat', role: 'rhythm', sec: item.si };
      out.push(n);
      last = n;
    });
  });
  return last;
}

// ───────────────────────── 合いの手（歌の切れ目に短いフレーズ）
function addFills(ctx, item, out) {
  const { an, rand } = ctx;
  const sec = item.sec;
  const bars = sectionBars(an, sec).filter((b) => !b.pickup);
  const presence = ctx.settings.presence ?? 0.6;
  if (presence < 0.4) return;
  const meter = an.meter;
  for (let k = 3; k < bars.length; k += 4) {
    const bar = bars[k];
    if (k + 1 >= bars.length && item.si === an.sections.length - 1) continue;
    // 小節の後半で歌が切れているか
    const xs = bar.b0 + Math.floor(meter / 2);
    let vMin = 1, vSec = 0, cnt = 0;
    for (let x = xs; x < bar.b0 + bar.n; x++) vMin = Math.min(vMin, ctx.vocalAt(x));
    for (const b of bars) for (let q = 0; q < b.n; q++) { vSec += ctx.vocalAt(b.b0 + q); cnt++; }
    vSec /= Math.max(1, cnt);
    if (!(vMin < vSec * 0.55 || vMin < 0.12)) continue;
    if (rand() > 0.45 + 0.4 * presence) continue;
    // 次の小節の頭の音（なければ和音の音）へ向かう
    const tFill = ctx.beatTime(xs), tEnd = ctx.beatTime(bar.b0 + bar.n);
    const next = out.find((n) => n.t >= tEnd - 0.02 && n.t < tEnd + 0.3);
    const cur = out.filter((n) => n.t < tFill && n.t + n.d > tFill).pop();
    const target = next ? next.midi : cur ? cur.midi : 76;
    const sc = ctx.scalePcs(xs);
    const steps = meter - Math.floor(meter / 2) >= 2 ? 4 : 2;
    const dir = rand() < 0.5 ? 1 : -1;
    const notes = [];
    let m = target;
    for (let s = 0; s < steps; s++) {
      // 目標から音階を逆向きにたどって、そこへ流れ込む
      m = stepScale(m, dir, sc);
      notes.unshift(m);
    }
    if (cur) cur.d = Math.max(0.15, tFill - cur.t);
    const dur = (tEnd - tFill) / steps;
    notes.forEach((mm, i) => {
      out.push({ t: tFill + i * dur, d: dur, midi: clamp(mm, LOW, HIGH), vel: 0.45 + 0.2 * item.intensity, art: 'sus', legato: i > 0, shape: 'flat', role: 'fill', sec: item.si });
    });
  }
}
function stepScale(m, dir, sc) {
  let x = m;
  for (let k = 0; k < 3; k++) {
    x += dir;
    if (sc.includes(pcOf(x))) return x;
  }
  return m + dir * 2;
}
function nearestIn(m, pcs, lo = LOW, hi = HIGH) {
  let best = null;
  for (let d = 0; d <= 12; d++) {
    for (const s of [m + d, m - d]) {
      if (s < lo || s > hi) continue;
      if (pcs.includes(pcOf(s))) { best = s; break; }
    }
    if (best != null) break;
  }
  return best ?? clamp(m, lo, hi);
}

// ───────────────────────── 対旋律（サビ）
const COUNTER_RHYTHMS = {
  // 1小節の中の音の長さ（拍）
  calm: [[4], [2, 2], [3, 1]],
  move: [[2, 2], [2, 1, 1], [1, 1, 2], [3, 1], [1.5, 0.5, 2]],
  busy: [[1, 1, 1, 1], [2, 1, 1], [1, 0.5, 0.5, 2], [0.5, 0.5, 1, 2]],
  // シンコペーション（付点 4 分＋付点 4 分＋4 分、裏拍から入る）
  sync: [[1.5, 1.5, 1], [0.5, 1.5, 2], [1.5, 0.5, 2], [0.75, 0.25, 1, 2]],
};
function genCounter(ctx, item, out, prevNote) {
  const { an, rand } = ctx;
  const sec = item.sec;
  const bars = sectionBars(an, sec).filter((b) => !b.pickup);
  if (!bars.length) return prevNote;
  const inten = item.intensity;
  const low = item.registerLow ?? 69, high = item.registerHigh ?? (inten > 0.8 ? 89 : 86);
  const meter = an.meter;
  // 音の位置を作る（歌が強いところは長く、弱いところは動く）
  const slots = [];
  bars.forEach((bar, bi) => {
    let v = 0;
    for (let q = 0; q < bar.n; q++) v += ctx.vocalAt(bar.b0 + q);
    v /= bar.n;
    const endOfPhrase = bi % 4 === 3;
    const presence = ctx.settings.presence ?? 0.6;
    const motion = ctx.settings.motion ?? 1;
    let pool = motion === 0 || ((v > 0.75 || presence < 0.45) && motion < 2) ? COUNTER_RHYTHMS.calm
      : motion >= 2 && !endOfPhrase ? (v < 0.6 ? COUNTER_RHYTHMS.busy : COUNTER_RHYTHMS.sync)
      : v < 0.25 && inten > 0.75 && !endOfPhrase ? COUNTER_RHYTHMS.busy : COUNTER_RHYTHMS.move;
    if (endOfPhrase) pool = [[2, 2], [3, 1], [4]];
    let pat = pool[Math.floor(rand() * pool.length)];
    if (meter !== 4) pat = meter === 3 ? [[3], [2, 1], [1, 1, 1]][Math.floor(rand() * 3)] : [meter];
    let pos = 0;
    for (const len of pat) {
      if (pos + len > bar.n + 1e-6) break;
      slots.push({ x: bar.b0 + pos, len, strong: pos === 0 || (meter === 4 && pos === 2) || len >= 2, bar: bi });
      pos += len;
    }
  });
  const N = slots.length;
  const centerAt = (i) => {
    const ph = i / Math.max(1, N - 1);
    return low + (high - low) * (0.45 + 0.35 * Math.sin(Math.PI * Math.min(1, ph * 1.15)));
  };
  const cand = slots.map((sl) => {
    const list = [];
    for (let m = low; m <= high; m++) {
      const tns = ctx.tension(m, sl.x);
      if (tns > 1) continue;
      if (sl.strong && tns > 0) continue;
      // 長い音は、続く拍でも濁らないこと
      let ok = true;
      for (let k = 1; k < Math.ceil(sl.len); k++) if (ctx.tension(m, sl.x + k) > (sl.strong ? 0 : 1)) ok = false;
      if (ok) list.push({ m, nct: tns > 0 });
    }
    if (!list.length) list.push({ m: nearestIn(Math.round(centerAt(0)), ctx.chordPcs(sl.x), low, high), nct: false });
    return list;
  });
  const cost = [], back = [];
  for (let i = 0; i < N; i++) {
    cost.push(new Array(cand[i].length).fill(Infinity));
    back.push(new Array(cand[i].length).fill(-1));
    for (let j = 0; j < cand[i].length; j++) {
      const { m, nct } = cand[i][j];
      const local = (nct ? 0.6 : PC_ROLE_COST(m, ctx, slots[i].x) * 0.6) + 0.06 * Math.abs(m - centerAt(i)) + rand() * 0.15;
      if (i === 0) {
        const from = prevNote ? prevNote.midi : Math.round(centerAt(0));
        cost[i][j] = local + 0.15 * Math.abs(m - from);
        continue;
      }
      for (let q = 0; q < cand[i - 1].length; q++) {
        const p = cand[i - 1][q];
        const iv = Math.abs(m - p.m);
        let tc = iv === 0 ? 0.6 : iv <= 2 ? 0 : iv <= 4 ? 0.25 : iv <= 7 ? 0.9 : iv <= 9 ? 2 : 4;
        if (p.nct && iv > 2) tc += 3; // 経過音は音階でぬける
        if (nct && iv > 2) tc += 3;
        const v = cost[i - 1][q] + tc + local;
        if (v < cost[i][j]) { cost[i][j] = v; back[i][j] = q; }
      }
    }
  }
  let j = 0;
  for (let q = 1; q < cand[N - 1].length; q++) if (cost[N - 1][q] < cost[N - 1][j]) j = q;
  const pick = new Array(N);
  for (let i = N - 1; i >= 0; i--) { pick[i] = cand[i][j].m; j = back[i][j]; }
  let last = prevNote;
  slots.forEach((sl, i) => {
    const t = ctx.beatTime(sl.x), te = ctx.beatTime(sl.x + sl.len);
    const ph = i / Math.max(1, N - 1);
    const vel = clamp(0.35 + 0.45 * inten + 0.1 * Math.sin(Math.PI * ph) + (sl.strong ? 0.03 : -0.03), 0.2, 0.95);
    const long = te - t >= 0.9;
    const n = { t, d: te - t, midi: pick[i], vel, art: long && i === 0 ? 'sneak' : 'sus', legato: i > 0, shape: long ? 'swell' : 'flat', role: 'counter', sec: item.si };
    if (long && rand() < ctx.style.slide * 0.5 && last && pick[i] > last.midi + 2) n.slide = -2;
    out.push(n);
    last = n;
  });
  return last;
}


// ───────────────────────── 学んだ統計で作る線（ソロ・対旋律・合いの手）
// 線（genLine の結果）を、鳴らす音符にする
function lineToNotes(ctx, item, ln, role, velOf, opt = {}) {
  const { rand, style } = ctx;
  const out = [];
  let peak = null;
  for (const n of ln) if (n.len >= 0.75 && (!peak || n.midi > peak.midi)) peak = n;
  const dyn = dynamicsFor(ln);
  ln.forEach((n, i) => {
    const t = ctx.beatTime(n.x), te = ctx.beatTime(n.x + n.len);
    const d = te - t;
    const pv = ln[i - 1];
    const touching = pv && Math.abs(pv.x + pv.len - n.x) < 1e-6;
    const note = {
      t, d, midi: n.midi, vel: clamp(velOf(n, i) + dyn[i] + (opt.grooveAccent ? 0.1 * (ctx.accentAtStep(Math.round(n.x * 4)) - 0.4) : 0), 0.15, 1),
      art: !touching && d > 0.9 ? 'sneak' : !touching && d < 0.3 && n.onBeat && opt.accent ? 'mrc' : 'sus',
      legato: !!touching, shape: d >= 0.8 ? 'swell' : 'flat', role, sec: item.si,
    };
    if (d >= 0.6 && pv && n.midi - pv.midi >= 4 && rand() < style.slide) note.slide = -2;
    if (n.len >= 1 && (n === peak || n.phraseEnd)) note.vib = 1;
    out.push(note);
  });
  return out;
}
const barsOf = (ctx, item) => sectionBars(ctx.an, item.sec).filter((b) => !b.pickup && b.n === 4);
// 次の区間のはじめの音（つながりの目標）
function nextTargetPitch(ctx, item, center) {
  const an = ctx.an;
  const nextSec = an.sections[item.si + 1];
  if (!nextSec) return null;
  const x = an.bars[nextSec.bar0].b0;
  // 次が歌なら、歌い出しの音（推定）へ。なければ次のコードの音
  const v = ctx.nextVocalNote(x * 4);
  if (v != null) { let m = v; while (m < center - 7) m += 12; while (m > center + 7) m -= 12; return m; }
  const pcs = ctx.chordPcs(x);
  return nearestIn(Math.round(center), pcs, 55, 91);
}

function genSoloLine(ctx, item, out, prevNote, nextIsVocal, onlyBars) {
  const bars = onlyBars || barsOf(ctx, item);
  if (bars.length < 1) return prevNote;
  const sec = item.sec;
  const isIntro = sec.type === 'intro', isOutro = sec.type === 'outro';
  const motion = ctx.settings.soloMotion ?? 1;
  const inten = item.intensity;
  // 1 小節の音の数のめやす（はじめ → 終わりでだんだん増える）
  const dens = [[[2, 5], [3, 7]], [[3, 7], [6, 11]], [[5, 10], [8, 14]]][motion];
  const N = bars.length;
  const startC = prevNote ? clamp(prevNote.midi, 69, 81) : 74;
  const hi = isIntro || isOutro ? 86 : 90;
  const center = (p) => clamp(startC + (isOutro ? -2 : 8 * inten) * Math.sin((Math.PI / 2) * Math.min(1, p * 1.2)), 66, hi - 4);
  const ln = genLine(ctx, {
    kind: 'solo', bars,
    densityAt: (bi) => { const p = bi / Math.max(1, N - 1); const a = dens[0], b = dens[1]; return [Math.round(a[0] + (b[0] - a[0]) * p), Math.round(a[1] + (b[1] - a[1]) * p)]; },
    lo: 62, hi, center, prev: prevNote ? prevNote.midi : null,
    target: nextTargetPitch(ctx, item, center(1)),
    endLong: !nextIsVocal, endRest: nextIsVocal,
    phraseBars: motion === 2 ? 4 : 2, // 2〜4 小節ごとに息つぎ
    grooveAt: ctx.grooveAt,
    beam: 28,
    motif: true, // 動機をくり返して組み立てる
  });
  if (!ln.length) return genSoloV3(ctx, item, out, prevNote, nextIsVocal, sectionBars(ctx.an, sec).filter((b) => !b.pickup));
  // 最後の音：次が歌でなければ長くのばして決める
  const last = ln[ln.length - 1];
  const end = bars[N - 1].b0 + 4;
  if (!nextIsVocal && end - last.x > last.len) last.len = Math.min(end - last.x, Math.max(last.len, 2));
  const notes = lineToNotes(ctx, item, ln, 'solo', (n, i) => 0.45 + 0.4 * inten * (0.75 + 0.25 * (i / ln.length)), { accent: inten > 0.6, grooveAccent: true });
  const lastOut = notes[notes.length - 1];
  if (lastOut) { lastOut.vib = 1; lastOut.shape = nextIsVocal ? 'fade' : 'swell'; }
  out.push(...notes);
  return lastOut || prevNote;
}

// サビの入りの着地の音：和音の音（根音より 3 度・5 度）、歌と同じ音名・2度でこすれる音を避け、目安の高さに近い音
function landingPitch(ctx, x, center, beats) {
  const pcs = ctx.chordPcs(x);
  let best = null, bs = Infinity;
  for (let m = 60; m <= 91; m++) {
    if (!pcs.includes(pcOf(m))) continue;
    let ok = true;
    for (let k = 0; k < beats; k += 0.5) if (ctx.tension(m, x + k) > 1) ok = false;
    if (!ok) continue;
    let c = 0.08 * Math.abs(m - center) + PC_ROLE_COST(m, ctx, x);
    for (let k = 0; k < beats * 4; k++) {
      const v = ctx.vocalPitch(Math.round(x * 4) + k);
      if (v == null) continue;
      const d = Math.abs(m - v) % 12;
      if (d === 0) c += 0.15;
      if (d === 1 || d === 2 || d === 10 || d === 11) c += 0.1;
    }
    if (c < bs) { bs = c; best = m; }
  }
  return best;
}

function genCounterLine(ctx, item, out, prevNote) {
  let bars = barsOf(ctx, item);
  if (!bars.length) return prevNote;
  const motion = ctx.settings.motion ?? 1;
  const inten = item.intensity;
  const lv = item.level ?? 3;
  // 音数：1 回目のサビは控えめ、最後のサビがいちばん動く
  const dens = (lv <= 2 ? [[1, 2], [1, 3], [2, 5]] : lv === 3 ? [[1, 3], [2, 5], [3, 7]] : [[2, 4], [3, 7], [4, 10]])[motion];
  const reg = registerFor(ctx, item, 'counter');
  // サビの頭は 1 小節のばす音（駆け上がりの着地）。対旋律として動くのは 2 小節目から
  let landing = null;
  if (bars.length >= 4) {
    const x = bars[0].b0;
    const m = landingPitch(ctx, x, reg.center, 4);
    if (m != null) {
      const t = ctx.beatTime(x), te = ctx.beatTime(x + 4);
      landing = { t, d: te - t, midi: m, vel: clamp(0.38 + 0.42 * inten, 0.2, 0.9), art: 'sus', legato: false, shape: 'swell', role: 'counter', sec: item.si, vib: 1 };
      bars = bars.slice(1);
    }
  }
  const center = (p) => reg.center + 3 * Math.sin(Math.PI * Math.min(1, p * 1.1));
  // 歌が細かく動いている間はのばし、動くのは歌の息つぎと、歌が音をのばしている所で（弦のアレンジの基本）
  const shapeRhythm = (notes) => {
    if (!ctx.hasVocalLine) return notes;
    const out2 = [];
    for (const nt of notes) {
      const st = ctx.vocalState(nt.step);
      const singing = st && st.state === 'on';
      const prevNt = out2[out2.length - 1];
      if (singing && nt.len < 4 && prevNt && nt.step - (prevNt.step + prevNt.len) <= 1) { prevNt.len = nt.step + nt.len - prevNt.step; continue; }
      out2.push({ ...nt });
    }
    return out2;
  };
  const ln = bars.length ? genLine(ctx, {
    kind: 'counter', bars, densityAt: () => dens, shapeRhythm,
    lo: reg.lo, hi: reg.hi, center, prev: landing ? landing.midi : prevNote ? prevNote.midi : null,
    target: nextTargetPitch(ctx, item, center(1)),
    vocalPitch: ctx.vocalPitch, vocalState: ctx.hasVocalLine ? ctx.vocalState : null, fillWeight: 0.9, vocalWeight: 0.8,
    endLong: true, phraseBars: 4, grooveAt: ctx.grooveAt, beam: 24, avoidRoot: 1.2,
  }) : [];
  if (!ln.length && !landing) return genCounter(ctx, item, out, prevNote);
  const notes = lineToNotes(ctx, item, ln, 'counter', (n, i) => 0.35 + 0.42 * inten + 0.08 * Math.sin((Math.PI * i) / Math.max(1, ln.length - 1)), { grooveAccent: true });
  if (landing) out.push(landing);
  out.push(...notes);
  return notes[notes.length - 1] || landing || prevNote;
}

// 合いの手：歌の息つぎ（1.5 拍以上の休み）に、次に歌い出す音へつながる短いフレーズ
function addLineFills(ctx, item, out) {
  const { an, rand } = ctx;
  const presence = ctx.settings.presence ?? 0.6, motion = ctx.settings.motion ?? 1;
  if (presence < 0.4 || !ctx.hasVocalLine) return false;
  const bars = barsOf(ctx, item);
  if (!bars.length) return false;
  const s0 = bars[0].b0 * 4, s1 = (bars[bars.length - 1].b0 + 4) * 4;
  const gaps = [];
  let a = null;
  for (let st = s0; st <= s1; st++) {
    const v = st < s1 ? ctx.vocalPitch(st) : 0;
    if (v == null) { if (a == null) a = st; }
    else { if (a != null && st - a >= 6 && st < s1) gaps.push([a, st]); a = null; }
  }
  const p = Math.min(0.85, 0.25 + 0.3 * presence + 0.15 * motion);
  let made = 0;
  for (const [ga, gb] of gaps) {
    // ピアノ・ギターがフレーズを入れている息つぎは、なるべくそれをバイオリンで弾く
    const instHere = lineNotesFrom(ctx, ctx.leadPitch, ga, gb).filter((n) => n.len >= 1);
    const instPlays = instHere.length >= 3 && instHere.reduce((a, n) => a + n.len, 0) >= 5;
    if (rand() > (instPlays ? Math.max(p, 0.85) : p)) continue;
    const fa = Math.max(ga + 1, gb - (motion >= 2 ? 12 : 8)), fb = gb - 1; // 歌い出しの 16 分ひとつ前で終わる
    if (fb - fa < 3) continue;
    const firstBar = Math.floor(fa / 16), lastBar = Math.floor((fb - 1) / 16);
    const bs = an.bars.filter((b) => !b.pickup && b.n === 4 && Math.floor((b.b0 * 4) / 16) >= firstBar - 0 && b.b0 * 4 <= fb && b.b0 * 4 + 16 > fa);
    if (!bs.length) continue;
    const before = out.filter((n) => n.t < ctx.beatTime(fa / 4)).pop();
    const v = ctx.nextVocalNote(gb);
    const center = before ? before.midi : 76;
    let target = null;
    if (v != null) { target = v; while (target < center - 6) target += 12; while (target > center + 6) target -= 12; }
    // ピアノ・ギターなどが、この息つぎにフレーズを入れていれば、それをバイオリンでまねる
    const inst = lineNotesFrom(ctx, ctx.leadPitch, fa - 2, fb).filter((n) => n.len >= 1);
    if (inst.length >= 3 && inst.reduce((a, n) => a + n.len, 0) >= 5) {
      let shift = 0;
      const med = inst.map((n) => n.m).sort((x, y) => x - y)[inst.length >> 1];
      while (med + shift < 69) shift += 12;
      while (med + shift > 86) shift -= 12;
      const ok = inst.every((n) => ctx.tension(n.m + shift, n.s / 4) <= 1);
      if (ok) {
        const tFill = ctx.beatTime(inst[0].s / 4);
        for (const nn of out) if (nn.t < tFill && nn.t + nn.d > tFill) nn.d = Math.max(0.12, tFill - nn.t);
        inst.forEach((n, k) => {
          const t = ctx.beatTime(n.s / 4), te = ctx.beatTime(Math.min(n.s + n.len, fb) / 4);
          out.push({ t, d: Math.max(0.08, (te - t) * 0.97), midi: clamp(n.m + shift, LOW, HIGH), vel: clamp((before ? before.vel : 0.4) + 0.1, 0.3, 0.7), art: 'sus', legato: k > 0 && inst[k - 1].s + inst[k - 1].len === n.s, shape: 'flat', role: 'copy', sec: item.si });
        });
        made++;
        continue;
      }
    }
    // 歌のフレーズのあとなら、その形をまねて答える（掛け合い）ことも
    const vocNotes = lineNotesFrom(ctx, ctx.vocalPitch, Math.max(s0, ga - 24), ga);
    if (rand() < 0.45 && vocNotes.length >= 3) {
      const echo = echoPhrase(ctx, vocNotes, ga, gb, before ? before.midi : null, target);
      if (echo) {
        const tFill = ctx.beatTime(echo[0].s / 4);
        for (const nn of out) if (nn.t < tFill && nn.t + nn.d > tFill) nn.d = Math.max(0.12, tFill - nn.t);
        echo.forEach((e, k) => {
          const t = ctx.beatTime(e.s / 4), te = ctx.beatTime((e.s + e.len) / 4);
          out.push({ t, d: (te - t) * 0.97, midi: e.m, vel: clamp((before ? before.vel : 0.4) + 0.08, 0.3, 0.7), art: 'sus', legato: k > 0, shape: 'flat', role: 'answer', sec: item.si });
        });
        made++;
        continue;
      }
    }
    const ln = genLine(ctx, {
      kind: 'fill', bars: bs, densityAt: () => [3, 12],
      keep: (n) => n.step >= fa && n.step < fb,
      lo: 64, hi: 86, center: () => center, prev: before ? before.midi : null, target,
      vocalPitch: ctx.vocalPitch, vocalState: ctx.vocalState, fillWeight: 1.5, grooveAt: ctx.grooveAt, beam: 20,
      penta: 0.35, endLong: true,
    });
    if (ln.length < 2) continue;
    // 歌い出しまでに終わる
    for (const n of ln) if ((n.x + n.len) * 4 > fb) n.len = Math.max(0.25, fb / 4 - n.x);
    // 下でのびている伴奏の音は、合いの手の前で切る
    const tFill = ctx.beatTime(ln[0].x);
    for (const nn of out) if (nn.t < tFill && nn.t + nn.d > tFill) nn.d = Math.max(0.12, tFill - nn.t);
    const vel0 = before ? before.vel : 0.4;
    out.push(...lineToNotes(ctx, item, ln, 'fill', () => clamp(vel0 + 0.08, 0.3, 0.7)));
    made++;
  }
  return made > 0 || gaps.length > 0;
}


// ───────────────────────── 同じメロディ：歌（または楽器）のメロディを、バイオリンの高さで重ねる
// 推定のメロディなので、短すぎる音・原曲と濁る音は弾かない（まちがった音を重ねないため）
function sourceLine(ctx, sec) { return sec.vocal ? ctx.vocalPitch : ctx.leadPitch; }
function lineNotesFrom(ctx, get, s0, s1) {
  const notes = [];
  for (let st = s0; st < s1; st++) {
    const v = get(st);
    if (v == null) continue;
    const last = notes[notes.length - 1];
    if (last && last.m === v && last.s + last.len === st) last.len++;
    else notes.push({ s: st, len: 1, m: v });
  }
  return notes;
}
// 歌を音符どおりに重ねると、歌い手の細かいリズムとずれて「カラオケのガイド」になる。
// 骨組みの音（拍の頭の長めの音）だけを、次の骨組みの音までのばして、歌の 1 オクターブ上で（高すぎれば 3度上のハモり）
function genVocalDouble(ctx, item, out, prevNote) {
  const bars = barsOf(ctx, item);
  if (!bars.length) return prevNote;
  const s0 = bars[0].b0 * 4, s1 = (bars[bars.length - 1].b0 + 4) * 4;
  const src = lineNotesFrom(ctx, ctx.vocalPitch, s0, s1);
  const sk = src.filter((n) => n.len >= 3 || (n.s % 4 === 0 && n.len >= 2));
  if (sk.length < 3) return genCounterLine(ctx, item, out, prevNote);
  const vr = vocalRangeOf(ctx, item) || { med: 70 };
  const octave = vr.med + 12 <= 88;
  const inten = item.intensity;
  let last = prevNote;
  sk.forEach((n, i) => {
    const nx = sk[i + 1];
    const end = Math.min(nx ? nx.s : s1, n.s + 16);
    let m;
    if (octave) m = n.m + 12;
    else {
      const sc = ctx.scalePcs(n.s / 4);
      m = stepScale(stepScale(n.m, 1, sc), 1, sc);
      if (m > 88) m -= 12;
    }
    m = clamp(m, LOW, HIGH);
    if (ctx.tension(m, n.s / 4) > 1) return;
    const t = ctx.beatTime(n.s / 4), te = ctx.beatTime(end / 4);
    const note = { t, d: (te - t) * 0.97, midi: m, vel: clamp(0.4 + 0.35 * inten, 0.2, 0.85), art: 'sus', legato: !!(nx && end === nx.s), shape: end - n.s >= 6 ? 'swell' : 'flat', role: 'double', sec: item.si };
    if (end - n.s >= 6) note.vib = 1;
    out.push(note);
    last = note;
  });
  return last;
}

function genDouble(ctx, item, out, prevNote) {
  if (item.sec.vocal) return genVocalDouble(ctx, item, out, prevNote);
  const bars = barsOf(ctx, item);
  if (!bars.length) return prevNote;
  const s0 = bars[0].b0 * 4, s1 = (bars[bars.length - 1].b0 + 4) * 4;
  const src = lineNotesFrom(ctx, sourceLine(ctx, item.sec), s0, s1).filter((n) => n.len >= 2);
  if (src.length < 4) return genCounterLine(ctx, item, out, prevNote);
  // バイオリンのよく響く高さ（A4〜A5 あたり）へ、オクターブで移す
  const ms = src.map((n) => n.m).sort((a, b) => a - b);
  const med = ms[ms.length >> 1];
  let shift = 0;
  while (med + shift < 72) shift += 12;
  while (med + shift > 84) shift -= 12;
  const inten = item.intensity;
  // 推定がオクターブちがいの音（倍音・下のパート）を拾うことがあるので、まわりの音（前後 3 音の真ん中の高さ）から
  // 6度より離れた音は、いちばん近いオクターブへ寄せる（ほんとうの跳躍は 6度までは残す）
  const base = med + shift;
  const near = (m, r) => r + ((((m - r + 6) % 12) + 12) % 12) - 6;
  const folded = src.map((n) => near(n.m + shift, base));
  const kept = [];
  src.forEach((n, i) => {
    const w = [];
    for (let j = Math.max(0, i - 3); j <= Math.min(src.length - 1, i + 3); j++) if (j !== i) w.push(folded[j]);
    w.sort((x, y) => x - y);
    const ref = w.length ? w[w.length >> 1] : base;
    let m = n.m + shift;
    if (Math.abs(m - ref) > 9) m = near(m, ref);
    while (m < 64) m += 12;
    while (m > 91) m -= 12;
    m = clamp(m, LOW, HIGH);
    if (ctx.tension(m, n.s / 4) > 1) return; // 推定がずれていそうな音は弾かない
    kept.push({ s: n.s, len: n.len, m });
  });
  if (kept.length < 3) return genCounterLine(ctx, item, out, prevNote);
  const mine = [];
  kept.forEach((n, i) => {
    const x = n.s / 4;
    const t = ctx.beatTime(x), te = ctx.beatTime((n.s + n.len) / 4);
    const pv = kept[i - 1];
    const note = { t, d: (te - t) * 0.98, midi: n.m, vel: clamp(0.4 + 0.3 * inten + 0.08 * (ctx.accentAtStep(n.s) - 0.4), 0.2, 0.85), art: 'sus', legato: !!(pv && pv.s + pv.len === n.s), shape: n.len >= 4 ? 'swell' : 'flat', role: 'double', sec: item.si };
    if (n.len >= 6) note.vib = 1;
    mine.push(note);
  });
  // 楽器が休んでいる所（2 拍以上）は、前後の楽器の音へなめらかにつながる線でうめる（間奏が穴だらけにならないように）
  const motion = ctx.settings.soloMotion ?? 1;
  for (let i = 0; i <= kept.length; i++) {
    const ga = i ? kept[i - 1].s + kept[i - 1].len : s0;
    const gb = i < kept.length ? kept[i].s : s1;
    if (gb - ga < 8) continue;
    const fa = ga + (i ? 2 : 0), fb = gb - (i < kept.length ? 1 : 0);
    const bs = bars.filter((b) => b.b0 * 4 < fb && b.b0 * 4 + 16 > fa);
    if (!bs.length) continue;
    const before = i ? kept[i - 1].m : prevNote ? prevNote.midi : null;
    const after = i < kept.length ? kept[i].m : null;
    const center = before ?? after ?? 76;
    const ln = genLine(ctx, {
      kind: 'solo', bars: bs, densityAt: () => [[2, 6], [4, 9], [6, 12]][motion],
      keep: (n) => n.step >= fa && n.step < fb,
      lo: 64, hi: 88, center: () => center, prev: before, target: after,
      grooveAt: ctx.grooveAt, beam: 20,
    });
    if (ln.length < 2) continue;
    for (const n of ln) if ((n.x + n.len) * 4 > fb) n.len = Math.max(0.25, fb / 4 - n.x);
    mine.push(...lineToNotes(ctx, item, ln, 'fill', () => clamp(0.38 + 0.3 * inten, 0.25, 0.75), { grooveAccent: true }));
  }
  mine.sort((p, q) => p.t - q.t);
  out.push(...mine);
  return mine[mine.length - 1] || prevNote;
}

// ───────────────────────── 掛け合い：歌（または楽器）のフレーズのあと、その息つぎで、同じリズム・同じ形で答える
function echoPhrase(ctx, srcNotes, ga, gb, prevMidi, target) {
  // 直前のフレーズの最後のまとまり（最大 6 音・2 拍まで）をまねる
  const tail = [];
  for (let i = srcNotes.length - 1; i >= 0 && tail.length < 6; i--) {
    const n = srcNotes[i];
    if (tail.length && tail[0].s - (n.s + n.len) > 2) break;
    if (tail.length && srcNotes[srcNotes.length - 1].s + srcNotes[srcNotes.length - 1].len - n.s > 8) break;
    tail.unshift(n);
  }
  if (tail.length < 2) return null;
  // 8 分の位置から入る。歌の最後の音が長い（1 拍以上）ときは、その音が切れる少し手前から（息つぎが始まってからでは遅い）
  const lastV = srcNotes[srcNotes.length - 1];
  const early = lastV && lastV.len >= 4 && lastV.s + lastV.len === ga;
  const start = early ? (ga % 2 === 0 ? ga : ga - 1) : Math.max(ga + 1, ga + 2 - (ga % 2));
  const offs = tail.map((n) => n.s - tail[0].s);
  const span = offs[offs.length - 1] + Math.min(4, tail[tail.length - 1].len);
  if (start + span > gb - 1) return null;
  const out = [];
  // 1 音目：元のフレーズの 1 音目に近い、この時のコードの音（バイオリンの高さで）
  let ref = tail[0].m;
  while (ref < 70) ref += 12;
  while (ref > 86) ref -= 12;
  let m = nearestIn(ref, ctx.chordPcs((start) / 4), 64, 88);
  tail.forEach((n, i) => {
    const st = start + offs[i];
    if (i) {
      const iv = n.m - tail[i - 1].m;
      let want = m + iv;
      const sc = ctx.scalePcs(st / 4);
      // 音階に合わせる（動く向きは保つ）
      let k = 0;
      while (!sc.includes(pcOf(want)) && k++ < 3) want += iv >= 0 ? 1 : -1;
      m = clamp(want, 62, 90);
    }
    const len = i + 1 < tail.length ? offs[i + 1] - offs[i] : Math.min(4, n.len);
    out.push({ s: st, len, m });
  });
  // 最後の音：コードの音で、次の歌い出し（目標）があれば、そこへつながる高さに
  const lastN = out[out.length - 1];
  const pcs = ctx.chordPcs(lastN.s / 4);
  lastN.m = nearestIn(target != null ? Math.round((lastN.m + target) / 2) : lastN.m, pcs, 62, 90);
  // 濁る音は入れない
  if (out.some((n) => ctx.tension(n.m, n.s / 4) > 1)) return null;
  return out;
}
function genAnswer(ctx, item, out, prevNote) {
  const { rand } = ctx;
  const bars = barsOf(ctx, item);
  if (!bars.length) return prevNote;
  const get = sourceLine(ctx, item.sec);
  const s0 = bars[0].b0 * 4, s1 = (bars[bars.length - 1].b0 + 4) * 4;
  const src = lineNotesFrom(ctx, get, s0, s1);
  if (src.length < 4) return item.sec.vocal ? genCounterLine(ctx, item, out, prevNote) : genSoloLine(ctx, item, out, prevNote, false);
  // 息つぎ（1.5 拍以上のすき間）を探す
  const inten = item.intensity;
  let last = prevNote, made = 0;
  for (let i = 0; i < src.length; i++) {
    const n = src[i], nx = src[i + 1];
    const ga = n.s + n.len, gb = nx ? nx.s : s1;
    if (gb - ga < 6) continue;
    if (rand() > 0.85) continue;
    const before = src.slice(0, i + 1);
    const target = nx ? nx.m : null;
    const echo = echoPhrase(ctx, before, ga, gb, last ? last.midi : null, target);
    if (!echo) continue;
    echo.forEach((e, k) => {
      const t = ctx.beatTime(e.s / 4), te = ctx.beatTime((e.s + e.len) / 4);
      const note = { t, d: (te - t) * 0.97, midi: e.m, vel: clamp(0.48 + 0.3 * inten + 0.1 * (ctx.accentAtStep(e.s) - 0.4), 0.25, 0.9), art: k === 0 ? 'mrc' : 'sus', legato: k > 0, shape: e.len >= 4 ? 'swell' : 'flat', role: 'answer', sec: item.si };
      if (k === echo.length - 1 && e.len >= 3) note.vib = 1;
      out.push(note);
      last = note;
    });
    made++;
  }
  // 答える所がなければ、歌の区間は対旋律、歌のない区間はソロ
  if (!made) return item.sec.vocal ? genCounterLine(ctx, item, out, prevNote) : genSoloLine(ctx, item, out, prevNote, false);
  return last;
}

// ───────────────────────── リフをまねる
function genRiff(ctx, item, out, prevNote) {
  const { an, rand } = ctx;
  const sec = item.sec, riff = item.riff;
  const bars = sectionBars(an, sec).filter((b) => !b.pickup && b.n === an.meter);
  if (!bars.length || !riff) return prevNote;
  const meds = riff.notes.map((n) => n.midi).sort((a, b) => a - b);
  const med = meds[meds.length >> 1];
  let shift = 0;
  while (med + shift < 72) shift += 12;
  while (med + shift > 84) shift -= 12;
  const reps = Math.floor(bars.length / riff.periodBars);
  const skipFirst = sec.type === 'intro' && reps >= 3;
  const spb = riff.stepsPerBeat;
  let last = prevNote;
  for (let r = 0; r < reps; r++) {
    if (r === 0 && skipFirst) continue;
    const b0 = bars[r * riff.periodBars];
    riff.notes.forEach((nt, i) => {
      const barOff = Math.floor(nt.s / (an.meter * spb));
      const bar = bars[r * riff.periodBars + barOff];
      if (!bar) return;
      const within = nt.s - barOff * an.meter * spb;
      const x = bar.b0 + within / spb;
      // 原曲でその音が鳴っていなければ（聞き取り違いの恐れ）まねない
      if (ctx.heard(pcOf(nt.midi), x) < 0.45) return;
      const m = clamp(nt.midi + shift, LOW, HIGH);
      const t = ctx.beatTime(x), te = ctx.beatTime(x + nt.len / spb);
      const short = nt.len <= 2;
      out.push({ t, d: te - t, midi: m, vel: clamp(0.55 + 0.35 * item.intensity, 0.3, 1), art: short && within % spb === 0 ? 'mrc' : 'sus', legato: !short, shape: 'flat', role: 'riff', sec: item.si });
      last = out[out.length - 1];
    });
    void b0;
  }
  void rand;
  return last;
}

// ───────────────────────── 曲の最後の音
function addEnding(ctx, out) {
  const { an } = ctx;
  const lastBeat = an.beats.length - 1;
  // 最後に音がある拍（エネルギーがある所）を探す
  let endX = lastBeat;
  const medE = [...an.beatEnergy].sort((a, b) => a - b)[an.beatEnergy.length >> 1] || 1;
  while (endX > 0 && an.beatEnergy[endX] < medE * 0.15) endX--;
  // 最後の和音の始まり
  let x = endX;
  const key = (i) => (an.chords[i] ? an.chords[i].pcs.join(',') : 'N');
  while (x > 0 && key(x - 1) === key(endX) && endX - x < 8) x--;
  const t = ctx.beatTime(x);
  const tEnd = Math.min(an.duration, ctx.beatTime(endX + 1) + 1.5);
  // すでに鳴っている音を切って、主音（和音の音）を長く
  for (const n of out) if (n.t + n.d > t) n.d = Math.max(0.1, t - n.t);
  for (let i = out.length - 1; i >= 0; i--) if (out[i].d <= 0.1 && out[i].t >= t - 0.01) out.splice(i, 1);
  const k = ctx.keyAt(x);
  const pcs = ctx.chordPcs(x);
  const prev = out[out.length - 1];
  let m = pcs.includes(k.tonic) ? nearestIn(prev ? prev.midi : 76, [k.tonic], 67, 86) : nearestIn(prev ? prev.midi : 76, pcs, 67, 86);
  if (tEnd - t > 0.8) out.push({ t, d: tEnd - t, midi: m, vel: 0.5, art: 'sneak', legato: false, shape: 'fade', role: 'ending', vib: 1, sec: an.sections.length - 1 });
}

// ───────────────────────── 区間をまたぐ組み立て（YouTube の弦アレンジ講座から）
// イントロ：調の 5 度（合わなければ主音）をトレモロでのばして「何かが始まる」予感を作り、旋律は途中から入る。
// 和音に合わなくなった所だけ、近い和音の音へ動く
function genIntroPedal(ctx, item, out, bars) {
  const an = ctx.an;
  const x0 = bars[0].b0, x1 = bars[bars.length - 1].b0 + bars[bars.length - 1].n;
  const key = ctx.keyAt(x0);
  let m = null;
  for (const pc of [(key.tonic + 7) % 12, key.tonic]) {
    const cand = nearestIn(74, [pc], 64, 81);
    let bad = 0;
    for (let x = x0; x < x1; x++) if (ctx.tension(cand, x) > 1) bad++;
    if (bad <= (x1 - x0) * 0.25) { m = cand; break; }
  }
  if (m == null) return null;
  const made = [];
  for (let x = x0; x < x1;) {
    let mm = m;
    if (ctx.tension(mm, x) > 1) mm = nearestIn(m, ctx.chordPcs(x), 60, 84);
    let len = 0;
    while (len < 8 && x + len < x1 && ctx.tension(mm, x + len) <= 1) len++;
    if (!len) len = 1;
    const t = ctx.beatTime(x), te = ctx.beatTime(x + len);
    const p = (x - x0) / Math.max(1, x1 - x0);
    made.push({ t, d: te - t, midi: mm, vel: clamp(0.22 + 0.25 * p + 0.2 * item.intensity, 0.15, 0.65), art: an.bpm >= 60 ? 'trem' : 'sus', legato: false, shape: 'cresc', role: 'pad', sec: item.si });
    x += len;
  }
  out.push(...made);
  return made[made.length - 1] || null;
}

// Bメロの後半（サビの直前）：8 分のスタッカートで同じ音をくり返し、和音が変わるたびに上の和音の音へ上がって、だんだん強く。
// ゆっくりの曲は、1 小節ずつ上がるトレモロ。最後の 1 拍はサビへの駆け上がりのためにあける
function addPreBuild(ctx, plan, notes) {
  const an = ctx.an;
  plan.forEach((item) => {
    if (item.sec.type !== 'pre' || item.nextType !== 'chorus' || !item.auto || !['pad', 'arp', 'rhythm'].includes(item.role)) return;
    const bars = sectionBars(an, item.sec).filter((b) => !b.pickup && b.n === an.meter);
    if (bars.length < 2) return;
    const wb = bars.slice(bars.length >= 6 ? -2 : -1);
    const x0 = wb[0].b0, x1 = wb[wb.length - 1].b0 + wb[wb.length - 1].n - 1;
    if (x1 - x0 < 2) return;
    const t0 = ctx.beatTime(x0);
    for (let j = notes.length - 1; j >= 0; j--) {
      const n = notes[j];
      if (n.sec !== item.si) continue;
      if (n.t >= t0 - 0.01) notes.splice(j, 1);
      else if (n.t + n.d > t0) n.d = Math.max(0.1, t0 - n.t);
    }
    const before = notes.filter((n) => n.t < t0).pop();
    const reg = registerFor(ctx, item, 'pad');
    let m = nearestIn(before ? before.midi : reg.center, ctx.chordPcs(x0), 60, 84);
    const up = (x) => { // 次の和音で、今の音より上のいちばん近い和音の音（歌と同じ音名は避ける）
      const pcs = ctx.chordPcs(x);
      for (let q = m + 1; q <= 88; q++) {
        if (!pcs.includes(pcOf(q))) continue;
        const v = ctx.vocalPitch(Math.round(x * 4));
        if (v != null && pcOf(q - v) === 0 && q + 1 <= 88) continue;
        return q;
      }
      return m;
    };
    const span = x1 - x0;
    if (an.bpm < 85) {
      wb.forEach((b, k) => {
        const xa = b.b0, xb = Math.min(b.b0 + b.n, x1);
        if (xb <= xa) return;
        if (k) m = up(xa);
        else if (!ctx.chordPcs(xa).includes(pcOf(m))) m = nearestIn(m, ctx.chordPcs(xa), 60, 86);
        const t = ctx.beatTime(xa), te = ctx.beatTime(xb);
        notes.push({ t, d: te - t, midi: m, vel: clamp(0.35 + 0.25 * ((xa - x0) / span) + 0.2 * item.intensity, 0.2, 0.85), art: 'trem', legato: false, shape: 'cresc', role: 'pad', sec: item.si });
      });
      return;
    }
    let lastKey = null;
    for (let x = x0; x < x1 - 1e-6; x += 0.5) {
      const key = ctx.chordPcs(x).join(',');
      if (lastKey != null && key !== lastKey) m = up(x);
      else if (!ctx.chordPcs(x).includes(pcOf(m))) m = nearestIn(m, ctx.chordPcs(x), 60, 88);
      lastKey = key;
      const t = ctx.beatTime(x), te = ctx.beatTime(x + 0.5);
      const p = (x - x0) / span;
      notes.push({ t, d: (te - t) * 0.55, midi: m, vel: clamp(0.32 + 0.38 * p + 0.15 * item.intensity + (x % 1 === 0 ? 0.04 : 0), 0.2, 0.9), art: 'sus', legato: false, shape: 'flat', role: 'rhythm', sec: item.si });
    }
  });
}

// サビが終わって次の区間へ：急に切らず、中ほどの音を 2 拍のばして消えていく。次の区間は 1 拍目を休んで後から入る
function addTails(ctx, plan, notes) {
  const an = ctx.an;
  plan.forEach((item, i) => {
    if (item.sec.type !== 'chorus' || i + 1 >= plan.length) return;
    const nx = plan[i + 1];
    if (nx.sec.type === 'chorus' || nx.role === 'rest') return;
    const xB = an.bars[nx.sec.bar0].b0, tB = ctx.beatTime(xB);
    const mine = notes.filter((n) => n.sec === i && n.t < tB).sort((a, b) => a.t - b.t);
    const lastN = mine[mine.length - 1];
    if (!lastN || lastN.t + lastN.d < tB - ctx.beatLen(xB - 1) * 1.05) return;
    const tailBeats = 2;
    const tEnd = ctx.beatTime(xB + tailBeats);
    for (let j = notes.length - 1; j >= 0; j--) {
      const n = notes[j];
      if (n.sec !== i + 1 || n.t < tB - 0.01 || n.t >= tEnd - 0.01) continue;
      if (n.t + n.d > tEnd + 0.3) { n.d -= tEnd - n.t; n.t = tEnd; } else notes.splice(j, 1);
    }
    let fits = true;
    for (let k = 0; k < tailBeats; k += 0.5) if (ctx.tension(lastN.midi, xB + k) > 1) fits = false;
    if (fits) { lastN.d = tEnd - lastN.t; lastN.shape = 'fade'; return; }
    lastN.d = Math.max(0.1, tB - lastN.t);
    notes.push({ t: tB, d: tEnd - tB, midi: nearestIn(lastN.midi, ctx.chordPcs(xB), 60, 79), vel: clamp(lastN.vel * 0.8, 0.15, 0.8), art: 'sus', legato: true, shape: 'fade', role: 'pad', sec: i + 1 });
  });
}

// サビの頭への駆け上がり：着地はサビの 1 拍目。最後の 1 拍（ゆっくりの曲は 2 拍）に、着地の音の下から音階で 5〜7 音（偶数の
// 16 分はそろいすぎて機械的なので、5・6・7 連符）。最後のサビの前は半音階。頭の 1 音にアクセント、だんだん強く。歌が休んでいる所だけ
function addRunUps(ctx, plan, notes) {
  const an = ctx.an;
  plan.forEach((item, i) => {
    if (item.sec.type !== 'chorus' || i === 0 || plan[i - 1].sec.type === 'chorus' || item.role === 'rest') return;
    const xLand = an.bars[item.sec.bar0].b0;
    const beats = an.bpm < 90 ? 2 : 1;
    if (xLand - beats < 1) return;
    const busyIn = (a, b) => { let c = 0; for (let st = Math.round(a * 4); st < Math.round(b * 4); st++) if (ctx.vocalPitch(st) != null) c++; return c; };
    // 歌っている所には入れない。歌がサビの頭の少し前から歌い出す（アウフタクト）なら、1 拍早く駆け上がって、歌い出しの間はのばして待つ
    let xEnd = xLand;
    if (busyIn(xLand - beats, xLand) > beats) {
      if (xLand - beats - 1 < 1 || busyIn(xLand - beats - 1, xLand - 1) > beats) return;
      xEnd = xLand - 1;
    }
    const tLand = ctx.beatTime(xLand), tStart = ctx.beatTime(xEnd - beats), tEndRun = ctx.beatTime(xEnd);
    let land = notes.find((n) => n.sec === i && Math.abs(n.t - tLand) < 0.08);
    if (!land) {
      const m = landingPitch(ctx, xLand, registerFor(ctx, item, 'counter').center, 2);
      if (m == null) return;
      const nextN = notes.filter((n) => n.sec === i && n.t > tLand + 0.05).sort((a, b) => a.t - b.t)[0];
      const tEnd = Math.min(nextN ? nextN.t : Infinity, ctx.beatTime(xLand + 2));
      land = { t: tLand, d: tEnd - tLand, midi: m, vel: clamp(0.4 + 0.4 * item.intensity, 0.3, 0.9), art: 'sus', legato: true, shape: 'swell', role: 'counter', sec: i, vib: 1 };
      notes.push(land);
    }
    land.legato = true;
    land.vib = 1;
    // 歌い出しを待つ音（いまの和音の音で、着地の音のすぐ下か同じ高さ）
    let hold = null;
    if (xEnd < xLand) {
      let h = null;
      for (let q = land.midi; q >= land.midi - 5 && h == null; q--) {
        if (!ctx.chordPcs(xEnd).includes(pcOf(q))) continue;
        let okq = true;
        for (let k = 0; k < xLand - xEnd; k += 0.5) if (ctx.tension(q, xEnd + k) > 1) okq = false;
        const v = ctx.vocalPitch(Math.round(xEnd * 4) + 2);
        if (v != null && Math.abs(q - v) % 12 <= 2) okq = false;
        if (okq) h = q;
      }
      if (h == null) return;
      hold = h;
    }
    const top = hold ?? land.midi;
    const count = beats === 2 ? 9 : an.bpm >= 150 ? 5 : an.bpm >= 115 ? 6 : 7;
    const seq = [];
    if ((item.level ?? 3) >= 4) {
      for (let k = count; k >= 1; k--) seq.push(top - k); // 半音階
    } else {
      const sc = ctx.scalePcs(xEnd - 0.5);
      for (let q = top - 1; q > top - 24 && seq.length < count; q--) if (sc.includes(pcOf(q))) seq.unshift(q);
    }
    while (seq.length && seq[0] < LOW) seq.shift();
    if (seq.length < 4) return;
    for (let j = notes.length - 1; j >= 0; j--) {
      const n = notes[j];
      if (n === land) continue;
      if (n.t >= tStart - 0.01 && n.t < tLand - 0.01) notes.splice(j, 1);
      else if (n.t < tStart && n.t + n.d > tStart) n.d = Math.max(0.08, tStart - n.t);
    }
    const step = (tEndRun - tStart) / seq.length;
    seq.forEach((m, k) => notes.push({ t: tStart + k * step, d: step * 0.96, midi: m, vel: clamp(0.45 + 0.3 * (k / Math.max(1, seq.length - 1)) + 0.15 * item.intensity + (k === 0 ? 0.08 : 0), 0.3, 0.95), art: k === 0 ? 'mrc' : 'sus', legato: k > 0, shape: 'flat', role: 'run', sec: i - 1 }));
    if (hold != null) notes.push({ t: tEndRun, d: tLand - tEndRun, midi: hold, vel: clamp(0.5 + 0.2 * item.intensity, 0.3, 0.9), art: 'sus', legato: true, shape: 'flat', role: 'counter', sec: i - 1 });
  });
}

// 重音（2 本の弦を同時に）：最後のサビの山場の長い音と、曲の最後の音に、3度か6度下を添える（バイオリン 1 本で厚みを出す。
// 5度の重音は独奏では弱く音程も不安定なので使わない）。原曲・歌と濁る音は添えない
function addDoubleStops(ctx, plan, notes) {
  const cand = [];
  const lastCh = plan.filter((p) => p.sec.type === 'chorus').pop();
  if (lastCh && (lastCh.level ?? 0) >= 4) {
    const longs = notes.filter((n) => n.sec === lastCh.si && n.role === 'counter' && n.d >= ctx.beatLen(ctx.beatOf(n.t)) * 1.8);
    longs.sort((a, b) => b.midi - a.midi);
    cand.push(...longs.slice(0, 2));
  }
  const end = notes.find((n) => n.role === 'ending');
  if (end) cand.push(end);
  for (const n of cand) {
    const x = ctx.beatOf(n.t), xe = ctx.beatOf(n.t + n.d);
    const sc = ctx.scalePcs(x);
    for (const steps of [5, 2]) { // 6度下 → 3度下
      let q = n.midi;
      for (let k = 0; k < steps; k++) q = stepScale(q, -1, sc);
      const iv = n.midi - q;
      if (q < LOW || ![3, 4, 8, 9].includes(iv)) continue;
      let ok = true;
      for (let k = x; k < xe - 0.01; k += 0.5) if (ctx.tension(q, k) > 1) ok = false;
      for (let st = Math.round(x * 4); st < Math.round(xe * 4) && ok; st++) { const v = ctx.vocalPitch(st); if (v != null && [0, 1, 2, 10, 11].includes(Math.abs(q - v) % 12)) ok = false; }
      if (ok) { n.dbl = q; break; }
    }
  }
}

// ───────────────────────── 仕上げ
function finalize(ctx, notes) {
  const { rand } = ctx;
  for (const n of notes) {
    n.midi = clamp(Math.round(n.midi), LOW, HIGH);
    n.vel = clamp(n.vel + (rand() - 0.5) * 0.06, 0.08, 1);
    // ほんの少しの人間らしさ（つながっていない長い音の入りだけ）
    if (!n.legato && n.d > 0.4) { const j = (rand() - 0.5) * 0.012; n.t += j; n.d -= j; }
    n.t = Math.max(0, n.t);
  }
  notes.sort((a, b) => a.t - b.t);
  // 1本の旋律：重なりを整える
  for (let i = 0; i + 1 < notes.length; i++) {
    const a = notes[i], b = notes[i + 1];
    if (a.t + a.d > b.t) a.d = Math.max(0.04, b.t - a.t);
    // 区間の境目で大きく跳ぶときは、つなげずに息つぎ（休み）を入れる
    if (a.sec !== b.sec && Math.abs(a.midi - b.midi) > 9 && b.t - (a.t + a.d) < 0.15 && a.d > 0.5) { a.d = Math.max(0.3, Math.min(a.d - 0.15, b.t - a.t - 0.2)); b.legato = false; }
    // 前の音とすき間なく続き、高さが違えば、なめらかにつなぐ
    if (b.t - (a.t + a.d) > 0.08) b.legato = false;
  }
  for (const n of notes) {
    n.t = Math.round(n.t * 10000) / 10000;
    n.d = Math.floor(n.d * 10000) / 10000;
  }
  return notes.filter((n) => n.d > 0.04);
}

export function compose(an, settings = {}) {
  const ctx = makeCtx(an, settings);
  const plan = planRoles(an, settings);
  const notes = [];
  let prev = null;
  plan.forEach((item, idx) => {
    const nextVocal = idx + 1 < plan.length && plan[idx + 1].sec.vocal;
    const start = notes.length;
    switch (item.role) {
      case 'pad':
        prev = genPad(ctx, item, notes, prev);
        // 合いの手：歌のメロディが取れていれば「次の歌い出しへつながる」学んだ線、取れなければ前の作り方
        if (item.sec.vocal && !(hasLineModel() && an.meter === 4 && addLineFills(ctx, item, notes))) addFills(ctx, item, notes);
        break;
      case 'counter':
        prev = hasLineModel() && an.meter === 4 ? genCounterLine(ctx, item, notes, prev) : genCounter(ctx, item, notes, prev);
        break;
      case 'solo': {
        // イントロ（4 小節以上）：前半は保続音（トレモロ）、旋律は後半から
        const sb = barsOf(ctx, item);
        if (item.sec.type === 'intro' && item.auto && sb.length >= 4 && hasLineModel() && an.meter === 4) {
          const half = Math.floor(sb.length / 2);
          const p0 = genIntroPedal(ctx, item, notes, sb.slice(0, half));
          if (p0) { prev = genSoloLine(ctx, item, notes, p0, nextVocal, sb.slice(half)); break; }
        }
        prev = hasLineModel() && an.meter === 4
          ? genSoloLine(ctx, item, notes, prev, nextVocal)
          : genSoloV3(ctx, item, notes, prev, nextVocal, sectionBars(an, item.sec).filter((b) => !b.pickup));
        break;
      }
      case 'arp':
        prev = genArp(ctx, item, notes, prev);
        break;
      case 'double':
        prev = genDouble(ctx, item, notes, prev);
        break;
      case 'answer':
        prev = genAnswer(ctx, item, notes, prev);
        // 歌の区間で掛け合いのときは、下でそっと長い音も
        break;
      case 'rhythm':
        prev = genRhythm(ctx, item, notes, prev);
        break;
      case 'riff':
        prev = genRiff(ctx, item, notes, prev);
        break;
      default:
        prev = null;
    }
    item.noteCount = notes.length - start;
  });
  // 区間をまたぐ組み立て：Bメロ後半の押し上げ → サビ明けの伸ばし → サビへの駆け上がり
  if (settings.arrange !== false) {
    addPreBuild(ctx, plan, notes);
    addTails(ctx, plan, notes);
    addRunUps(ctx, plan, notes);
  }
  if (settings.ending !== false) addEnding(ctx, notes);
  if (settings.arrange !== false) addDoubleStops(ctx, plan, notes);
  const out = finalize(ctx, notes);
  return { notes: out, plan: plan.map((p) => ({ si: p.si, role: p.role, auto: p.auto, intensity: p.intensity, type: p.sec.type, n: p.sec.n, noteCount: p.noteCount, hasRiff: !!p.riff })) };
}
