// 楽譜を SVG で描く（1 段ずつ SVG にするので、印刷のときに段の途中でページが切れない）
const SP = 9; // 線と線の間
const STAFF_TOP = 80; // 段の上から五線の一番上の線まで
const SYS_H = 172;
const MUSIC_FONT = `'Apple Symbols','Noto Music','Segoe UI Symbol','Bravura',serif`;
const SHARP_POS = [8, 5, 9, 6, 3, 7, 4];
const FLAT_POS = [4, 7, 3, 6, 2, 5, 1];
const STEP_IDX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const posOf = (p) => p.octave * 7 + STEP_IDX[p.step] - (4 * 7 + 2); // E4 = 0
const yOf = (pos) => STAFF_TOP + 4 * SP - (pos * SP) / 2;
const r1 = (x) => Math.round(x * 10) / 10;

const GRACE_W = 7.5; // 装飾音 1 つ分の幅
const graceW = (e) => (e.graces ? e.graces.length * GRACE_W + 6 : 0);
function evWidth(e) {
  let w = Math.max(17, 9 + 25 * Math.pow(e.dur / 4, 0.62));
  if (e.accidental) w += 8;
  if (e.dots) w += 5;
  return w + graceW(e);
}
function keySigWidth(f) { return Math.abs(f) * 9 + (f ? 6 : 0); }

// 1小節ずつの「ブロック」：全休符が続く所は1つにまとめる（○小節休み）
function blocks(score) {
  const out = [];
  for (const m of score.measures) {
    const wholeRest = m.events.length === 1 && m.events[0].rest && m.events[0].dur === m.barLen;
    const last = out[out.length - 1];
    if (wholeRest && last && last.multi && !m.section && !m.keyChange && !m.dynamic) {
      last.ms.push(m);
      continue;
    }
    if (wholeRest && !m.pickup) out.push({ multi: true, ms: [m] });
    else out.push({ multi: false, ms: [m] });
  }
  for (const b of out) {
    const m = b.ms[0];
    b.key = m.keyChange && out.indexOf(b) > 0 ? keySigWidth(m.fifths) + 6 : 0;
    b.w = b.multi ? (b.ms.length > 1 ? 74 : 46) : 16 + m.events.reduce((a, e) => a + evWidth(e), 0);
    b.w += b.key;
  }
  return out;
}

