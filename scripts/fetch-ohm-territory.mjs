#!/usr/bin/env node
// OpenHistoricalMap（CC0）から keyframes.yaml の各日付時点の政体境界を取り出し、
// 簡略化して data/territory/<date>.geojson に落とす。
//
// 素朴に日付ごとに `out geom;` を投げると 1 日付 100MB 超・14 日付で 1.5GB になるので、
//   ① 日付ごとに `out tags;`（軽い）で「その日に存在した relation id」を取る
//   ② relation の geometry は **id ごとに 1 回だけ** 取って簡略化してキャッシュ
//   ③ 各日付の GeoJSON はキャッシュから組み立てる
// という順にする。日付をまたいで同じ relation が何度も出てくるので実際の取得量が大きく減る。
//
// キャッシュ（data/raw/ohm/）は gitignore 済み。中断しても再実行で続きから走る。

import { writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import osmtogeojson from 'osmtogeojson';
import mapshaper from 'mapshaper';
import { loadYaml } from './lib/yamlio.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = resolve(ROOT, 'data/raw/ohm');
const GEOM_CACHE = resolve(CACHE, 'geom');
const OUT_DIR = resolve(ROOT, 'data/territory');
const FRAME_DIR = resolve(OUT_DIR, 'frames');

const ENDPOINT = 'https://overpass-api.openhistoricalmap.org/api/interpreter';
const UA = 'ww2-atlas/0.1 (https://github.com/tanimutomo/ww2-atlas; t.tanimura@ispec.tech)';

// admin_level=3 は原則スコープ外だが、占領行政体はここにしか無いので名前で拾う。
// admin_level=4 の Reichsgau は Deutsches Reich の内側なので取らない（面が二重になる）。
const OCCUPATION_L3 = /Reichskommissariat|Generalgouvernement|Protektorat Böhmen/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query, label) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) {
      const wait = 5000 * 2 ** (attempt - 1);
      console.warn(`    retry ${attempt} after ${wait}ms (${label})`);
      await sleep(wait);
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' },
        body: query,
        signal: AbortSignal.timeout(600_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (attempt === 4) throw new Error(`overpass failed (${label}): ${err.message}`);
    }
  }
}

/** ① その日付に存在した relation の tags だけを取る */
const tagsQuery = (date) => `[out:json][timeout:180];
(
  relation["boundary"="administrative"]["admin_level"="2"]["start_date"]
    (if:t["start_date"]<="${date}" && (!is_tag("end_date") || t["end_date"]>"${date}"));
  relation["boundary"="administrative"]["admin_level"="3"]["start_date"]
    (if:t["start_date"]<="${date}" && (!is_tag("end_date") || t["end_date"]>"${date}"));
);
out tags;`;

/** ② relation 1 本の geometry */
const geomQuery = (id) => `[out:json][timeout:300];
relation(${id});
out geom;`;

