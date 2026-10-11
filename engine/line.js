// 学んだ統計（linemodel.json）で、自然につながる旋律の線を作る
//  1. リズム：小節ごとのリズムの形を、学んだ「次に来やすい形」でつなぐ（歌の休みに音が入りやすい形を選ぶ）
//  2. 音の高さ：1 音ずつ、たくさんの候補を同時に試しながら（ビームサーチ）、点数が一番よい並びを選ぶ
//     点数＝学んだ確率（動き方・拍の強さとコードの度数・コードが変わる所のつながり・フレーズの終わり・歌との音程）
//          ＋原曲と濁らないこと＋音域＋次の区間・次の歌の音へのつながり
let LM = null;
export function setLineModel(json) {
  if (!json || !json.rhythm) { LM = null; return; }
  const bank = (b) => {
    const pats = b.patterns.map(([p, c]) => ({ p, c, n: (p.match(/x/g) || []).length, endsLong: /x-{3,}$|x-*\.{2,}$/.test(p) || p.endsWith('....'), lead: /x[-.]?$/.test(p.slice(12)) }));
    return { pats, next: b.next, byP: new Map(pats.map((x) => [x.p, x])) };
  };
  LM = { ...json, inst: bank(json.rhythm.inst), solo: bank(json.rhythm.solo) };
}
// コードが変わる所のつながり（前の音が新しいコードの何度か → 次の音の度数）の対数確率
export function connectLp(prevInNew, role) {
  if (!LM) return null;
  return lp(LM.connect, String(prevInNew), String(role));
}
export function hasLineModel() { return !!LM; }
// 学んだ強弱（POP909 の演奏）：フレーズの中の位置・拍・高さ・長さで、平均からどれだけ強くするか（0〜1 の強さの単位）
export function dynamicsFor(line) {
  const out = new Array(line.length).fill(0);
  if (!LM || !LM.dyn) return out;
  const A = LM.dyn;
  let i = 0;
  while (i < line.length) {
    let j = i;
    while (j + 1 < line.length && line[j + 1].x - (line[j].x + line[j].len) < 1) j++;
    const ph = line.slice(i, j + 1);
    const ms = ph.map((n) => n.midi).sort((a, b) => a - b);
    ph.forEach((n, k) => {
      const posB = ph.length > 1 ? Math.min(4, Math.floor((k / (ph.length - 1)) * 5)) : 2;
      const rank = ms.indexOf(n.midi) / Math.max(1, ms.length - 1);
      const d = A.pos[posB] + A.met[metric(n.pos ?? 0)] + A.pit[rank < 0.34 ? 0 : rank < 0.67 ? 1 : 2] + A.dur[n.len <= 0.5 ? 0 : n.len <= 1 ? 1 : 2];
      out[i + k] = d / 40;
    });
    i = j + 1;
  }
  return out;
}
export function lineModelInfo() {
  return LM ? { source: LM.source, songs: LM.stat.songs, notes: LM.stat.notes, patterns: LM.inst.pats.length + LM.solo.pats.length } : null;
}

const pcOf = (m) => ((m % 12) + 12) % 12;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ivB = (iv) => (iv <= -5 ? 0 : iv <= -3 ? 1 : iv === -2 ? 2 : iv === -1 ? 3 : iv === 0 ? 4 : iv === 1 ? 5 : iv === 2 ? 6 : iv <= 4 ? 7 : 8);
const metric = (pos) => (pos === 0 ? 0 : pos === 8 ? 1 : pos % 4 === 0 ? 2 : pos % 2 === 0 ? 3 : 4);
const lp = (tab, key, val) => { const t = tab[key]; if (!t) return -3; return t[val] ?? t._ ?? -6; };

