// 型（パターン）：1・5・8 の上り下り、スケール、リックなど。区間ごとに選ぶと、その区間はこの型で弾く。
// 音の高さは「その場のコードの度数（1・3・5・7・8…）」や「調の音階の段（0・+1・-1…）」で書いておき、
// 弾くときに、その場のコードと調に合わせて決める（だから、どの曲・どのコードでも濁らない）。
//   和音の型（kind 'chord'）：degs＝コードの度数の並び。リズムの音ごとに順にくり返す（小節ごとに最初から）
//   音階の型（kind 'steps'）：steps＝和音の音からの音階の段の並び（小節ごとに、その場の和音の音から）
//   スケール（kind 'scale'）：mode＝wave（上り下りの波）／thirds（3度で）／run-hold（駆け上がって伸ばす）／fall-hold／chromatic-run
//   リック（kind 'lick'）：notes＝[16 分の位置, 長さ, 高さ, 飾り]。高さは 数＝音階の段、'c±n'＝半音、'p±n'＝ペンタトニックの段、'aX'＝コードの度数
//     anchor＝始まりの和音の音（1・3・5・8）。resp＝リックのあとの小節（hold＝伸ばす／rest＝休む／seq＝高さを変えてもう一度）

// リズム：16 文字＝4/4 の 1 小節（x＝音の始まり・-＝のばす・.＝休み）。3/4 では前の 12 文字
export const RHYTHMS = {
  w: ['全音符', 'x---------------'],
  h: ['2分音符', 'x-------x-------'],
  q: ['4分音符', 'x---x---x---x---'],
  e: ['8分音符', 'x-x-x-x-x-x-x-x-'],
  s: ['16分音符', 'xxxxxxxxxxxxxxxx'],
  dot: ['付点8分＋16分', 'x--xx--xx--xx--x'],
  off: ['8分の裏（裏打ち）', '..x-..x-..x-..x-'],
  ttz: ['3＋3＋2', 'x--x--x-x--x--x-'],
  e16: ['8分＋16分2つ', 'x-xxx-xxx-xxx-xx'],
  sync: ['シンコペーション', 'x-x-.x-xx-x-.x-x'],
};
export const ARTS = { legato: '弓でなめらかに', detache: '弓で 1 音ずつ', spic: '短く（スタッカート）', pizz: 'はじく（ピチカート）', trem: 'トレモロ' };
export const DOUBLES = { '': '重ねない', '3-': '3度下を重ねる（重音）', '6-': '6度下を重ねる（重音）', '8-': 'オクターブ下を重ねる（重音）', '5-': '5度下を重ねる（パワーコード）' };
// コードの度数として書ける記号（8＝1 のオクターブ上、10＝3 のオクターブ上、12＝5 のオクターブ上、-5＝根音の下の 5 度）
export const CHORD_TOKENS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '15', '-3', '-5', '-7', '-8'];
export const CATEGORIES = [['chord', '和音の型（伴奏）'], ['scale', 'スケール'], ['lick', 'リック'], ['custom', '自分で作った型']];