export function renderScore(score, opt = {}) {
  const W = opt.width || 940;
  const left0 = 10;
  const bl = blocks(score);
  // 段に分ける
  const systems = [];
  let cur = [], used = 0;
  let curFifths = score.keyFirst;
  const headW = (first, f) => 34 + keySigWidth(f) + (first ? 26 : 6);
  let hw = headW(true, curFifths);
  for (const b of bl) {
    const avail = W - left0 - 10 - hw;
    if (cur.length && used + b.w > avail) {
      systems.push({ blocks: cur, head: hw, fifths: curFifths, used });
      curFifths = b.ms[0].fifths;
      cur = []; used = 0;
      hw = headW(false, curFifths);
      if (b.key) { b.w -= b.key; b.key = 0; }
    }
    cur.push(b);
    used += b.w;
    curFifths = b.ms[b.ms.length - 1].fifths;
  }
  if (cur.length) systems.push({ blocks: cur, head: hw, fifths: cur[0].ms[0].fifths, used, last: true });
  // 段の頭の調号は、その段の最初の小節の調
  systems.forEach((s) => (s.fifths = s.blocks[0].ms[0].fifths));
  let pendingTie = null;
  const svgs = systems.map((sys, si) => {
    const g = [];
    const avail = W - left0 - 10 - sys.head;
    // 最後の段は詰めすぎない
    const scale = sys.last && sys.used < avail * 0.75 ? 1.15 : avail / sys.used;
    // 五線
    const x0 = left0, x1 = sys.last && sys.used < avail * 0.75 ? left0 + sys.head + sys.used * scale : W - 10;
    for (let i = 0; i < 5; i++) g.push(`<line x1="${x0}" y1="${yOf(8 - 2 * i)}" x2="${r1(x1)}" y2="${yOf(8 - 2 * i)}" class="st"/>`);
    g.push(`<line x1="${x0}" y1="${yOf(8)}" x2="${x0}" y2="${yOf(0)}" class="bar"/>`);
    // ト音記号・調号・拍子
    g.push(`<text x="${x0 + 2}" y="${yOf(2) + 13}" class="clef" data-top="${STAFF_TOP - 1.7 * SP}" data-bottom="${STAFF_TOP + 4 * SP + 2.3 * SP}" data-left="${x0 + 3}">𝄞</text>`);
    let x = x0 + 34;
    x = drawKeySig(g, x, sys.fifths);
    if (si === 0) {
      g.push(`<text x="${x + 4}" y="${yOf(6) + 6}" class="ts">${score.meter}</text><text x="${x + 4}" y="${yOf(2) + 6}" class="ts">4</text>`);
    }
    // 小節番号
    const firstM = sys.blocks[0].ms[0];
    if (firstM.number > 1) g.push(`<text x="${x0 + 2}" y="${STAFF_TOP - 8}" class="mnum">${firstM.number}</text>`);
    x = x0 + sys.head;
    // 段をまたぐタイの続き
    sys.blocks.forEach((b, bi) => {
      const bw = b.w * scale;
      const bx = x;
      const m = b.ms[0];
      let ix = bx;
      if (b.key) { g.push(`<line x1="${r1(ix + 2)}" y1="${yOf(8)}" x2="${r1(ix + 2)}" y2="${yOf(0)}" class="bar"/>`); ix = drawKeySig(g, ix + 6, m.fifths); }
      // 区間名・強弱
      if (m.section) {
        const label = m.section.name + (m.section.role ? `  ${m.section.role}` : '');
        const tw = label.length * 11.5 + 12;
        const lx = Math.max(left0, Math.min(bx + 2, W - 10 - tw)); // 右端からはみ出さない
        g.push(`<rect x="${r1(lx)}" y="6" width="${r1(tw)}" height="19" rx="4" class="secbox"/><text x="${r1(lx + 6)}" y="20" class="sec">${esc(m.section.name)}<tspan class="role">${m.section.role ? '　' + esc(m.section.role) : ''}</tspan></text>`);
      }
      if (m.dynamic) g.push(`<text x="${r1(bx + 6)}" y="${yOf(-4) + 20}" class="dyn">${m.dynamic}</text>`);
      if (b.multi) {
        const n = b.ms.length;
        const cx = bx + bw / 2;
        if (n > 1) {
          g.push(`<rect x="${r1(bx + 12)}" y="${yOf(4) - 4}" width="${r1(bw - 24)}" height="8" class="mrest"/><line x1="${r1(bx + 12)}" y1="${yOf(6)}" x2="${r1(bx + 12)}" y2="${yOf(2)}" class="bar"/><line x1="${r1(bx + bw - 12)}" y1="${yOf(6)}" x2="${r1(bx + bw - 12)}" y2="${yOf(2)}" class="bar"/>`);
          g.push(`<text x="${r1(cx)}" y="${STAFF_TOP - 6}" class="mcount">${n}</text>`);
        } else {
          g.push(`<rect x="${r1(cx - 6)}" y="${yOf(6)}" width="12" height="5" class="ink"/>`);
        }
        pendingTie = null;
      } else {
        const evs = m.events;
        const xs = [];
        let ex = ix + 10;
        for (const e of evs) {
          const w = evWidth(e) * scale;
          xs.push(ex + graceW(e) + (e.accidental ? 8 : 0));
          ex += w;
        }
        // コードネーム：小節の一番高い音より上に
        let topY = STAFF_TOP - 14;
        for (const e of evs) if (!e.rest) topY = Math.min(topY, yOf(posOf(e.pitch)) - (e.trill ? 26 : 13));
        topY = Math.max(36, topY);
        for (const c of m.chords) {
          let cxp = ix + 10;
          for (let k = 0; k < evs.length; k++) if (evs[k].pos <= c.pos) cxp = xs[k] + ((c.pos - evs[k].pos) / Math.max(1, evs[k].dur)) * (evWidth(evs[k]) * scale * 0.8);
          g.push(`<text x="${r1(cxp - 4)}" y="${r1(topY)}" class="chord">${esc(c.name)}</text>`);
        }
        drawEvents(g, evs, xs, m, (tie) => {
          // タイ：前の音から
          if (tie.stop && pendingTie) {
            const ax = pendingTie.sys === si ? pendingTie.x : x0 + sys.head - 6;
            drawTie(g, ax, tie.x, tie.y, tie.up);
            if (pendingTie.sys !== si) { /* 前の段の終わりにも半分 */ pendingTie.g.push(tiePath(pendingTie.x, pendingTie.x1, pendingTie.y, pendingTie.up)); }
          }
          pendingTie = tie.start ? { x: tie.x, y: tie.y, up: tie.up, sys: si, g, x1: x1 - 2 } : null;
        });
      }
      x += bw;
      const last = si === systems.length - 1 && bi === sys.blocks.length - 1;
      if (last) g.push(`<line x1="${r1(x - 5)}" y1="${yOf(8)}" x2="${r1(x - 5)}" y2="${yOf(0)}" class="bar"/><rect x="${r1(x - 3)}" y="${yOf(8)}" width="3.5" height="${4 * SP}" class="ink"/>`);
      else g.push(`<line x1="${r1(x)}" y1="${yOf(8)}" x2="${r1(x)}" y2="${yOf(0)}" class="bar"/>`);
    });
    return { g, si };
  });
  const head = `<div class="score-head"><h2>${esc(score.title)}</h2><p>バイオリン　♩ = ${score.bpm}${score.steady ? '' : '（約）'}　${esc(opt.keyText || '')}　<span class="by">AIバイオリニスト</span></p></div>`;
  const body = svgs.map(({ g }) => `<svg class="system" viewBox="0 0 ${W} ${SYS_H}" width="100%" preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg">${g.join('')}</svg>`).join('');
  return head + body;
}

