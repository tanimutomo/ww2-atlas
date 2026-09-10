// ランベルト正角円錐図法（楕円体・Snyder）。
//
// Commons の「Second World War Europe MM YYYY de.svg」は GMT で描かれていて、
// SVG の <metadata> に生成コマンドがそのまま残っている:
//
//   pscoast -R-10/30/80/60r -JL15/0/45/60/15c ...
//
// つまり中央経線 15°E・標準緯線 45°N/60°N のランベルト正角円錐図法。
// 図の上の都市点 14 個で最小二乗を当てると残差 RMSE 0.46px（約 1.5km）に収まる。
// 手でトレースするより機械変換のほうが正確、という判断の根拠がこれ。

const A = 6378137.0; // WGS-84（GMT の既定楕円体）
const E2 = 0.00669437999014;
const E = Math.sqrt(E2);
const D = Math.PI / 180;

const m = (p) => Math.cos(p) / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
const t = (p) => Math.tan(Math.PI / 4 - p / 2) / ((1 - E * Math.sin(p)) / (1 + E * Math.sin(p))) ** (E / 2);

export function makeLCC(lon0, lat0, lat1, lat2) {
  const p1 = lat1 * D, p2 = lat2 * D, p0 = lat0 * D;
  const n = (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const F = m(p1) / (n * t(p1) ** n);
  const rho0 = A * F * t(p0) ** n;
  return {
    fwd(lon, lat) {
      const rho = A * F * t(lat * D) ** n;
      const th = n * (lon - lon0) * D;
      return [rho * Math.sin(th), rho0 - rho * Math.cos(th)];
    },
    inv(x, y) {
      const yy = rho0 - y;
      const s = Math.sign(n);
      const rho = s * Math.hypot(x, yy);
      const th = Math.atan2(s * x, s * yy);
      const tt = (rho / (A * F)) ** (1 / n);
      let p = Math.PI / 2 - 2 * Math.atan(tt);
      for (let i = 0; i < 12; i++) {
        p = Math.PI / 2 - 2 * Math.atan(tt * ((1 - E * Math.sin(p)) / (1 + E * Math.sin(p))) ** (E / 2));
      }
      return [th / n / D + lon0, p / D];
    },
  };
}

/**
 * 地図上の基準点（都市の点）から「ピクセル → 経緯度」を最小二乗で決める。
 * 回転は無い（中央経線が縦）ので x と y を独立に当てればよい。
 * gcps: [{px, py, lon, lat}]
 */
export function fitPixelToLonLat(gcps, { lon0 = 15, lat0 = 0, lat1 = 45, lat2 = 60 } = {}) {
  const P = makeLCC(lon0, lat0, lat1, lat2);
  const proj = gcps.map((g) => {
    const [X, Y] = P.fwd(g.lon, g.lat);
    return { ...g, X, Y };
  });
  const fit = (u, v) => {
    const N = u.length;
    const su = u.reduce((a, b) => a + b, 0);
    const sv = v.reduce((a, b) => a + b, 0);
    const suu = u.reduce((a, b) => a + b * b, 0);
    const suv = u.reduce((a, b, i) => a + b * v[i], 0);
    const s = (N * suv - su * sv) / (N * suu - su * su);
    return [s, (sv - s * su) / N];
  };
  const [sx, tx] = fit(proj.map((p) => p.X), proj.map((p) => p.px));
  const [sy, ty] = fit(proj.map((p) => p.Y), proj.map((p) => p.py));

  let sum = 0, max = 0;
  for (const p of proj) {
    const e = Math.hypot(sx * p.X + tx - p.px, sy * p.Y + ty - p.py);
    sum += e * e;
    max = Math.max(max, e);
  }
  const rmse = Math.sqrt(sum / proj.length);

  return {
    rmse,
    max,
    kmPerPx: 1 / Math.abs(sx) / 1000,
    /** ピクセル → [経度, 緯度] */
    toLonLat: (px, py) => P.inv((px - tx) / sx, (py - ty) / sy),
  };
}
