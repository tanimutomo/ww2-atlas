#!/usr/bin/env node
// Wikimedia Commons の「Second World War Europe MM YYYY de.svg」（作者 San Jose・PD）を
// 月次の支配領域ポリゴンに機械変換する。
//
//   node scripts/fetch-commons-control.mjs            # 未取得の月だけ
//   node scripts/fetch-commons-control.mjs --refresh  # 全部引き直す
//
// なぜこれが要るか:
//   OHM の時点境界は「政体の境界」しか持たない。独ソ戦の戦線は国境ではないので、
//   ソ連領内に食い込んだドイツ軍の占領地域が面としてまったく描けていなかった。
//   この系列は「軍事的な支配」で塗り分けられていて、凡例が
//   枢軸／枢軸占領／連合／連合占領／中立の 5 つ＝こちらの control とそのまま対応する。
//
// なぜ機械変換できるか:
//   SVG の <metadata> に GMT の生成コマンドが残っている。
//     pscoast -R-10/30/80/60r -JL15/0/45/60/15c
//   図法とパラメータが判っているので、図中の都市点 14 個で係数を当てれば
//   ピクセル → 経緯度が解析的に決まる。残差は RMSE 0.5px＝約 1.5km。
//
// ⚠ 系列は 1939-08〜1942-12 の 41 か月しか無い（ヨーロッパのみ）。
//   1943 年以降と太平洋・アジアは別の手当てが要る。
//
// 出力: data/territory/control/<YYYY-MM>.json（GeoJSON）＋ index.json

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { groupBody, groupIds, shapes, circles, texts } from './lib/svgpick.mjs';
import { fitPixelToLonLat } from './lib/lcc.mjs';
import mapshaper from 'mapshaper';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = resolve(ROOT, 'data/raw/commons');
const OUT = resolve(ROOT, 'data/territory/control');
const REFRESH = process.argv.includes('--refresh');
const UA = 'ww2-atlas/0.1 (https://github.com/tanimutomo/ww2-atlas; research use)';

// 凡例（Dialog グループ）の並びから確認した対応。念のため図上の都市でも検算している
// （ベルリン→axis、ロンドン／モスクワ→allied、パリ→axis_occupied、マドリード→塗り無し）。
const CONTROL_BY_FILL = {
  '#496EB8': 'axis',            // Achsenmächte sowie ihre Satellitenstaaten und ihre Verbündeten
  '#6787C7': 'axis_occupied',   // Von den Achsenmächten ... besetzte Gebiete
  '#C44F4F': 'allied',          // Alliierte Mächte
  '#D16D6D': 'allied_occupied', // Von den alliierten Mächten besetzte Gebiete
  // #FFFFFF（Neutrale Staaten）は塗らない＝ポリゴンが無い、で表現されている
};