export const PATTERNS = [
  // ── 和音の型
  { id: 'r158-8', cat: 'chord', kind: 'chord', name: '1・5・8（8分の上り下り）', desc: '根音・5度・オクターブ・5度を 8 分で。ロック・ポップスの伴奏の基本', degs: ['1', '5', '8', '5'], rhythm: 'e', art: 'detache' },
  { id: 'r158-4', cat: 'chord', kind: 'chord', name: '1・5・8（4分・ゆったり）', desc: '同じ 1・5・8 を 4 分でなめらかに。バラードの A メロに', degs: ['1', '5', '8', '5'], rhythm: 'q', art: 'legato' },
  { id: 'r15812-16', cat: 'chord', kind: 'chord', name: '1・5・8・12（16分で駆け上がる）', desc: '拍ごとに根音から 2 オクターブ近くまで駆け上がる。サビの勢いに', degs: ['1', '5', '8', '12'], rhythm: 's', art: 'spic' },
  { id: 'r158-332', cat: 'chord', kind: 'chord', name: '1・5・8（3＋3＋2 のリズム）', desc: 'はずむシンコペーション。ドラムの 3＋3＋2 と合わせやすい', degs: ['1', '5', '8'], rhythm: 'ttz', art: 'detache' },
  { id: 'r158-dot', cat: 'chord', kind: 'chord', name: '1・5・8（付点のはずみ）', desc: '付点 8 分＋16 分で跳ねる 1・5・8', degs: ['1', '5', '8', '5'], rhythm: 'dot', art: 'detache' },
  { id: 'r15-h', cat: 'chord', kind: 'chord', name: '1・5（2分音符）', desc: '根音と 5 度を 2 拍ずつ。いちばんシンプルな土台', degs: ['1', '5'], rhythm: 'h', art: 'legato' },
  { id: 'arp1353', cat: 'chord', kind: 'chord', name: '分散和音 1・3・5・3（8分）', desc: '和音の音を 8 分で上り下り', degs: ['1', '3', '5', '3'], rhythm: 'e', art: 'legato' },
  { id: 'arp13585-16', cat: 'chord', kind: 'chord', name: '分散和音 1・3・5・8・5・3（16分）', desc: '16 分で山なりに上り下りする分散和音', degs: ['1', '3', '5', '8', '5', '3'], rhythm: 's', art: 'legato' },
  { id: 'arp-pizz', cat: 'chord', kind: 'chord', name: 'ピチカートの分散和音（1・5・8・10）', desc: '弦をはじいて軽く。A メロや静かな所に', degs: ['1', '5', '8', '10'], rhythm: 'e', art: 'pizz' },
  { id: 'power-chop', cat: 'chord', kind: 'chord', name: 'パワーコードの刻み（1＋5 の重音・8分）', desc: '根音と 5 度を同時に、短く 8 分で刻む', degs: ['5'], dbl: '5-', rhythm: 'e', art: 'spic' },
  { id: 'off3', cat: 'chord', kind: 'chord', name: '裏打ち（3度を 8分の裏で）', desc: '拍の頭はベースとキックにまかせて、裏拍だけを短く', degs: ['3'], rhythm: 'off', art: 'spic' },
  { id: 'trem35', cat: 'chord', kind: 'chord', name: 'トレモロで 3度・5度（2分音符）', desc: '弓をこまかく往復させて伸ばす。盛り上げ・緊張に', degs: ['3', '5'], rhythm: 'h', art: 'trem' },
  // ── スケール
  { id: 'sc-wave8', cat: 'scale', kind: 'scale', name: 'スケールの上り下り（8分の波）', desc: '1 小節ごとに上って、次の小節で下りる。拍の頭は和音の音', mode: 'wave', unit: 2 },
  { id: 'sc-wave16', cat: 'scale', kind: 'scale', name: 'スケールの上り下り（16分の波）', desc: '2 拍で上って 2 拍で下りる、細かい波', mode: 'wave', unit: 1 },
  { id: 'sc-thirds', cat: 'scale', kind: 'scale', name: '3度で上がって下がる（8分）', desc: 'ド・ミ・レ・ファ…のように 3 度ずつ。クラシカルな動き', mode: 'thirds', unit: 2 },
  { id: 'sc-penta16', cat: 'scale', kind: 'scale', name: 'ペンタトニックの上り下り（16分）', desc: '調のペンタトニック（5 音）で。ロック・ブルースっぽく', mode: 'wave', unit: 1, penta: true },
  { id: 'sc-runhold', cat: 'scale', kind: 'scale', name: '駆け上がって伸ばす', desc: '2 拍で 16 分の駆け上がり（次は駆け下り）、着いた和音の音を 2 拍伸ばす', mode: 'run-hold' },
  { id: 'sc-fallhold', cat: 'scale', kind: 'scale', name: '上から下りて伸ばす', desc: '高い所から 16 分で下りて、和音の音で伸ばす', mode: 'fall-hold' },
  { id: 'sc-chrom', cat: 'scale', kind: 'scale', name: '半音階で駆け上がる', desc: '伸ばした音のあと、最後の 1 拍で半音ずつ駆け上がって次の小節へ', mode: 'chromatic-run' },
  // ── リック
  { id: 'lk-turn', cat: 'lick', kind: 'lick', name: 'ターン（回り込み）', desc: '3 度の音のまわりを上・下と回って伸ばす', anchor: '3', resp: 'rest', notes: [[0, 1, 0], [1, 1, 1], [2, 1, 0], [3, 1, -1], [4, 12, 0, { vib: 1 }]] },
  { id: 'lk-3down', cat: 'lick', kind: 'lick', name: '3音ずつ下りる（シーケンス）', desc: '5 度から 3 音ずつ下りて根音へ', anchor: '5', resp: 'rest', notes: [[0, 1, 0], [1, 1, -1], [2, 1, -2], [3, 1, -1], [4, 1, -2], [5, 1, -3], [6, 1, -2], [7, 1, -3], [8, 1, -4], [9, 1, -3], [10, 1, -4], [11, 1, -5], [12, 4, -4, { vib: 1 }]] },
  { id: 'lk-slide', cat: 'lick', kind: 'lick', name: '下からずり上げて伸ばす', desc: '音を下からずり上げて、ビブラートで歌うように伸ばす。次は高さを変えてもう一度', anchor: '5', resp: 'seq', notes: [[0, 2, -1], [2, 14, 0, { bend: 2, vib: 1 }]] },
  { id: 'lk-chrom', cat: 'lick', kind: 'lick', name: '半音下から滑り込む', desc: '半音下から 5 度へ滑り込み、3 度まで下りて伸ばす。ブルースっぽい入り方', anchor: '5', resp: 'rest', notes: [[0, 1, 'c-1'], [1, 3, 0], [4, 2, -1], [6, 10, -2, { vib: 1 }]] },
  { id: 'lk-trill', cat: 'lick', kind: 'lick', name: 'トリルから落とす', desc: '5 度でトリル、そのあと 2 音で下りる', anchor: '5', resp: 'rest', notes: [[0, 10, 0, { trill: 2 }], [10, 2, -1], [12, 4, -2, { vib: 1 }]] },
  { id: 'lk-sync', cat: 'lick', kind: 'lick', name: '同じ音の連打（シンコペーション）', desc: '同じ音を裏で刻んで、最後に 1 つ上がる', anchor: '5', resp: 'hold', notes: [[0, 2, 0], [3, 2, 0], [6, 3, 0], [10, 2, 0], [12, 4, 1, { vib: 1 }]] },
  { id: 'lk-penta', cat: 'lick', kind: 'lick', name: 'ペンタの決めフレーズ（下降）', desc: 'オクターブ上の根音からペンタトニックで 1 オクターブ下りる', anchor: '8', resp: 'rest', notes: [[0, 1, 'p0'], [1, 1, 'p-1'], [2, 1, 'p-2'], [3, 1, 'p-3'], [4, 2, 'p-4'], [6, 10, 'p-5', { vib: 1 }]] },
  { id: 'lk-octave', cat: 'lick', kind: 'lick', name: 'オクターブで跳んで、音階で下りる', desc: '根音からオクターブ上へ跳んで伸ばし、音階で 5 度まで下りる', anchor: '1', resp: 'rest', notes: [[0, 2, 0], [2, 6, 7, { vib: 1 }], [8, 2, 6], [10, 2, 5], [12, 4, 4, { vib: 1 }]] },
  { id: 'lk-arppeak', cat: 'lick', kind: 'lick', name: '分散で駆け上がって頂点で伸ばす', desc: '1・3・5・8 と駆け上がり、オクターブ上の 3 度で伸ばす', anchor: '1', resp: 'rest', notes: [[0, 1, 'a1'], [1, 1, 'a3'], [2, 1, 'a5'], [3, 1, 'a8'], [4, 12, 'a10', { vib: 1 }]] },
  { id: 'lk-qa', cat: 'lick', kind: 'lick', name: '問いと答え（2小節）', desc: '短く上がる問い（ペンタ）と、音階で下りる答え', anchor: '5', resp: 'rest', bars: 2, notes: [[2, 2, 'p0'], [4, 2, 'p1'], [6, 6, 'p2', { vib: 1 }], [16, 2, 1], [18, 2, 0], [20, 2, -1], [22, 2, -2], [24, 8, -3, { vib: 1 }]] },
];