// ───────── 1. リズム
function chooseRhythm(ctx, bars, opt) {
  const { rand } = ctx;
  const banks = opt.kind === 'solo' ? [LM.solo, LM.inst] : [LM.inst];
  const pool = banks.flatMap((b) => b.pats.map((x) => ({ ...x, bank: b })));
  const out = [];
  let prev = null;
  bars.forEach((bar, bi) => {
    const last = bi === bars.length - 1;
    const [dmin, dmax] = opt.densityAt(bi);
    const cand = [];
    const pb = opt.phraseBars || 0;
    const phraseEnd = pb && !last && bi % pb === pb - 1;
    // フレーズの最後の小節：最後の 1 拍に新しい音がなく、最後は休み（＝息つぎ）
    const breathes = (p) => !p.slice(12).includes('x') && p.slice(13) === '...';
    // ソロの組み立て（ギター・バイオリンのアドリブ講座）：短い動機を、高さを変えてくり返す（問い → 答え → 問いのくり返し → 締め）。
    // 4 小節ごとの 3 小節目は多くの場合 1 小節目と同じリズム、終わりの手前では最初の動機に戻る。長いフレーズの丸ごとのくり返しはしない
    const src = opt.motif ? (bi % 4 === 2 ? out[bi - 2] : bars.length >= 6 && bi === bars.length - 2 ? out[0] : null) : null;
    if (src && (!phraseEnd || breathes(src.p)) && !(last && opt.endRest) && rand() < (bi % 4 === 2 ? 0.75 : 0.6)) { out.push(src); prev = src; return; }
    for (let pass = 0; pass < 2 && !cand.length; pass++) for (const q of pool) {
      if (q.n < (pass ? 1 : dmin) || q.n > dmax) continue;
      if (phraseEnd && !breathes(q.p)) continue;
      let w = Math.log(q.c + 1);
      if (prev && prev.bank === q.bank) {
        const nx = q.bank.next[prev.p];
        if (nx) w += nx[q.p] ? Math.log(1 + nx[q.p]) * 1.2 : -1.2;
      }
      // 息つぎのあとの小節：拍の頭ちょうどより、少しあとから入る形を好む（ギターソロ・副旋律でよくある入り方）
      if (pb && bi > 0 && (bi - 1) % pb === pb - 1) {
        const first = q.p.indexOf('x');
        if (first >= 1 && first <= 6) w += 1.2; else if (first === 0) w -= 0.3;
      }
      // ドラム・ベースに合わせる：キック・スネアが強く鳴る 16 分に音の始まりが重なる形を好む
      if (opt.grooveAt) {
        const g = opt.grooveAt(bar.b0);
        if (g) {
          let on = 0, sum = 0;
          for (let k = 0; k < 16; k++) {
            const acc = 0.6 * g.k[k] + 0.7 * g.s[k] + 0.25 * g.h[k];
            if (q.p[k] === 'x') { sum += acc; on++; }
          }
          if (on) w += (opt.grooveWeight ?? 3.2) * (sum / on - g.mean);
        }
      }
      // 同じリズムが 3 小節続かない（2 小節続いたら別の形へ）
      if (out.length >= 2 && out[out.length - 1] && out[out.length - 2] && out[out.length - 1].p === q.p && out[out.length - 2].p === q.p) w -= 3;
      else if (prev && prev.p === q.p) w -= 0.4;
      // 歌との関係：歌が休んでいる所に音が入る形を選ぶ（合いの手・対旋律）
      if (opt.vocalState) {
        let s = 0;
        for (let k = 0; k < 16; k++) {
          const st = opt.vocalState(bar.b0 * 4 + k);
          if (!st) continue;
          s += lp(LM.fill, `${st.state}|${st.ub}`, q.p[k] === 'x' ? '1' : '0');
        }
        w += s * (opt.fillWeight ?? 0.6);
      }
      // 区間の最後の小節：長くのばして終わる／休んで道をあける形
      if (last && opt.endLong && q.endsLong) w += 1.5;
      if (last && opt.endRest && q.p.slice(12) === '....') w += 2;
      cand.push([q, w]);
    }
    if (!cand.length) { out.push(null); prev = null; return; }
    // 点数を確率にして選ぶ（よい形ほど選ばれやすい）
    const mx = Math.max(...cand.map((c) => c[1]));
    let tot = 0;
    for (const c of cand) { c[2] = Math.exp((c[1] - mx) / (opt.temp ?? 0.8)); tot += c[2]; }
    let r = rand() * tot, pick = cand[0][0];
    for (const c of cand) { r -= c[2]; if (r <= 0) { pick = c[0]; break; } }
    out.push(pick);
    prev = pick;
  });
  // 形 → 音符（始まりの拍・長さ）
  const notes = [];
  bars.forEach((bar, bi) => {
    const q = out[bi];
    if (!q) return;
    for (let k = 0; k < 16; k++) {
      if (q.p[k] !== 'x') continue;
      let len = 1;
      while (k + len < 16 && q.p[k + len] === '-') len++;
      // 小節の終わりまでのばしている音は、次の小節の頭が「-」なら続ける
      if (k + len === 16 && out[bi + 1] && out[bi + 1].p[0] === '-') { let j = 0; while (j < 16 && out[bi + 1].p[j] === '-') j++; len += j; }
      notes.push({ step: bar.b0 * 4 + k, len, pos: k });
    }
  });
  return notes;
}