function drawKeySig(g, x, f) {
  if (!f) return x;
  const list = f > 0 ? SHARP_POS.slice(0, f) : FLAT_POS.slice(0, -f);
  const ch = f > 0 ? '♯' : '♭';
  for (const p of list) {
    g.push(`<text x="${r1(x)}" y="${r1(yOf(p) + (f > 0 ? 5 : 4))}" class="acc">${ch}</text>`);
    x += 9;
  }
  return x + 6;
}

function tiePath(xa, xb, y, below) {
  const dy = below ? 7 : -7;
  const yy = y + (below ? 5 : -5);
  return `<path d="M${r1(xa + 5)} ${r1(yy)} Q${r1((xa + xb) / 2)} ${r1(yy + dy)} ${r1(xb - 5)} ${r1(yy)}" class="tie"/>`;
}
function drawTie(g, xa, xb, y, up) { g.push(tiePath(xa, xb, y, up)); }

function drawEvents(g, evs, xs, m, onTie) {
  // 連桁のまとまり
  const groups = [];
  let cur = null;
  evs.forEach((e, i) => {
    if (e.beam === 'begin') cur = [i];
    else if (e.beam === 'continue' && cur) cur.push(i);
    else if (e.beam === 'end' && cur) { cur.push(i); groups.push(cur); cur = null; }
  });
  const stemDir = new Array(evs.length).fill(null);
  const beamY = new Array(evs.length).fill(null);
  for (const grp of groups) {
    const ps = grp.map((i) => posOf(evs[i].pitch));
    const avg = ps.reduce((a, b) => a + b, 0) / ps.length;
    const up = avg < 4;
    const ys = grp.map((i) => yOf(posOf(evs[i].pitch)));
    const xA = xs[grp[0]], xB = xs[grp[grp.length - 1]];
    let slope = (ys[ys.length - 1] - ys[0]) / Math.max(1, xB - xA);
    slope = Math.max(-0.12, Math.min(0.12, slope));
    // 一番飛び出る音に合わせて高さを決める
    const L = 3.3 * SP;
    let off = up ? Infinity : -Infinity;
    grp.forEach((i, k) => {
      const sx = xs[i] + (up ? 5 : -5);
      const base = ys[k] + (up ? -L : L) - slope * (sx - xA);
      off = up ? Math.min(off, base) : Math.max(off, base);
    });
    grp.forEach((i) => {
      stemDir[i] = up;
      const sx = xs[i] + (up ? 5 : -5);
      beamY[i] = off + slope * (sx - xA);
    });
    // 主連桁
    const sxA = xA + (up ? 5 : -5), sxB = xB + (up ? 5 : -5);
    const yA = beamY[grp[0]], yB = beamY[grp[grp.length - 1]];
    const th = up ? 4.5 : -4.5;
    g.push(`<polygon points="${r1(sxA)},${r1(yA)} ${r1(sxB)},${r1(yB)} ${r1(sxB)},${r1(yB + th)} ${r1(sxA)},${r1(yA + th)}" class="ink"/>`);
    // 16分の第2連桁
    const d2 = up ? 7 : -7;
    for (let k = 0; k < grp.length; k++) {
      const i = grp[k];
      if (evs[i].type !== '16th') continue;
      const sx = xs[i] + (up ? 5 : -5);
      const nextI = grp[k + 1];
      if (nextI != null && evs[nextI].type === '16th') {
        const sx2 = xs[nextI] + (up ? 5 : -5);
        g.push(`<polygon points="${r1(sx)},${r1(beamY[i] + d2)} ${r1(sx2)},${r1(beamY[nextI] + d2)} ${r1(sx2)},${r1(beamY[nextI] + d2 + th)} ${r1(sx)},${r1(beamY[i] + d2 + th)}" class="ink"/>`);
      } else if (!(k > 0 && evs[grp[k - 1]].type === '16th')) {
        const dir = k === grp.length - 1 ? -1 : 1;
        const sx2 = sx + dir * 8;
        const yb = beamY[i] + slope * (sx2 - sx);
        g.push(`<polygon points="${r1(sx)},${r1(beamY[i] + d2)} ${r1(sx2)},${r1(yb + d2)} ${r1(sx2)},${r1(yb + d2 + th)} ${r1(sx)},${r1(beamY[i] + d2 + th)}" class="ink"/>`);
      }
    }
  }
  evs.forEach((e, i) => {
    const x = xs[i];
    if (e.rest) { drawRest(g, x, e, m); return; }
    const pos = posOf(e.pitch);
    const y = yOf(pos);
    if (e.graces) drawGraces(g, e, x - graceW(e) - (e.accidental ? 8 : 0) + 2);
    // 加線
    for (let p = -2; p >= pos; p -= 2) g.push(`<line x1="${r1(x - 9)}" y1="${r1(yOf(p))}" x2="${r1(x + 9)}" y2="${r1(yOf(p))}" class="ledger"/>`);
    for (let p = 10; p <= pos; p += 2) g.push(`<line x1="${r1(x - 9)}" y1="${r1(yOf(p))}" x2="${r1(x + 9)}" y2="${r1(yOf(p))}" class="ledger"/>`);
    // 臨時記号
    if (e.accidental) g.push(`<text x="${r1(x - 17)}" y="${r1(y + (e.accidental === 'flat' ? 4 : 5))}" class="acc">${e.accidental === 'sharp' ? '♯' : e.accidental === 'flat' ? '♭' : '♮'}</text>`);
    // 重音の下の音（同じ符幹にもう 1 つのたま）
    if (e.dbl) {
      const dp = posOf(e.dbl), dy = yOf(dp);
      for (let p = -2; p >= dp; p -= 2) g.push(`<line x1="${r1(x - 9)}" y1="${r1(yOf(p))}" x2="${r1(x + 9)}" y2="${r1(yOf(p))}" class="ledger"/>`);
      if (e.dblAccidental) g.push(`<text x="${r1(x - 17)}" y="${r1(dy + (e.dblAccidental === 'flat' ? 4 : 5))}" class="acc">${e.dblAccidental === 'sharp' ? '♯' : e.dblAccidental === 'flat' ? '♭' : '♮'}</text>`);
      const hollowD = e.type === 'half' || e.type === 'whole';
      g.push(`<ellipse cx="${r1(x)}" cy="${r1(dy)}" rx="5.4" ry="3.9" transform="rotate(-20 ${r1(x)} ${r1(dy)})" class="${hollowD ? 'hollow' : 'ink'}"/>`);
      if (e.type !== 'whole') { const upD = pos < 4; const sxD = x + (upD ? 5 : -5); g.push(`<line x1="${r1(sxD)}" y1="${r1(dy)}" x2="${r1(sxD)}" y2="${r1(y)}" class="stem"/>`); }
    }
    // たま
    const hollow = e.type === 'half' || e.type === 'whole';
    g.push(`<ellipse cx="${r1(x)}" cy="${r1(y)}" rx="5.4" ry="3.9" transform="rotate(-20 ${r1(x)} ${r1(y)})" class="${hollow ? 'hollow' : 'ink'}"/>`);
    // 付点
    for (let d = 0; d < e.dots; d++) g.push(`<circle cx="${r1(x + 9 + d * 4.5)}" cy="${r1(pos % 2 === 0 ? y - SP / 2 : y)}" r="1.7" class="ink"/>`);
    // 符幹・旗
    const up = stemDir[i] != null ? stemDir[i] : pos < 4;
    if (e.type !== 'whole') {
      const sx = x + (up ? 5 : -5);
      const ey = beamY[i] != null ? beamY[i] : y + (up ? -3.4 * SP : 3.4 * SP);
      g.push(`<line x1="${r1(sx)}" y1="${r1(y + (up ? -1 : 1))}" x2="${r1(sx)}" y2="${r1(ey)}" class="stem"/>`);
      if (beamY[i] == null && (e.type === 'eighth' || e.type === '16th')) {
        const n = e.type === '16th' ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const fy = ey + (up ? k * 7 : -k * 7);
          g.push(up
            ? `<path d="M${r1(sx)} ${r1(fy)} c 1 6 9 8 7 17 c 1 -7 -4 -10 -7 -12 z" class="ink"/>`
            : `<path d="M${r1(sx)} ${r1(fy)} c 1 -6 9 -8 7 -17 c 1 7 -4 10 -7 12 z" class="ink"/>`);
        }
      }
    }
    // 記号
    if (e.trill) g.push(`<text x="${r1(x - 4)}" y="${r1(Math.min(STAFF_TOP - 4, y - 16))}" class="orn">tr</text>`);
    if (e.accent) g.push(`<text x="${r1(x - 4)}" y="${r1(up ? Math.max(yOf(0) + 14, y + 16) : Math.min(STAFF_TOP - 4, y - 12))}" class="accent">&gt;</text>`);
    if (e.slide) g.push(`<line x1="${r1(x - 16)}" y1="${r1(y + 7)}" x2="${r1(x - 8)}" y2="${r1(y + 1)}" class="stem"/>`);
    if (e.tech) g.push(`<text x="${r1(x - 6)}" y="${r1(Math.min(STAFF_TOP - (e.trill ? 18 : 4), y - (e.trill ? 30 : 16)))}" class="tech">${e.tech}</text>`);
    if (e.trem) {
      // トレモロ：符幹（全音符はたまの上）に斜めの 3 本線
      const sx = e.type === 'whole' ? x : x + (up ? 5 : -5);
      const my = e.type === 'whole' ? y - 2.6 * SP : y + (up ? -2.2 * SP : 1.6 * SP);
      for (let k = 0; k < 3; k++) g.push(`<line x1="${r1(sx - 4.5)}" y1="${r1(my + k * 3.6 + 1.6)}" x2="${r1(sx + 4.5)}" y2="${r1(my + k * 3.6 - 1.6)}" class="trem"/>`);
    }
    onTie({ x, y, up, start: !!e.tieStart, stop: !!e.tieStop }); // 符幹が上ならタイは下
  });
}

