#!/usr/bin/env node
// Wikidata から WWII の戦闘・軍事作戦を取得して data/raw/wikidata-events.json に落とす。
//
// 設計ノート付録 A のクエリが起点。UNION・サブクラス展開を一度に投げると timeout するので
//   ① 骨（P31 直付け・座標＋開始日あり）
//   ② サブクラス展開ぶんを年で分割
//   ③ 参加者 / ④ sitelink / ⑤ 親（P361 直上）/ ⑥ 勝者
// を別クエリで回して QID で突き合わせる。
//
// 出力は CC0。手で編集しない（補正は data/events/overrides/*.yaml で行う）。

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sparql, qid, toDate, toCoord } from './lib/sparql.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/raw/wikidata-events.json');
// ①② の生結果キャッシュ（gitignore 済み）。付加情報の取り直しで毎回 10 分待たないため
const BASE_CACHE = resolve(ROOT, 'data/raw/cache/wikidata-base.json');

// Q178561 battle / Q645883 military operation
const CLASSES = 'VALUES ?cls { wd:Q178561 wd:Q645883 }';
// Q362 第二次世界大戦 / Q170314 日中戦争（P2 で使う。P0 でも拾っておく）
const WARS = 'VALUES ?war { wd:Q362 wd:Q170314 }';

const YEAR_RANGES = [
  ['1937-01-01', '1939-01-01'],
  ['1939-01-01', '1940-01-01'],
  ['1940-01-01', '1941-01-01'],
  ['1941-01-01', '1942-01-01'],
  ['1942-01-01', '1943-01-01'],
  ['1943-01-01', '1944-01-01'],
  ['1944-01-01', '1945-01-01'],
  ['1945-01-01', '1946-01-01'],
];

// 日付は P580（開始日）だけだと真珠湾・広島・ドーリットル空襲が落ちる。
// 単日で終わった事件は P585（時点）しか持たないので両方を受ける。
// 座標も必須にすると、バルバロッサ・ポーランド侵攻・フランス侵攻のような
// 「点を持たない作戦・戦役」が丸ごと落ちる（P0 の芯が落ちる）。
// そこで座標は OPTIONAL にして取り込み、地図に出す点は override 側で与える。
const DATE = '(wdt:P580|wdt:P585)';

// クラス階層のたどり方について（実測メモ）:
//   - `wdt:P31/wdt:P279*` を本体クエリに書くと、座標を OPTIONAL にした時点で必ず timeout する
//   - かといってクラス条件を外して `wdt:P361+` だけにすると 502（枝刈りが効かず重すぎる）
//   → 先にサブクラス集合（実測 296 件）を 1 回引いて、本体では VALUES で直接与える。
//     これで「P31 直付け＋安いジョイン」になり、サブクラス展開ぶんも同じクエリで拾える
const qSubclasses = () => `
SELECT DISTINCT ?cls WHERE {
  VALUES ?root { wd:Q178561 wd:Q645883 }
  ?cls wdt:P279* ?root .
}`;

/** 本体。クラスを小分けにして与える（296 件を一度に渡すと timeout する） */
const qEvents = (classes) => `
SELECT ?item ?en ?ja ?c ?start ?end WHERE {
  VALUES ?cls { ${classes.map((c) => `wd:${c}`).join(' ')} }
  ${WARS}
  ?item wdt:P31 ?cls ; wdt:P361+ ?war ; ${DATE} ?start .
  OPTIONAL { ?item wdt:P625 ?c }
  OPTIONAL { ?item wdt:P582 ?end }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en)="en") }
  OPTIONAL { ?item rdfs:label ?ja FILTER(LANG(?ja)="ja") }
}`;

// ③〜⑥ の付加情報は、クラス階層をもう一度たどらせると必ず timeout する（実測 504）。
// ①② で QID が確定しているので、VALUES で対象を直接与えて小分けに引く。
const CHUNK = 80;

/** ③ 参加者（P710）。国だけでなく部隊も返るので後段で actors.yaml に寄せる */
const qParticipants = (values) => `
SELECT ?item ?p ?pen ?pja WHERE {
  VALUES ?item { ${values} }
  ?item wdt:P710 ?p .
  OPTIONAL { ?p rdfs:label ?pen FILTER(LANG(?pen)="en") }
  OPTIONAL { ?p rdfs:label ?pja FILTER(LANG(?pja)="ja") }
}`;

/** ④ sitelink（ja / en） */
const qSitelinks = (values) => `
SELECT ?item ?ja ?en WHERE {
  VALUES ?item { ${values} }
  OPTIONAL { ?ja schema:about ?item ; schema:isPartOf <https://ja.wikipedia.org/> }
  OPTIONAL { ?en schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
}`;

/** ⑤ 親（P361 直上）。戦域の推定に使う */
const qParents = (values) => `
SELECT ?item ?parent ?pen ?pja WHERE {
  VALUES ?item { ${values} }
  ?item wdt:P361 ?parent .
  OPTIONAL { ?parent rdfs:label ?pen FILTER(LANG(?pen)="en") }
  OPTIONAL { ?parent rdfs:label ?pja FILTER(LANG(?pja)="ja") }
}`;

/** ⑥ 勝者（P1346） */
const qWinners = (values) => `
SELECT ?item ?w ?wen WHERE {
  VALUES ?item { ${values} }
  ?item wdt:P1346 ?w .
  OPTIONAL { ?w rdfs:label ?wen FILTER(LANG(?wen)="en") }
}`;

const v = (b, k) => b[k]?.value ?? null;