// ───────── 2. 音の高さ（ビームサーチ）
export function genLine(ctx, opt) {
  if (!LM) return [];
  const { an } = ctx;
  const bars = opt.bars.filter((b) => b.n === 4 && !b.pickup);
  if (!bars.length) return [];
  let notes = opt.rhythm || chooseRhythm(ctx, bars, opt);
  if (opt.keep) notes = notes.filter((n) => opt.keep(n));
  if (opt.shapeRhythm) notes = opt.shapeRhythm(notes);
  if (!notes.length) return [];
  const lo = opt.lo, hi = opt.hi;
  const W = opt.beam || 24;
  const chordOf = (x) => an.chords[clamp(Math.floor(x + 1e-6), 0, an.chords.length - 1)];
  const rootAt = (x) => { const c = chordOf(x); return c ? c.root : ctx.chordRoot(x); };
  const keyOf = (n) => `${rootAt(n.step / 4)}:${(chordOf(n.step / 4) || {}).q || ''}`;
  // ソロの動機：同じリズムの小節（4 小節ごとの 3 小節目は 1 小節目、終わりの手前は最初の小節）の音の動きをなぞる
  let srcOf = null, srcHome = null;
  if (opt.motif) {
    const groups = bars.map((b) => notes.map((n, i) => [n, i]).filter(([n]) => n.step >= b.b0 * 4 && n.step < b.b0 * 4 + 16));
    srcOf = new Array(notes.length).fill(-1);
    srcHome = new Array(notes.length).fill(false);
    const link = (bi, sb, home) => {
      const g = groups[bi], sg = groups[sb];
      if (!g || !sg || !g.length || g.length !== sg.length || !g.every(([n], k) => n.pos === sg[k][0].pos)) return;
      g.forEach(([, i], k) => { srcOf[i] = sg[k][1]; srcHome[i] = home; });
    };
    groups.forEach((g, bi) => { if (bi % 4 === 2) link(bi, bi - 2, false); });
    if (bars.length >= 6) link(bars.length - 2, 0, true);
  }
  // 歌との 2 声の決まり（YouTube の弦アレンジ講座で多くが言っていたこと）に使う、各音の始まりの歌の高さ
  const vocAt = opt.vocalPitch ? notes.map((n) => opt.vocalPitch(n.step)) : null;
  let beam = [{ score: 0, seq: [], last: opt.prev ?? null, piv: null, par: 0 }];
  notes.forEach((n, i) => {
    const x = n.step / 4, len = n.len / 4;
    const mc = metric(n.pos);
    const durC = n.len <= 2 ? 0 : n.len <= 4 ? 1 : 2;
    const root = rootAt(x);
    const prevN = notes[i - 1];
    const connected = prevN && n.step - (prevN.step + prevN.len) <= 2;
    const chordChanged = prevN && keyOf(prevN) !== keyOf(n);
    const nextN = notes[i + 1];
    const phraseEnd = !nextN || nextN.step - (n.step + n.len) >= 4;
    const center = opt.center(i / Math.max(1, notes.length - 1));
    // 使ってよい音：原曲と濁らない音（長い音は続く間ずっと）
    const cands = [];
    for (let m = lo; m <= hi; m++) {
      let worst = 0;
      for (let k = 0; k < Math.max(len, 0.25) - 1e-6; k += 0.5) worst = Math.max(worst, ctx.tension(m, x + k));
      if (worst > 1) continue;
      if (len >= 1 && mc <= 1 && worst > 0) { cands.push([m, -1.6]); continue; } // 強拍の長い音はコードの音がよい
      cands.push([m, 0]);
    }
    if (!cands.length) for (const pc of ctx.chordPcs(x)) for (let m = lo; m <= hi; m++) if (pcOf(m) === pc) cands.push([m, 0]);
    const vocal = opt.vocalPitch ? opt.vocalPitch(n.step) : null;
    const next = [];
    for (const b of beam) {
      for (const [m, base] of cands) {
        let s = b.score + base;
        const role = pcOf(m - root);
        s += lp(LM.role, `${mc}|${durC}`, String(role)) * 0.8;
        if (b.last != null && connected) {
          const iv = clamp(m - b.last, -12, 12);
          if (Math.abs(m - b.last) > 12) continue;
          s += lp(LM.iv, `${b.piv == null ? 'S' : ivB(b.piv)}|${mc}`, String(iv));
          if (chordChanged) s += lp(LM.connect, String(pcOf(b.last - root)), String(role)) * 1.2;
        } else {
          // フレーズの始まり：前の音や目安の高さから離れすぎない
          s -= 0.06 * Math.abs(m - (b.last ?? center));
        }
        if (phraseEnd) s += LM.final[role] * 0.9;
        // 合いの手：調のペンタトニック（メジャー 1・2・3・5・6 度＝マイナー 1・♭3・4・5・♭7 度）はコードをほぼ選ばずに合うので少し好む
        if (opt.penta) { const k = ctx.keyAt(x); const pent = k.mode === 'min' ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9]; if (pent.includes(pcOf(m - k.tonic))) s += opt.penta; }
        // 伴奏の線（対旋律）：強拍の長い音は根音を避ける（根音はベースの役目。3度・5度・7度・9度で彩る）
        if (opt.avoidRoot && role === 0 && mc <= 1 && n.len >= 4) s -= opt.avoidRoot;
        s -= 0.025 * Math.abs(m - center);
        // 同じ音の連続は 2 回まで
        const L = b.seq.length;
        if (L >= 2 && b.seq[L - 1] === m && b.seq[L - 2] === m) s -= 1.5;
        // 2 つの音を行ったり来たり（A-B-A-B）しない
        if (L >= 3 && b.seq[L - 2] === m && b.seq[L - 1] === b.seq[L - 3]) s -= 2.5;
        // 狭い所でぐるぐるしない（直前 6 音の幅が 2 半音以内なら減点）
        if (L >= 5) {
          const w6 = b.seq.slice(L - 5).concat(m);
          const span = Math.max(...w6) - Math.min(...w6);
          if (span <= 2) s -= 1.5; else if (span <= 4) s -= 0.4;
        }
        // 歌との関係（音の始まり）
        let par = 0;
        if (vocal != null) {
          if (m === vocal) s -= 2.5; // 同じ高さで重ならない
          else s += (LM.withMel[pcOf(m - vocal)] + 2.2) * (opt.vocalWeight ?? 0.6);
          if (Math.abs(m - vocal) <= 2) s -= 1.2; // 2度でこすれない
          // 歌と同じ音名（オクターブちがい）を長く・強拍で重ねない（歌が埋もれる）
          if (m !== vocal && pcOf(m - vocal) === 0 && (mc <= 1 || n.len >= 4)) s -= 1.2;
          // 強拍で、歌と完全 4 度にならない（2 声では 3 度へ解決したがる響き）
          const dv = Math.abs(m - vocal) % 12;
          if (mc === 0 && dv === 5) s -= 0.8;
          // 前の音からの動き：歌と同じ向きに動いて、完全 1・5・8 度が続かない（平行）／3度・6度の平行は 3 回まで
          const pv = i > 0 && vocAt ? vocAt[i - 1] : null;
          if (pv != null && b.last != null && connected) {
            const dirV = Math.sign(vocal - pv), dirM = Math.sign(m - b.last);
            const ivNow = Math.abs(m - vocal) % 12, ivPrev = Math.abs(b.last - pv) % 12;
            if (dirV !== 0 && dirV === dirM) {
              if ((ivNow === 0 || ivNow === 7) && ivNow === ivPrev) s -= 1.6;
              const thirdSixth = (v) => v === 3 || v === 4 || v === 8 || v === 9;
              if (thirdSixth(ivNow) && thirdSixth(ivPrev)) { par = b.par + 1; if (par >= 3) s -= 1.0; }
            }
          }
        }
        // 長い音は、のばしている間に歌と 2度でこすれる時間が短いほどよい
        if (opt.vocalPitch && n.len >= 3) {
          let rub = 0, cnt = 0;
          for (let k = 1; k < n.len; k++) { const v = opt.vocalPitch(n.step + k); if (v == null) continue; cnt++; const d = Math.abs(m - v) % 12; if (d === 1 || d === 2 || d === 10 || d === 11) rub++; }
          if (cnt) s -= 2.2 * (rub / cnt);
        }
        // ソロの動機をなぞる：同じ動き（音程）なら加点。くり返しの最初の音は、動機の最初の音から 2〜5 半音（終わりの手前は同じ高さ）
        if (srcOf && srcOf[i] >= 0) {
          const j = srcOf[i];
          if (i > 0 && j > 0 && srcOf[i - 1] === j - 1) {
            const ivSrc = b.seq[j] - b.seq[j - 1], ivNow = m - b.seq[i - 1];
            if (ivNow === ivSrc) s += 1.0; else if (Math.sign(ivNow) === Math.sign(ivSrc)) s += 0.4;
          } else {
            const d = Math.abs(m - b.seq[j]);
            if (srcHome[i] ? d === 0 : d >= 2 && d <= 5) s += 0.7;
          }
        }
        // 次へのつながり（区間の最後の音・合いの手の最後の音）
        if (!nextN && opt.target != null) {
          const d = Math.abs(m - opt.target);
          s += d === 0 ? -0.3 : d <= 2 ? 1.2 : d <= 4 ? 0.4 : -0.1 * d;
        }
        // 毎回いちばん確からしい音だけを選ぶと単調になる（ぐるぐる回る）ので、少しゆらぎを入れて選ぶ
        const g = -Math.log(-Math.log(Math.max(1e-9, ctx.rand())));
        next.push({ score: s, key: s + (opt.temp ?? 0.7) * g, seq: b.seq.concat(m), last: m, piv: b.last != null && connected ? m - b.last : null, par });
      }
    }
    next.sort((a, b) => b.key - a.key);
    // 似た並びばかり残らないよう、最後の音が同じものは 3 つまで
    const kept = [], cnt = new Map();
    for (const c of next) {
      const k = c.last;
      if ((cnt.get(k) || 0) >= 3) continue;
      cnt.set(k, (cnt.get(k) || 0) + 1);
      kept.push(c);
      if (kept.length >= W) break;
    }
    // 少しだけゆらぎ（毎回同じにならない）
    beam = kept.length ? kept : beam;
  });
  let best = beam[0];
  for (const b of beam) if (b.score > best.score) best = b;
  return notes.map((n, i) => ({ x: n.step / 4, len: n.len / 4, midi: best.seq[i], onBeat: n.pos % 4 === 0, pos: n.pos, phraseEnd: !notes[i + 1] || notes[i + 1].step - (n.step + n.len) >= 4 }));
}

