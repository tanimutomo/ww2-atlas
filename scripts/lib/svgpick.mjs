// SVG から必要な部分だけ拾う小道具。
//
// 相手は GMT + Illustrator が吐いた 1MB 超の SVG で、大半は埋め込みフォントの
// <glyph>。DOM パーサを持ち込むほどの構造は要らないので、必要な 3 つだけ取る。
//
// 前提（この系列で実際にそうなっていることを確認済み）:
//   - C_* グループの中身は path / polygon だけで、g の入れ子が無い
//   - 都市の点は <circle>、都市名は <text transform="matrix(1 0 0 1 x y)">

/** svg 内の g の id を出現順に返す */
export function groupIds(svg) {
  return [...svg.matchAll(/<g[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
}

/** id を持つグループの「中身の文字列」を返す。入れ子の g が無い前提 */
export function groupBody(svg, id) {
  const open = new RegExp(`<g[^>]*\\bid="${id}"[^>]*>`).exec(svg);
  if (!open) return null;
  const from = open.index + open[0].length;
  const end = svg.indexOf('</g>', from);
  return end < 0 ? null : svg.slice(from, end);
}

/** path / polygon を [{name, fill, d|points}] で返す */
export function shapes(body) {
  const out = [];
  for (const m of body.matchAll(/<(path|polygon)\b([^>]*)\/?>/g)) {
    const attrs = m[2];
    const get = (k) => new RegExp(`\\b${k}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    out.push({ name: m[1], fill: get('fill'), d: get('d'), points: get('points') });
  }
  return out;
}

/** <circle cx cy> をすべて */
export function circles(svg) {
  const out = [];
  for (const m of svg.matchAll(/<circle\b([^>]*)\/?>/g)) {
    const get = (k) => new RegExp(`\\b${k}="([^"]*)"`).exec(m[1])?.[1];
    const px = Number(get('cx')), py = Number(get('cy'));
    if (Number.isFinite(px) && Number.isFinite(py)) out.push({ px, py });
  }
  return out;
}

/** <text transform="matrix(1 0 0 1 x y)">…</text> を [{x, y, text}] で */
export function texts(svg) {
  const out = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  for (const m of svg.matchAll(re)) {
    const tr = /transform="matrix\(1 0 0 1 (-?[\d.]+) (-?[\d.]+)\)"/.exec(m[1]);
    if (!tr) continue;
    const text = m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    out.push({ x: Number(tr[1]), y: Number(tr[2]), text });
  }
  return out;
}