async function main() {
  /** @type {Map<string, any>} */
  const events = new Map();

  const ingest = (rows) => {
    for (const b of rows) {
      const id = qid(v(b, 'item'));
      if (!id) continue;
      const start = toDate(v(b, 'start'));
      if (!start) continue;
      const cur = events.get(id) ?? {
        id,
        name_en: null,
        name_ja: null,
        coord: null,
        start: null,
        end: null,
        participants: [],
        parents: [],
        winners: [],
        wikipedia_ja: null,
        wikipedia_en: null,
        source: 'wikidata',
      };
      cur.name_en ??= v(b, 'en');
      cur.name_ja ??= v(b, 'ja');
      cur.coord ??= toCoord(v(b, 'c'));
      // 開始は最も早い日付、終了は最も遅い日付を採る（複数値の item があるため）
      if (!cur.start || start < cur.start) cur.start = start;
      const end = toDate(v(b, 'end'));
      if (end && (!cur.end || end > cur.end)) cur.end = end;
      events.set(id, cur);
    }
  };

  // ①② は重い（実測 10 分前後）。取れているならキャッシュを使う。--refresh で引き直す
  const refresh = process.argv.includes('--refresh');
  const cached = !refresh && existsSync(BASE_CACHE) ? JSON.parse(await readFile(BASE_CACHE, 'utf8')) : null;
  if (cached) {
    for (const e of cached.events) events.set(e.id, e);
    console.log(`①② キャッシュから復元: ${events.size} items（引き直すなら --refresh）`);
  } else {
    console.log('① サブクラス集合');
    const clsRows = await sparql(qSubclasses(), { label: 'subclasses' });
    const classes = clsRows.map((b) => qid(v(b, 'cls'))).filter(Boolean);
    console.log(`   ${classes.length} classes`);

    // クラスをまとめて渡すほど速いが、多すぎると timeout する。
    // 落ちたら半分に割って引き直す（1 件まで割っても落ちるものだけ諦める）
    const fetchClasses = async (chunk, depth = 0) => {
      try {
        ingest(await sparql(qEvents(chunk), { label: `events x${chunk.length}`, retries: 1 }));
        return true;
      } catch (e) {
        if (chunk.length === 1) {
          console.warn(`\n   ✖ ${chunk[0]} は取得できず（スキップ）`);
          return false;
        }
        const mid = Math.ceil(chunk.length / 2);
        await fetchClasses(chunk.slice(0, mid), depth + 1);
        await fetchClasses(chunk.slice(mid), depth + 1);
        return true;
      }
    };

    console.log('② events（クラスを小分けに）');
    const CLS_CHUNK = 16;
    for (let i = 0; i < classes.length; i += CLS_CHUNK) {
      await fetchClasses(classes.slice(i, i + CLS_CHUNK));
      process.stdout.write(`\r   ${Math.min(i + CLS_CHUNK, classes.length)}/${classes.length} classes → ${events.size} items   `);
    }
    console.log('');
    await mkdir(dirname(BASE_CACHE), { recursive: true });
    await writeFile(BASE_CACHE, JSON.stringify({ events: [...events.values()] }) + '\n');
  }

  const allIds = [...events.keys()];
  const chunks = [];
  for (let i = 0; i < allIds.length; i += CHUNK) chunks.push(allIds.slice(i, i + CHUNK));
  const values = (ids) => ids.map((id) => `wd:${id}`).join(' ');

  const enrich = async (name, buildQuery, apply) => {
    process.stdout.write(`${name}`);
    for (let i = 0; i < chunks.length; i++) {
      const rows = await sparql(buildQuery(values(chunks[i])), { label: `${name} ${i + 1}/${chunks.length}` });
      for (const b of rows) {
        const e = events.get(qid(v(b, 'item')));
        if (e) apply(e, b);
      }
      process.stdout.write('.');
    }
    console.log(' ok');
  };

  await enrich('③ participants ', qParticipants, (e, b) => {
    const p = { id: qid(v(b, 'p')), name_en: v(b, 'pen'), name_ja: v(b, 'pja') };
    if (p.id && !e.participants.some((x) => x.id === p.id)) e.participants.push(p);
  });

  await enrich('④ sitelinks    ', qSitelinks, (e, b) => {
    e.wikipedia_ja ??= v(b, 'ja');
    e.wikipedia_en ??= v(b, 'en');
  });

  await enrich('⑤ parents      ', qParents, (e, b) => {
    const p = { id: qid(v(b, 'parent')), name_en: v(b, 'pen'), name_ja: v(b, 'pja') };
    if (p.id && !e.parents.some((x) => x.id === p.id)) e.parents.push(p);
  });

  await enrich('⑥ winners      ', qWinners, (e, b) => {
    const w = { id: qid(v(b, 'w')), name_en: v(b, 'wen') };
    if (w.id && !e.winners.some((x) => x.id === w.id)) e.winners.push(w);
  });

  const list = [...events.values()]
    .filter((e) => e.start >= '1937-01-01' && e.start <= '1945-12-31')
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id.localeCompare(b.id)));

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    JSON.stringify(
      {
        _meta: {
          source: 'Wikidata SPARQL (query.wikidata.org)',
          license: 'cc0',
          fetched_at: new Date().toISOString().slice(0, 10),
          note: '生出力。手で編集しない。補正は data/events/overrides/*.yaml で行う',
          count: list.length,
        },
        events: list,
      },
      null,
      2,
    ) + '\n',
  );

  const withJa = list.filter((e) => e.name_ja).length;
  const withCoord = list.filter((e) => e.coord).length;
  const pct = (n) => `${Math.round((n / list.length) * 100)}%`;
  console.log(`\n→ ${OUT}`);
  console.log(`   ${list.length} events`);
  console.log(`   ja ラベル ${withJa} 件 (${pct(withJa)}) / 座標あり ${withCoord} 件 (${pct(withCoord)})`);
  console.log(`   座標なしは「点を持たない作戦・戦役」。出すなら override で coord を与える`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