// 型を、弾くための形にそろえる（リズムの記号 → 16 文字、足りない所は決まりの値）
export function normalizePattern(p) {
  if (!p) return null;
  const q = { ...p };
  if (q.rhythm != null) q.rhythm = RHYTHMS[q.rhythm] ? RHYTHMS[q.rhythm][1] : String(q.rhythm);
  q.art = q.art || 'detache';
  q.dbl = q.dbl || '';
  if (q.kind === 'scale') { q.unit = q.unit || 2; q.mode = q.mode || 'wave'; }
  if (q.kind === 'lick') { q.bars = q.bars || 1; q.resp = q.resp || 'rest'; q.anchor = q.anchor || '5'; }
  return q;
}

export function findPattern(id, custom = []) {
  if (!id) return null;
  return PATTERNS.find((p) => p.id === id) || (custom || []).find((p) => p.id === id) || null;
}

// 自分で作る型：音の並び（和音の度数 か 音階の段）＋リズム＋弾き方＋重音
//   form = { name, kind: 'chord'|'steps', tokens: '1 5 8 5', rhythm: 'e'（または 16 文字の x/-/.）, art, dbl }
export function parseCustom(form) {
  const name = String(form.name || '').trim().slice(0, 24) || '自分の型';
  const kind = form.kind === 'steps' ? 'steps' : 'chord';
  const toks = String(form.tokens || '').replace(/[、，,・／/]/g, ' ').replace(/＋/g, '+').replace(/[－−ー]/g, '-').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return { ok: false, error: '音の並びを入れてください（例：1 5 8 5）' };
  if (toks.length > 16) return { ok: false, error: '音の並びは 16 個までです' };
  if (kind === 'chord') {
    const bad = toks.filter((t) => !CHORD_TOKENS.includes(t));
    if (bad.length) return { ok: false, error: `使えない記号：${bad.join(' ')}（使えるのは ${CHORD_TOKENS.join(' ')}）` };
  } else {
    const bad = toks.filter((t) => !/^[+-]?\d{1,2}$/.test(t) || Math.abs(parseInt(t, 10)) > 14);
    if (bad.length) return { ok: false, error: `使えない記号：${bad.join(' ')}（音階の段は -14〜14 の数。0＝始まりの和音の音、1＝1 つ上）` };
  }
  let rhythm = form.rhythm || 'e';
  if (!RHYTHMS[rhythm]) {
    rhythm = String(rhythm).replace(/\s/g, '');
    if (!/^[x.\-]{4,16}$/.test(rhythm) || !rhythm.includes('x') || rhythm[0] === '-') return { ok: false, error: 'リズムは x（音）・-（のばす）・.（休み）で 16 文字まで、最初は x か . にしてください' };
    rhythm = rhythm.repeat(Math.ceil(16 / rhythm.length)).slice(0, 16); // 短い形は、くり返して 1 小節にする
  }
  const art = ARTS[form.art] ? form.art : 'detache';
  const dbl = DOUBLES[form.dbl] != null ? form.dbl : '';
  const p = { id: form.id || 'u' + Date.now().toString(36), cat: 'custom', kind, name, rhythm, art, dbl };
  if (kind === 'chord') p.degs = toks; else p.steps = toks.map((t) => parseInt(t, 10));
  p.desc = `${kind === 'chord' ? 'コードの度数' : '音階の段'} ${toks.join(' ')}・${RHYTHMS[form.rhythm] ? RHYTHMS[form.rhythm][0] : 'リズム ' + rhythm}・${ARTS[art]}${dbl ? '・' + DOUBLES[dbl] : ''}`;
  return { ok: true, pattern: p };
}