// 駆け上がりの小さな音符（符幹は上・連桁 2 本）
function drawGraces(g, e, xStart) {
  const heads = e.graces.map((gp, k) => ({ x: xStart + k * GRACE_W + 3, pos: posOf(gp) }));
  const top = Math.min(...heads.map((h) => yOf(h.pos))) - 22;
  heads.forEach((h, k) => {
    const y = yOf(h.pos);
    for (let p = -2; p >= h.pos; p -= 2) g.push(`<line x1="${r1(h.x - 5)}" y1="${r1(yOf(p))}" x2="${r1(h.x + 5)}" y2="${r1(yOf(p))}" class="ledger"/>`);
    for (let p = 10; p <= h.pos; p += 2) g.push(`<line x1="${r1(h.x - 5)}" y1="${r1(yOf(p))}" x2="${r1(h.x + 5)}" y2="${r1(yOf(p))}" class="ledger"/>`);
    const gp = e.graces[k];
    if (gp.alter) g.push(`<text x="${r1(h.x - 8.5)}" y="${r1(y + 3)}" class="gacc">${gp.alter === 1 ? '♯' : '♭'}</text>`);
    g.push(`<ellipse cx="${r1(h.x)}" cy="${r1(y)}" rx="3.3" ry="2.4" transform="rotate(-20 ${r1(h.x)} ${r1(y)})" class="ink"/>`);
    g.push(`<line x1="${r1(h.x + 3)}" y1="${r1(y - 1)}" x2="${r1(h.x + 3)}" y2="${r1(top)}" class="gstem"/>`);
  });
  const xa = heads[0].x + 3, xb = heads[heads.length - 1].x + 3;
  for (const dy of [0, 4]) g.push(`<line x1="${r1(xa)}" y1="${r1(top + dy)}" x2="${r1(xb)}" y2="${r1(top + dy)}" class="gbeam"/>`);
}