// 線の自然さ（学んだ確率での平均点）：テストで、前の作り方とくらべる
export function lineScore(ctx, notes) {
  if (!LM || notes.length < 2) return null;
  const { an } = ctx;
  const rootAt = (x) => { const c = an.chords[clamp(Math.floor(x + 1e-6), 0, an.chords.length - 1)]; return c ? c.root : ctx.chordRoot(x); };
  let s = 0, n = 0, conn = 0, connN = 0;
  for (let i = 1; i < notes.length; i++) {
    const a = notes[i - 1], b = notes[i];
    if (b.x - (a.x + a.len) > 0.5) continue;
    const bi = clamp(Math.floor(b.x + 1e-6), 0, an.beatInBar.length - 1);
    const pos = (an.beatInBar[bi] * 4 + Math.round((b.x - Math.floor(b.x + 1e-6)) * 4)) % 16;
    const iv = clamp(b.midi - a.midi, -12, 12);
    s += lp(LM.iv, `S|${metric(pos)}`, String(iv));
    n++;
    const ra = rootAt(a.x), rb = rootAt(b.x);
    if (ra !== rb) { conn += lp(LM.connect, String(pcOf(a.midi - rb)), String(pcOf(b.midi - rb))); connN++; }
  }
  return { iv: n ? s / n : 0, connect: connN ? conn / connN : 0, n, connN };
}
