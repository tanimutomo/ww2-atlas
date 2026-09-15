#!/usr/bin/env node
// 画素での読み取り（data/units/readings/*.yaml）を、状況図ごとの変換
// （data/units/georef/*.yaml）で経緯度に直して、
// data/units/snapshots/*.yaml を書き出す。
//
//   node scripts/build-units.mjs
//
// なぜ 2 段にするか: 読み取りは「図の上のどこか」であって経緯度ではない。
// 生の画素を残しておけば、基準点を取り直したときに全部が自動で直る。
// 経緯度だけ手で書いてしまうと、あとから精度を上げる手立てが無くなる。

import { writeFile, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadYaml } from './lib/yamlio.mjs';
import { fitAffine, applyAffine, residuals } from './lib/affine.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data/units');

const georef = new Map();
for (const f of (await readdir(resolve(DATA, 'georef'))).filter((f) => /\.ya?ml$/.test(f))) {
  const g = await loadYaml(resolve(DATA, 'georef', f));
  const c = fitAffine(g.control, g.order ?? 1);
  const { rmse } = residuals(c, g.control);
  georef.set(g.sheet, { ...g, coef: c, rmse });
}

const q = (s) => (/^[\w.+-]+$/.test(String(s)) ? s : JSON.stringify(String(s)));

await mkdir(resolve(DATA, 'snapshots'), { recursive: true });
const files = (await readdir(resolve(DATA, 'readings'))).filter((f) => /\.ya?ml$/.test(f)).sort();
let total = 0;

for (const f of files) {
  const blocks = await loadYaml(resolve(DATA, 'readings', f));
  const out = [];
  for (const b of blocks) {
    const g = georef.get(b.sheet);
    if (!g) throw new Error(`${f}: 図 ${b.sheet} の georef が無い`);
    for (const u of b.units) {
      const [lon, lat] = applyAffine(g.coef, u.px, u.py);
      out.push({
        id: `${b.operation}-${String(b.date).replace(/-/g, '')}-${String(u.unit).toLowerCase()}`,
        unit: u.unit,
        name_ja: u.name_ja,
        side: u.side,
        echelon: u.echelon,
        date: b.date,
        until: b.until,
        coord: [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4],
        heading: u.heading ?? null,
        event: b.event,
        source_map: { title: b.sources[0].title, url: b.sources[0].url, sheet: b.sheet },
        license: b.license,
        sources: b.sources,
        verified: false,
      });
    }
    console.log(`  ${b.sheet}  ${b.date}  ${b.units.length} 件（この図の残差 RMSE ${g.rmse.toFixed(2)} km）`);
  }
  const name = f.replace(/\.ya?ml$/, '');
  const body = out
    .map((r) => {
      const src = r.sources
        .map((s) => `      - title: ${q(s.title)}\n        url: ${s.url}${s.note ? `\n        note: ${q(s.note)}` : ''}`)
        .join('\n');
      return [
        `  - id: ${r.id}`,
        `    unit: ${r.unit}`,
        `    name_ja: ${q(r.name_ja)}`,
        `    side: ${r.side}`,
        `    echelon: ${r.echelon}`,
        `    date: ${r.date}`,
        `    until: ${r.until}`,
        `    coord: [${r.coord[0]}, ${r.coord[1]}]`,
        `    heading: ${r.heading === null ? 'null' : r.heading}`,
        `    event: ${r.event}`,
        `    source_map: {title: ${q(r.source_map.title)}, url: ${r.source_map.url}, sheet: ${r.source_map.sheet}}`,
        `    license: ${r.license}`,
        `    sources:`,
        src,
        `    verified: false`,
      ].join('\n');
    })
    .join('\n');
  await writeFile(
    resolve(DATA, 'snapshots', `${name}.yaml`),
    `# ⚠ 自動生成。直すのは data/units/readings/${f} か data/units/georef/*.yaml のほう。\n` +
      `#   生成: node scripts/build-units.mjs（${new Date().toISOString().slice(0, 10)}）\n` +
      `${body}\n`,
  );
  total += out.length;
  console.log(`✓ data/units/snapshots/${name}.yaml  ${out.length} 件`);
}
console.log(`\n✓ 配置 ${total} 件`);
