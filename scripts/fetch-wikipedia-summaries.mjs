#!/usr/bin/env node
// Wikipedia のリード文を短い要約として取り込む。
//
//   node scripts/fetch-wikipedia-summaries.mjs
//   node scripts/fetch-wikipedia-summaries.mjs --refresh   # 取り直す
//
// なぜ要るか:
//   Event の 520 件のうち、自前の要約（overrides の summary_ja）があるのは 16 件だけで、
//   残りはフィードにタイトルしか出ない。「バトルアクス作戦」とだけ書かれても
//   何が起きたのか分からない、というのが直したいところ。
//
// ⚠ ライセンスの区画:
//   Wikipedia の本文は CC BY-SA。自前要約（pd）と混ぜないという約束なので、
//   ここで取るテキストは data/seed-wikipedia/ にだけ置き、
//   出力も public/data/event-summaries.cc-by-sa.json という別ファイルにする。
//   画面でも「Wikipedia」の印を付けて出す。
//
//   日本語版の記事があるものだけを自動で取る。英語版しか無いものは
//   英語のまま出しても読めないので、本文を見ながら日本語の要約を書いて
//   event-summaries-from-en.yaml に手で入れる（このスクリプトは触らない）。
//
// 出力: data/seed-wikipedia/event-summaries.yaml

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadYaml } from './lib/yamlio.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const OUT = resolve(DATA, 'seed-wikipedia/event-summaries.yaml');
const CACHE = resolve(DATA, 'raw/cache/wikipedia-extracts.json');
const REFRESH = process.argv.includes('--refresh');
const UA = 'ww2-atlas/0.1 (https://github.com/tanimutomo/ww2-atlas; research use)';

/** フィードのカードに収まる長さ。文の切れ目で切る */
const LIMIT = 140;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 文の切れ目で LIMIT 以下に詰める。1 文目だけで超えるなら諦めて切り詰める */
export function trimJa(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= LIMIT) return clean;
  const sentences = clean.split(/(?<=。)/);
  let out = '';
  for (const s of sentences) {
    if (out && (out + s).length > LIMIT) break;
    out += s;
    if (out.length >= LIMIT) break;
  }
  if (out && out.length <= LIMIT) return out.trim();
  return clean.slice(0, LIMIT - 1).trim() + '…';
}

async function sitelinks(qids) {
  const out = {};
  for (let i = 0; i < qids.length; i += 50) {
    const chunk = qids.slice(i, i + 50);
    const u = new URL('https://www.wikidata.org/w/api.php');
    u.searchParams.set('action', 'wbgetentities');
    u.searchParams.set('format', 'json');
    u.searchParams.set('ids', chunk.join('|'));
    u.searchParams.set('props', 'sitelinks');
    u.searchParams.set('sitefilter', 'jawiki');
    const j = await (await fetch(u, { headers: { 'User-Agent': UA } })).json();
    for (const q of chunk) out[q] = j.entities?.[q]?.sitelinks?.jawiki?.title ?? null;
    await sleep(200);
  }
  return out;
}

async function extract(title) {
  const url = `https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) return null;
  const j = await res.json();
  if (j.type && j.type.includes('disambiguation')) return null;
  const text = (j.extract ?? '').trim();
  if (!text) return null;
  return { text, title: j.titles?.canonical ?? title, url: j.content_urls?.desktop?.page ?? null };
}

// ─────────────────────────────────────────────────────────────────── 本体
const selection = (await loadYaml(resolve(DATA, 'events/selection.yaml'))) ?? [];
const overrideDir = resolve(DATA, 'events/overrides');
const { readdir } = await import('node:fs/promises');
const owned = new Set();
for (const f of (await readdir(overrideDir)).filter((f) => /\.ya?ml$/.test(f))) {
  for (const rec of (await loadYaml(resolve(overrideDir, f))) ?? []) {
    if (rec.summary_ja) owned.add(rec.id);
  }
}
const targets = selection.filter((id) => !owned.has(id));
console.log(`選別 ${selection.length} 件のうち、自前要約が無い ${targets.length} 件を対象にします\n`);

await mkdir(dirname(CACHE), { recursive: true });
const cache = !REFRESH && existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : {};

const links = await sitelinks(targets.filter((q) => !(q in cache)));
let fetched = 0;
const missing = [];
for (const q of targets) {
  if (q in cache) continue;
  const title = links[q];
  if (!title) {
    cache[q] = null;
    missing.push(q);
    continue;
  }
  const got = await extract(title);
  cache[q] = got;
  if (got) fetched++;
  else missing.push(q);
  if (fetched % 25 === 0 && fetched) process.stdout.write(`\r  取得 ${fetched} 件  `);
  await sleep(180);
}
await writeFile(CACHE, JSON.stringify(cache));
console.log(`\n  日本語版から取得: ${Object.values(cache).filter(Boolean).length} 件`);
console.log(`  日本語版が無い（英語版から手で書く対象）: ${targets.filter((q) => !cache[q]).length} 件`);

const records = [];
let over = 0;
for (const q of targets) {
  const c = cache[q];
  if (!c) continue;
  const text = trimJa(c.text);
  if (c.text.length > LIMIT) over++;
  records.push({ id: q, text, lang: 'ja', source_title: c.title, source_url: c.url });
}

const head = `# Wikipedia 日本語版のリード文を、フィードに出す短い要約として取り込んだもの。
# scripts/fetch-wikipedia-summaries.mjs が生成する（手で書き換えない）。
#
# ⚠ CC BY-SA。自前の要約（license: pd）とは混ぜない約束なので、
#   このファイルにだけ置き、出力も public/data/event-summaries.cc-by-sa.json に分ける。
#   画面にも「Wikipedia」の印を出している。
#
# 文の切れ目で ${LIMIT} 字以下に詰めてある（${over} 件は元が長いので途中まで）。
# 英語版しか無いものはここには入らない。event-summaries-from-en.yaml を見ること。

`;
const body = records
  .map(
    (r) =>
      `- id: ${r.id}\n` +
      `  lang: ja\n` +
      `  text: ${JSON.stringify(r.text)}\n` +
      `  license: cc-by-sa\n` +
      `  verified: false\n` +
      `  sources:\n` +
      `    - title: ${JSON.stringify(`${r.source_title}（Wikipedia 日本語版）`)}\n` +
      `      url: ${r.source_url}\n`,
  )
  .join('\n');
await writeFile(OUT, head + body);
console.log(`\n✓ data/seed-wikipedia/event-summaries.yaml に ${records.length} 件`);