async function loadTags(date) {
  const file = resolve(CACHE, `tags-${date}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  console.log(`  tags ${date}`);
  const json = await overpass(tagsQuery(date), `tags ${date}`);
  const keep = json.elements.filter(
    (e) =>
      e.tags?.admin_level === '2' ||
      (e.tags?.admin_level === '3' && OCCUPATION_L3.test(e.tags?.name ?? '')),
  );
  await writeFile(file, JSON.stringify(keep, null, 2) + '\n');
  await sleep(1500);
  return keep;
}

/** relation 1 本を取得 → GeoJSON → 簡略化してキャッシュに置く */
async function ensureGeom(id) {
  const file = resolve(GEOM_CACHE, `${id}.geojson`);
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));

  const osm = await overpass(geomQuery(id), `geom ${id}`);
  const fc = osmtogeojson(osm);
  // relation 本体のポリゴンだけ残す（メンバーの way が単体で混ざることがある）
  const feats = fc.features.filter(
    (f) =>
      f.geometry &&
      (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') &&
      String(f.id ?? '').includes(String(id)),
  );
  let out;
  if (!feats.length) {
    out = null;
  } else {
    const input = { 'in.geojson': JSON.stringify({ type: 'FeatureCollection', features: feats }) };
    // keep-shapes: 小島が消えないようにする。2% でも国境の形は残る
    const res = await mapshaper.applyCommands(
      '-i in.geojson -simplify 2% keep-shapes -clean -o out.geojson precision=0.001',
      input,
    );
    const simplified = JSON.parse(Buffer.from(res['out.geojson']).toString('utf8'));
    // 複数 feature に割れていたら 1 本の MultiPolygon にまとめる
    const polys = [];
    for (const f of simplified.features ?? []) {
      if (f.geometry?.type === 'Polygon') polys.push(f.geometry.coordinates);
      else if (f.geometry?.type === 'MultiPolygon') polys.push(...f.geometry.coordinates);
    }
    out = polys.length
      ? polys.length === 1
        ? { type: 'Polygon', coordinates: polys[0] }
        : { type: 'MultiPolygon', coordinates: polys }
      : null;
  }
  await writeFile(file, JSON.stringify(out) + '\n');
  await sleep(1200);
  return out;
}

async function main() {
  await mkdir(GEOM_CACHE, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const dates = await loadYaml(resolve(OUT_DIR, 'keyframes.yaml'));

  console.log('① 日付ごとの relation 一覧');
  /** @type {Map<string, any[]>} */
  const byDate = new Map();
  for (const date of dates) byDate.set(date, await loadTags(date));

  const ids = new Set();
  for (const els of byDate.values()) for (const e of els) ids.add(e.id);
  const cached = new Set(
    (await readdir(GEOM_CACHE).catch(() => [])).map((f) => Number(f.replace('.geojson', ''))),
  );
  const todo = [...ids].filter((id) => !cached.has(id));
  console.log(
    `\n② geometry: ${ids.size} relations（キャッシュ済み ${ids.size - todo.length} / 取得 ${todo.length}）`,
  );

  let done = 0;
  for (const id of todo) {
    done++;
    process.stdout.write(`  [${done}/${todo.length}] relation ${id} ... `);
    try {
      const g = await ensureGeom(id);
      console.log(g ? `ok (${g.type})` : 'ポリゴンなし');
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }

  // ③ 幾何は 1 か所にまとめ、日付ごとのフレームは「どの政体がいたか」だけにする。
  //    同じ政体が何十枚もの日付に出てくるので、日付ごとに幾何を持つと
  //    1 枚 1.1MB × 枚数になってしまう。共有すれば日付を増やすのがほぼ無料になる。
  console.log('\n③ 幾何をまとめる');
  const geometry = {};
  for (const id of ids) {
    const g = await ensureGeom(id).catch(() => null);
    if (g) geometry[id] = g;
  }
  await writeFile(resolve(OUT_DIR, 'geometry.json'), JSON.stringify(geometry) + '\n');
  const geomKb = Math.round(JSON.stringify(geometry).length / 1024);
  console.log(`  ${Object.keys(geometry).length} polities / ${geomKb} KB`);

  console.log('\n④ 日付ごとのフレーム');
  await mkdir(FRAME_DIR, { recursive: true });
  for (const date of dates) {
    const polities = byDate
      .get(date)
      .filter((el) => geometry[el.id])
      .map((el) => ({
        ohm_id: el.id,
        name: el.tags.name ?? el.tags['name:en'] ?? String(el.id),
        name_ja: el.tags['name:ja'] ?? null,
        name_en: el.tags['name:en'] ?? null,
        admin_level: el.tags.admin_level,
        start_date: el.tags.start_date ?? null,
        end_date: el.tags.end_date ?? null,
      }));
    const body = JSON.stringify({ date, polities });
    await writeFile(resolve(FRAME_DIR, `${date}.json`), body + '\n');
    console.log(`  ${date}: ${polities.length} polities (${Math.round(body.length / 1024)} KB)`);
  }

  console.log('\n次: data/territory/faction-map.yaml に ohm_id → control を書く');
  console.log('    `npm run data` で未割当の政体が一覧される');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