function drawRest(g, x, e, m) {
  const t = STAFF_TOP;
  if (e.dur === m.barLen && e.type !== 'quarter') { g.push(`<rect x="${r1(x - 6)}" y="${r1(yOf(6))}" width="12" height="5" class="ink"/>`); return; }
  switch (e.type) {
    case 'whole': g.push(`<rect x="${r1(x - 6)}" y="${r1(yOf(6))}" width="12" height="5" class="ink"/>`); break;
    case 'half': g.push(`<rect x="${r1(x - 6)}" y="${r1(yOf(4) - 5)}" width="12" height="5" class="ink"/>`); break;
    case 'quarter':
      g.push(`<path d="M${r1(x - 2)} ${r1(t + SP * 0.4)} l 5.5 6.5 l -4.5 5 l 5 7 c -4 -1.6 -7 0 -4 4.6 c -6 -3 -5 -8.4 1.4 -7.4 l -5.4 -6.6 l 4.6 -5.2 z" class="ink"/>`);
      break;
    case 'eighth':
    case '16th': {
      const n = e.type === '16th' ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const yy = t + SP * 1.5 + k * SP;
        g.push(`<circle cx="${r1(x - 2 - k * 1.5)}" cy="${r1(yy)}" r="2.3" class="ink"/><path d="M${r1(x - 2 - k * 1.5)} ${r1(yy + 1.5)} q 4 1.5 7 -2.5" class="stem"/>`);
      }
      g.push(`<line x1="${r1(x + 5)}" y1="${r1(t + SP * 1.3)}" x2="${r1(x + 0.5 - (n - 1) * 3)}" y2="${r1(t + SP * (3 + n - 1))}" class="stem"/>`);
      break;
    }
  }
  // 付点休符（使わない設定だが念のため）
  if (e.dots) g.push(`<circle cx="${r1(x + 9)}" cy="${r1(yOf(5))}" r="1.7" class="ink"/>`);
}