// 図中に点で示されている都市。ここが基準点になる（ラベルはドイツ語表記）。
const CITIES = {
  Barcelona: [2.173, 41.385],
  Berlin: [13.405, 52.52],
  Budapest: [19.04, 47.498],
  Glasgow: [-4.252, 55.864],
  Hamburg: [9.993, 53.551],
  Leningrad: [30.316, 59.939],
  London: [-0.128, 51.507],
  Madrid: [-3.703, 40.417],
  Mailand: [9.19, 45.464],
  Moskau: [37.618, 55.752],
  Paris: [2.352, 48.857],
  Rom: [12.482, 41.896],
  Warschau: [21.012, 52.23],
  Wien: [16.373, 48.208],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────── Commons から拾う
async function listSheets() {
  const sheets = [];
  let cont = null;
  do {
    const u = new URL('https://commons.wikimedia.org/w/api.php');
    u.searchParams.set('action', 'query');
    u.searchParams.set('format', 'json');
    u.searchParams.set('list', 'allimages');
    u.searchParams.set('aiprefix', 'Second World War Europe');
    u.searchParams.set('ailimit', '500');
    if (cont) u.searchParams.set('aicontinue', cont);
    const res = await fetch(u, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Commons API ${res.status}`);
    const j = await res.json();
    for (const img of j.query.allimages) {
      const m = /^Second_World_War_Europe_(\d{2})_(\d{4})_de\.svg$/.exec(img.name);
      if (m) sheets.push({ month: `${m[2]}-${m[1]}`, name: img.name, url: img.url.split('?')[0] });
    }
    cont = j.continue?.aicontinue ?? null;
  } while (cont);
  sheets.sort((a, b) => a.month.localeCompare(b.month));
  return sheets;
}

async function download(sheet) {
  const path = resolve(RAW, sheet.name);
  if (existsSync(path) && !REFRESH) return readFile(path, 'utf8');
  const res = await fetch(sheet.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${sheet.name}: ${res.status}`);
  const text = await res.text();
  await writeFile(path, text);
  await sleep(300);
  return text;
}

// ────────────────────────────────────────────────────── SVG のパスをリングにする
// この系列は直線コマンド（M/L/H/V + 相対）しか使っていない。曲線は出てこない。
const TOK = /([MmLlHhVvZz])|(-?\d*\.?\d+(?:e-?\d+)?)/g;

function pathToRings(d) {
  const toks = [...d.matchAll(TOK)].map((m) => (m[1] ? { cmd: m[1] } : { n: Number(m[2]) }));
  const rings = [];
  let cur = null, x = 0, y = 0, cmd = null, i = 0;
  const close = () => {
    if (cur && cur.length > 2) rings.push(cur);
    cur = null;
  };
  const num = () => {
    while (i < toks.length && toks[i].cmd) i++;
    return toks[i++]?.n ?? 0;
  };
  while (i < toks.length) {
    if (toks[i].cmd) {
      cmd = toks[i].cmd;
      i++;
      if (cmd === 'Z' || cmd === 'z') { close(); continue; }
    }
    if (!cmd) break;
    if (cmd === 'M' || cmd === 'm') {
      close();
      const a = num(), b = num();
      x = cmd === 'M' ? a : x + a;
      y = cmd === 'M' ? b : y + b;
      cur = [[x, y]];
      cmd = cmd === 'M' ? 'L' : 'l';
    } else if (cmd === 'L' || cmd === 'l') {
      const a = num(), b = num();
      x = cmd === 'L' ? a : x + a;
      y = cmd === 'L' ? b : y + b;
      cur?.push([x, y]);
    } else if (cmd === 'H' || cmd === 'h') {
      const a = num();
      x = cmd === 'H' ? a : x + a;
      cur?.push([x, y]);
    } else if (cmd === 'V' || cmd === 'v') {
      const a = num();
      y = cmd === 'V' ? a : y + a;
      cur?.push([x, y]);
    } else break;
  }
  close();
  return rings;
}

const area2 = (r) => {
  let s = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
};

const bbox = (r) => r.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
  [Infinity, Infinity, -Infinity, -Infinity]);

function pointInRing([x, y], r) {
  let c = false;
  for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** 大きいリングから並べ、内側に入るものを穴として割り当てる */
function ringsToPolygons(rings) {
  const sorted = rings
    .map((r) => ({ r, a: Math.abs(area2(r)), bb: bbox(r) }))
    .filter((o) => o.a > 0.5) // 1px 未満のごみは落とす
    .sort((a, b) => b.a - a.a);
  const polys = [];
  for (const o of sorted) {
    const host = polys.find((p) => {
      const [x0, y0, x1, y1] = p.bb;
      return o.bb[0] >= x0 && o.bb[1] >= y0 && o.bb[2] <= x1 && o.bb[3] <= y1 && pointInRing(o.r[0], p.rings[0]);
    });
    if (host) host.rings.push(o.r);
    else polys.push({ rings: [o.r], bb: o.bb });
  }
  return polys.map((p) => p.rings);
}

// ─────────────────────────────────────────────────────────────── 1 枚を変換する
function convert(svg, month) {
  const [year, mm] = month.split('-');

  // 基準点: 図中の circle（都市の点）と text（都市名）を、位置の近さで突き合わせる
  const dots = circles(svg);
  const gcps = [];
  for (const t of texts(svg)) {
    const ll = CITIES[t.text];
    if (!ll) continue;
    let best = null, bd = Infinity;
    for (const c of dots) {
      const d = Math.hypot(c.px - t.x, c.py - t.y);
      if (d < bd) { bd = d; best = c; }
    }
    if (best && bd < 120) gcps.push({ ...best, lon: ll[0], lat: ll[1], name: t.text });
  }
  if (gcps.length < 6) throw new Error(`${month}: 基準点が ${gcps.length} 個しか取れない`);
  const fit = fitPixelToLonLat(gcps);
  if (fit.rmse > 3) throw new Error(`${month}: 当てはめの残差が大きすぎる（RMSE ${fit.rmse.toFixed(2)}px）`);

  // 面は 3 段重ね: 系列を通して不変 → その年で不変 → その月だけ。
  // 月レイヤの id は基本 C_YYYY_MM だが、変化が無かった月は 2 か月まとめて
  // C_1940_06_07 / C_1941_01_02 という名前になっている。決め打ちすると
  // その月だけ「占領地がほぼ無い」静かに間違った地図が出るので、id を走査して選ぶ。
  const ids = groupIds(svg);
  const monthLayers = ids.filter((id) => {
    const m = new RegExp(`^C_${year}_((?:\\d{2}_)*\\d{2})$`).exec(id);
    return m && m[1].split('_').includes(mm);
  });
  if (!monthLayers.length) throw new Error(`${month}: 月レイヤ（C_${year}_${mm} 相当）が見つからない`);
  const byControl = new Map();
  for (const id of ['C_Constant', `C_${year}_Constant`, ...monthLayers]) {
    const body = groupBody(svg, id);
    if (!body) continue;
    for (const el of shapes(body)) {
      const control = CONTROL_BY_FILL[(el.fill ?? '').toUpperCase()];
      if (!control) continue;
      let rings = [];
      if (el.name === 'path' && el.d) rings = pathToRings(el.d);
      else if (el.name === 'polygon' && el.points) {
        const pts = el.points.trim().split(/\s+/).map((p) => p.split(',').map(Number));
        if (pts.length > 2) rings = [pts];
      }
      if (!byControl.has(control)) byControl.set(control, []);
      byControl.get(control).push(...rings);
    }
  }

  const features = [];
  for (const [control, rings] of byControl) {
    const polys = ringsToPolygons(rings).map((p) =>
      p.map((ring) => {
        const out = ring.map(([px, py]) => fit.toLonLat(px, py).map((v) => Number(v.toFixed(4))));
        if (out[0][0] !== out.at(-1)[0] || out[0][1] !== out.at(-1)[1]) out.push(out[0]);
        return out;
      }),
    );
    if (!polys.length) continue;
    features.push({
      type: 'Feature',
      properties: { control },
      geometry: { type: 'MultiPolygon', coordinates: polys },
    });
  }
  return { fc: { type: 'FeatureCollection', features }, fit, gcps: gcps.length };
}

// ───────────────────────────────────────────────────────────────────── 本体
await mkdir(RAW, { recursive: true });
await mkdir(OUT, { recursive: true });

const sheets = await listSheets();
console.log(`Commons に ${sheets.length} 枚（${sheets[0].month} 〜 ${sheets.at(-1).month}）\n`);

const index = [];
for (const sheet of sheets) {
  const svg = await download(sheet);
  const { fc, fit, gcps } = convert(svg, sheet.month);

  // mapshaper で間引く。元は 1px 刻み（≈3.2km）なので、0.6% でも見た目は変わらない
  const input = { 'in.json': JSON.stringify(fc) };
  const cmd = '-i in.json -simplify 0.6% keep-shapes -clean -o out.json format=geojson';
  const res = await mapshaper.applyCommands(cmd, input);
  const simplified = JSON.parse(Buffer.from(res['out.json']).toString('utf8'));
  // mapshaper は要素 1 個の MultiPolygon を Polygon に畳むので、型を揃えておく
  for (const f of simplified.features) {
    if (f.geometry?.type === 'Polygon') {
      f.geometry = { type: 'MultiPolygon', coordinates: [f.geometry.coordinates] };
    }
  }

  const path = resolve(OUT, `${sheet.month}.json`);
  await writeFile(path, JSON.stringify(simplified));
  const kb = Math.round(Buffer.byteLength(JSON.stringify(simplified)) / 1024);
  const counts = Object.fromEntries(
    simplified.features.map((f) => [f.properties.control, f.geometry.coordinates.length]),
  );
  console.log(
    `  ${sheet.month}  ${String(kb).padStart(4)}KB  基準点 ${gcps}  RMSE ${fit.rmse.toFixed(2)}px ` +
      `(${(fit.rmse * fit.kmPerPx).toFixed(1)}km)  ${JSON.stringify(counts)}`,
  );
  index.push({ month: sheet.month, file: `${sheet.month}.json`, source_file: sheet.name, rmse_px: Number(fit.rmse.toFixed(3)) });
}

await writeFile(
  resolve(OUT, 'index.json'),
  JSON.stringify(
    {
      _meta: {
        generator: 'scripts/fetch-commons-control.mjs',
        generated_at: new Date().toISOString(),
        source: 'Wikimedia Commons「Second World War Europe MM YYYY de.svg」（作者 San Jose・パブリックドメイン）',
        source_category: 'https://commons.wikimedia.org/wiki/Category:Maps_of_World_War_II',
        method:
          'SVG の metadata に残っていた GMT の投影指定（-JL15/0/45/60/15c -R-10/30/80/60r）を再現し、' +
          '図上の都市点で係数を当てて逆投影した。残差は各月 index の rmse_px（1px ≒ 3.2km）。',
        license: 'pd',
        coverage: 'ヨーロッパのみ・1939-08 〜 1942-12 の月次',
        caveat:
          '原図そのものが二次的な編集地図で、日単位の前線ではなく「その月末時点のおおよその支配」を示す。',
      },
      months: index,
    },
    null,
    2,
  ),
);
console.log(`\n✓ data/territory/control/ に ${index.length} か月分`);
