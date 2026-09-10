#!/usr/bin/env node
// 面のベクタ系列が存在しない期間・地域の支配領域を、概略から導出する。
//
//   node scripts/build-approx-occupation.mjs
//
// なぜ要るか:
//   Commons の月次図（＝正確な軍事的支配の面）はヨーロッパの 1942-12 で終わる。
//   それ以外は OHM の政体境界しか無く、そこには
//     - 独軍占領下のソ連領（1943 年以降）
//     - 日本占領下の中国（全期間・「中國」relation が 1 本しか無い）
//   が存在しない。放っておくとソ連が 1945 年まで無傷に、中国大陸が 8 年間
//   まったく塗り分けられないまま見える ― どちらも事実と違う。
//
// 2 通りのやり方でマスクを作り、OHM の政体で切り抜く:
//   ① frontlines.yaml の東部戦線（1943 年以降）
//      折れ線を「線より西」の閉じたリングにして、ソ連領を切り出す。
//      閉じ方は「南端から南へ → 西へ → 北端の緯度まで北へ」。
//      前線が回り込まない部分（クリミア）はレコード側の mask_close で足す。
//   ② approx-zones.yaml の範囲そのもの
//      折れ線で表せないもの（クールラント包囲・日本占領下の中国）。
//      clip_to に当たる政体で切り抜くので、粗く陸より外まで囲っておけばよい。
//
// ⚠ どちらも概略（数十 km 単位）。出力に approx: true を付け、UI では薄く塗って
//   Commons 由来の正確な面と区別している。本来は米陸軍半月アトラス（ラスタ・PD）を
//   ジオリファレンスしてトレースすべきところ。
//
// 出力: data/territory/approx/<日付>.json（GeoJSON）＋ index.json
//   1 ファイルにその日付の「概略の面」全部が入る（フロントは 1 枚読めばよい）。

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadYaml } from './lib/yamlio.mjs';
import mapshaper from 'mapshaper';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const OUT = resolve(DATA, 'territory/approx');

// 面のベクタ系列（Commons）が終わる日。ヨーロッパはこれ以前を導出しない
const EUROPE_FROM = '1943-01-01';
// 折れ線のリングを閉じるための箱。ソ連領より十分に西・南に取る
const WEST = 15.0;
const SOUTH = 42.0;

const SOVIET = /Soviet|ソビエト|ソ連|СССР/i;

/** 折れ線（北→南）を「線より西」の閉じたリングにする */
function maskRing(fl) {
  const pts = [...fl.coords, ...(fl.mask_close ?? [])];
  const [firstLon, firstLat] = pts[0];
  const [lastLon] = pts.at(-1);
  return [...pts, [lastLon, SOUTH], [WEST, SOUTH], [WEST, firstLat], [firstLon, firstLat]];
}

const closeRing = (coords) => {
  const r = [...coords];
  const [a, b] = r[0];
  const [x, y] = r.at(-1);
  if (a !== x || b !== y) r.push([a, b]);
  return r;
};

// ────────────────────────────────────────────────────────────────── 読み込み
const frontlines = (await loadYaml(resolve(DATA, 'territory/frontlines.yaml'))) ?? [];
const zonesPath = resolve(DATA, 'territory/approx-zones.yaml');
const zones = existsSync(zonesPath) ? ((await loadYaml(zonesPath)) ?? []) : [];

const geomPath = resolve(DATA, 'territory/geometry.json');
if (!existsSync(geomPath)) {
  console.error('data/territory/geometry.json が無い（npm run fetch:territory）');
  process.exit(1);
}
const geometry = JSON.parse(await readFile(geomPath, 'utf8'));
const keyframes = (await loadYaml(resolve(DATA, 'territory/keyframes.yaml'))).map(String);
const keyframeFor = (date) => {
  let hit = null;
  for (const k of keyframes) if (k <= date) hit = k;
  return hit ?? keyframes[0];
};

const eastLines = frontlines
  .filter((f) => f.theatre === 'europe_east' && f.date >= EUROPE_FROM)
  .sort((a, b) => a.date.localeCompare(b.date));

// 出力する日付 = 東部戦線の日付 ∪ 範囲の from / to の翌日
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const dates = [
  ...new Set([...eastLines.map((f) => f.date), ...zones.flatMap((z) => [z.from, nextDay(z.to)])]),
]
  .filter(Boolean)
  .sort();

/** その日付以下で最も新しい東部戦線 */
const lineFor = (date) => {
  let hit = null;
  for (const f of eastLines) if (f.date <= date) hit = f;
  return hit;
};

/** 政体名にかかる正規表現で、そのキーフレームの幾何を集める */
function baseFeatures(kf, re) {
  const framePath = resolve(DATA, `territory/frames/${kf}.json`);
  if (!existsSync(framePath)) return [];
  const frame = JSON.parse(readFileSync(framePath, 'utf8'));
  return frame.polities
    .filter((p) => re.test(`${p.name ?? ''}${p.name_ja ?? ''}`))
    .flatMap((p) => {
      const g = geometry[String(p.ohm_id)];
      return g ? [{ type: 'Feature', properties: { ohm_id: p.ohm_id }, geometry: g }] : [];
    });
}

