// 状況図（ラスタ）の画素座標 → 経緯度。最小二乗でアフィン変換を当てる。
//
// なぜアフィンで足りるか: West Point のアトラスは 1 枚が数百 km の範囲しか写して
// いないので、円錐図法でも 1 枚の中では平面で近似できる。実際に当てると残差は
// 数 km に収まる（合わなければ georef-check が落とすので、黙って通ることはない）。
//
// ⚠ 画素座標は「原寸」ではなく **幅 `small_width` に縮めた画像**のもの。
//   拡大して読むので、原寸のままだと数え間違える。縮めた側で統一する。

/** 正規方程式をガウス消去で解く（3 変数なので素朴でよい） */
function solve(A, b) {
  const m = A.length;
  const k = A[0].length;
  const M = Array.from({ length: k }, (_, i) => [
    ...Array.from({ length: k }, (_, j) => A.reduce((s, row, r) => s + row[i] * row[j], 0)),
    A.reduce((s, row, r) => s + row[i] * b[r], 0),
  ]);
  for (let i = 0; i < k; i++) {
    let p = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    for (let r = i + 1; r < k; r++) {
      const f = M[r][i] / M[i][i];
      for (let c = i; c <= k; c++) M[r][c] -= f * M[i][c];
    }
  }
  const x = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = M[i][k];
    for (let j = i + 1; j < k; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

/**
 * 基底。order 1 はアフィン、order 2 は 2 次。
 * 1 枚が数百 km を超える図（例: ブルターニュからアントワープまで）は、
 * 円錐図法の曲がりがアフィンに収まらない。2 次にすると残差が目に見えて減る。
 */
const basis = (px, py, order) =>
  order >= 2 ? [px, py, px * py, px * px, py * py, 1] : [px, py, 1];

/** 基準点 [{px, py, lon, lat}] から係数を当てる */
export function fitAffine(points, order = 1) {
  const need = order >= 2 ? 8 : 4;
  if (points.length < need) {
    throw new Error(`order ${order} には基準点が ${need} 点以上要る（いまは ${points.length} 点）`);
  }
  const A = points.map((p) => basis(p.px, p.py, order));
  return {
    order,
    lon: solve(A, points.map((p) => p.lon)),
    lat: solve(A, points.map((p) => p.lat)),
  };
}

export const applyAffine = (c, px, py) => {
  const v = basis(px, py, c.order ?? 1);
  return [
    v.reduce((s, x, i) => s + c.lon[i] * x, 0),
    v.reduce((s, x, i) => s + c.lat[i] * x, 0),
  ];
};

/** 基準点ごとの残差（km）と RMSE */
export function residuals(c, points) {
  const each = points.map((p) => {
    const [lon, lat] = applyAffine(c, p.px, p.py);
    const dx = (lon - p.lon) * 111.32 * Math.cos((p.lat * Math.PI) / 180);
    const dy = (lat - p.lat) * 110.57;
    return { name: p.name, km: Math.hypot(dx, dy) };
  });
  const rmse = Math.sqrt(each.reduce((s, e) => s + e.km * e.km, 0) / each.length);
  return { each, rmse };
}

/**
 * 2 画素間の方位（北 0・時計回り）。矢印の向きを度にするのに使う。
 * 画素の y は下向きなので符号を反転する。
 */
export function bearingPx(c, from, to) {
  const [lon1, lat1] = applyAffine(c, from[0], from[1]);
  const [lon2, lat2] = applyAffine(c, to[0], to[1]);
  const dx = (lon2 - lon1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const dy = lat2 - lat1;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}
