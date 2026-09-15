#!/usr/bin/env node
// 状況図のジオリファレンスを当て直して残差を出す。
//   node scripts/georef-check.mjs [sheet]
// 基準点を書き換えたときに、黙って精度が落ちないようにするための検査。
// max_rmse_km を超えたら落とす（CI で走らせる）。

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadYaml } from './lib/yamlio.mjs';
import { fitAffine, residuals } from './lib/affine.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'data/units/georef');
const only = process.argv[2];

let bad = 0;
for (const f of (await readdir(DIR)).filter((f) => /\.ya?ml$/.test(f)).sort()) {
  const g = await loadYaml(resolve(DIR, f));
  if (only && g.sheet !== only) continue;
  const c = fitAffine(g.control, g.order ?? 1);
  const { each, rmse } = residuals(c, g.control);
  const limit = g.max_rmse_km ?? 5;
  const ng = rmse > limit;
  if (ng) bad++;
  console.log(`${ng ? '✖' : '✓'} ${g.sheet}  ${g.order ?? 1} 次・基準点 ${g.control.length} 点  RMSE ${rmse.toFixed(2)} km（上限 ${limit}）`);
  for (const e of [...each].sort((a, b) => b.km - a.km).slice(0, 3)) {
    console.log(`     ${e.km.toFixed(2)} km  ${e.name}`);
  }
}
if (bad) {
  console.error(`\n✖ ${bad} 枚が上限を超えている。基準点を取り直すか、上限の根拠を書く`);
  process.exit(1);
}