/** base（切り抜かれる側）を mask（型）で切り抜いて、リングの配列を返す */
async function clip(base, maskFeatures, tag) {
  if (!base.length || !maskFeatures.length) return [];
  const res = await mapshaper.applyCommands(
    '-i base.json -clip mask.json -clean -o out.json format=geojson',
    {
      'base.json': JSON.stringify({ type: 'FeatureCollection', features: base }),
      'mask.json': JSON.stringify({ type: 'FeatureCollection', features: maskFeatures }),
    },
  );
  if (!res['out.json']) {
    console.warn(`    ${tag}: 切り抜き結果が空`);
    return [];
  }
  const fc = JSON.parse(Buffer.from(res['out.json']).toString('utf8'));
  return (fc.features ?? []).flatMap((f) => {
    const g = f.geometry;
    if (!g) return [];
    return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  });
}

// ─────────────────────────────────────────────────────────────────── 本体
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const index = [];

for (const date of dates) {
  const kf = keyframeFor(date);
  /** control → リングの配列 */
  const byControl = new Map();
  const add = (control, rings) => {
    if (!rings.length) return;
    if (!byControl.has(control)) byControl.set(control, []);
    byControl.get(control).push(...rings);
  };
  const parts = [];

  // ① 東部戦線から「線より西のソ連領」
  const fl = lineFor(date);
  if (fl) {
    const rings = await clip(
      baseFeatures(kf, SOVIET),
      [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [maskRing(fl)] } }],
      `${date} ${fl.id}`,
    );
    if (rings.length) {
      add('axis_occupied', rings);
      parts.push(fl.id);
    }
  }

  // ② 範囲そのもの（clip_to と control が同じものはまとめて切り抜く）
  const alive = zones.filter((z) => z.from <= date && date <= z.to);
  const groups = new Map();
  for (const z of alive) {
    const key = `${z.clip_to}|${z.control}`;
    if (!groups.has(key)) groups.set(key, { clip_to: z.clip_to, control: z.control, zones: [] });
    groups.get(key).zones.push(z);
  }
  for (const g of groups.values()) {
    const rings = await clip(
      baseFeatures(kf, new RegExp(g.clip_to, 'i')),
      g.zones.map((z) => ({
        type: 'Feature',
        properties: { zone: z.id },
        geometry: { type: 'Polygon', coordinates: [closeRing(z.coords)] },
      })),
      `${date} ${g.zones.map((z) => z.id).join(',')}`,
    );
    if (rings.length) {
      add(g.control, rings);
      parts.push(...g.zones.map((z) => z.id));
    }
  }

  if (!byControl.size) {
    // 直前の日付に面があったのなら、空のファイルを出して層を消す
    // （出さないとフロントが「その日以下で最新」を拾い続けて残ってしまう）
    if (index.length) {
      await writeFile(resolve(OUT, `${date}.json`), JSON.stringify({ type: 'FeatureCollection', features: [] }));
      index.push({ date, file: `${date}.json`, keyframe: kf, parts: [] });
      console.log(`  ${date}  （概略の面はここで終わり・空を出した）`);
    } else {
      console.log(`  ${date}  （概略で足すものなし）`);
    }
    continue;
  }
  const fc = {
    type: 'FeatureCollection',
    features: [...byControl].map(([control, rings]) => ({
      type: 'Feature',
      properties: { control, approx: true },
      geometry: { type: 'MultiPolygon', coordinates: rings },
    })),
  };
  await writeFile(resolve(OUT, `${date}.json`), JSON.stringify(fc));
  const kb = Math.round(Buffer.byteLength(JSON.stringify(fc)) / 1024);
  const n = [...byControl.values()].reduce((a, r) => a + r.length, 0);
  console.log(`  ${date}  ${String(kb).padStart(3)}KB  ${String(n).padStart(3)} ポリゴン  ${parts.join(' ')}`);
  index.push({ date, file: `${date}.json`, keyframe: kf, parts });
}

await writeFile(
  resolve(OUT, 'index.json'),
  JSON.stringify(
    {
      _meta: {
        generator: 'scripts/build-approx-occupation.mjs',
        generated_at: new Date().toISOString(),
        method:
          'frontlines.yaml の東部戦線（1943 年以降）を閉じたリングにしたものと、' +
          'approx-zones.yaml の範囲を、OHM の政体境界で切り抜いた。',
        caveat:
          '概略（数十 km 単位）。正確な軍事的支配の面はヨーロッパ 1939-08〜1942-12 の Commons 由来レイヤだけ。' +
          '中国のベタ塗りは同時代の戦況図の慣例に合わせたもので、実効支配は都市と鉄道に限られる。',
        license: 'pd',
      },
      dates: index,
    },
    null,
    2,
  ),
);
console.log(`\n✓ data/territory/approx/ に ${index.length} 日付ぶん`);