export const SCORE_CSS = `
.score-page{background:#fff;color:#111;border-radius:10px;padding:26px 28px 34px;}
.score-head h2{margin:0 0 2px;font:700 22px/1.3 "Hiragino Mincho ProN","Yu Mincho",serif;text-align:center;color:#111}
.score-head p{margin:0 0 14px;text-align:center;color:#444;font-size:13px}
.score-head .by{color:#888;margin-left:8px}
svg.system{display:block;margin:0 0 4px;break-inside:avoid;page-break-inside:avoid}
svg.system .st{stroke:#222;stroke-width:1}
svg.system .bar{stroke:#222;stroke-width:1.3}
svg.system .ledger{stroke:#222;stroke-width:1.2}
svg.system .stem{stroke:#111;stroke-width:1.3;fill:none}
svg.system .ink{fill:#111}
svg.system .hollow{fill:#fff;stroke:#111;stroke-width:1.6}
svg.system .tie{fill:none;stroke:#111;stroke-width:1.2}
svg.system .clef{font:42px ${MUSIC_FONT};fill:#111}
svg.system .ts{font:700 21px "Times New Roman",serif;fill:#111}
svg.system .acc{font:17px "Hiragino Sans","Apple Symbols",sans-serif;fill:#111}
svg.system .mnum{font:italic 10px serif;fill:#555}
svg.system .mcount{font:700 15px "Times New Roman",serif;fill:#111;text-anchor:middle}
svg.system .mrest{fill:#111}
svg.system .chord{font:600 12px -apple-system,"Hiragino Sans",sans-serif;fill:#333}
svg.system .sec{font:700 12px "Hiragino Sans",sans-serif;fill:#111}
svg.system .sec .role{font-weight:400;fill:#666;font-size:10.5px}
svg.system .secbox{fill:#f3ece2;stroke:#c9b49a;stroke-width:1}
svg.system .dyn{font:italic 700 15px "Times New Roman",serif;fill:#111}
svg.system .orn{font:italic 700 13px "Times New Roman",serif;fill:#111}
svg.system .accent{font:700 13px sans-serif;fill:#111}
svg.system .tech{font:italic 11px serif;fill:#111}
svg.system .gstem{stroke:#111;stroke-width:0.9}
svg.system .gbeam{stroke:#111;stroke-width:2.2}
svg.system .gacc{font:9px ${MUSIC_FONT};fill:#111}
svg.system .trem{stroke:#111;stroke-width:2.2}
`;

// ト音記号は文字（フォント）で描くので、大きさがフォントによって違う。描いたあとで測って、五線にちょうど合う大きさにそろえる
export function fitClefs(root) {
  for (const t of root.querySelectorAll('text.clef')) {
    t.removeAttribute('transform');
    let b;
    try { b = t.getBBox(); } catch { continue; }
    if (!b || !b.height) continue;
    const top = +t.dataset.top, bottom = +t.dataset.bottom, left = +t.dataset.left;
    const k = (bottom - top) / b.height;
    // 拡大してから、上端と左端を合わせる
    const tx = left - b.x * k, ty = top - b.y * k;
    t.setAttribute('transform', `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(4)})`);
  }
}
