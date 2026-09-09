#!/usr/bin/env node
// data/**/*.yaml の sources[].url を実際に叩いて、切れているリンクを洗い出す。
//
//   node scripts/check-sources.mjs
//
// 「出典 URL を書いたが実在しない」が一番たちの悪い壊れ方なので、
// 本文を書いたあとに必ず 1 回通す。
//
// 403 は bot 避け（loc.gov など）で、ブラウザからは見られる。OK 扱いにして印だけ付ける。

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { loadYaml } from './lib/yamlio.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UA =
  'Mozilla/5.0 (compatible; ww2-atlas/0.1; +https://github.com/tanimutomo/ww2-atlas)';

const DIRS = ['data/decisions', 'data/homefront', 'data/events/overrides', 'data/seed-wikipedia'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collect() {
  /** @type {Map<string, {title: string, where: string[]}>} */
  const urls = new Map();
  for (const d of DIRS) {
    const dir = resolve(ROOT, d);
    if (!existsSync(dir)) continue;
    for (const f of (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f))) {
      const records = (await loadYaml(resolve(dir, f))) ?? [];
      for (const rec of records) {
        for (const s of rec.sources ?? []) {
          if (!s?.url) continue;
          const hit = urls.get(s.url) ?? { title: s.title, where: [] };
          hit.where.push(`${d}/${f}:${rec.id}`);
          urls.set(s.url, hit);
        }
      }
    }
  }
  return urls;
}

async function check(url) {
  try {
    // HEAD を拒む相手が多いので GET で開いて、本文は読まずに切る
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    res.body?.cancel();
    return res.status;
  } catch (err) {
    return `ERR ${err.message}`;
  }
}

const urls = await collect();
console.log(`${urls.size} 件の URL を確認します\n`);

const bad = [];
const blocked = [];
let i = 0;
for (const [url, meta] of urls) {
  i++;
  const status = await check(url);
  const ok = status === 200;
  const isBlocked = status === 403 || status === 429;
  if (!ok && !isBlocked) bad.push({ url, status, meta });
  if (isBlocked) blocked.push({ url, status });
  process.stdout.write(`\r  ${i}/${urls.size}  `);
  await sleep(250);
}
console.log('\n');

if (blocked.length) {
  console.log(`△ bot 避けで弾かれた（ブラウザからは見られる想定）: ${blocked.length} 件`);
  for (const b of blocked) console.log(`   ${b.status}  ${b.url}`);
  console.log('');
}

if (bad.length) {
  console.error(`✖ 到達できない URL ${bad.length} 件`);
  for (const b of bad) {
    console.error(`   ${b.status}  ${b.url}`);
    console.error(`        ${b.meta.where.join(', ')}`);
  }
  process.exit(1);
}
console.log(`✓ 切れているリンクはありません（${urls.size} 件中 ${blocked.length} 件は bot 避け）`);
