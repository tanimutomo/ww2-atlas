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
//
// ⚠ 取れないもの: 降伏文書・休戦協定。
//   ここは P31 が戦闘（Q178561）／軍事作戦（Q645883）のサブクラスのものだけを取るので、
//   「文書」「出来事」に分類される降伏・休戦は構造的に 1 件も入らない（実測ゼロ）。
//   スキーマの Event.type には surrender があり地図に出したい転換点なので、
//   主要 4 件（仏・伊・独・日）は data/events/overrides/p0.yaml に手で書いている。
//   網を広げるのは P1（条約類が大量に混ざるので選別の仕組みが要る）。

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sparql, qid, toDate, toCoord } from './lib/sparql.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/raw/wikidata-events.json');
// ①② の生結果キャッシュ（gitignore 済み）。付加情報の取り直しで毎回 10 分待たないため
const BASE_CACHE = resolve(ROOT, 'data/raw/cache/wikidata-base.json');

// 取得の起点になるクラス。ここのサブクラスを展開して使う。
//   Q178561 battle          戦闘
//   Q645883 military operation  軍事作戦
//   Q107706 armistice       休戦（P0 で降伏が 1 件も取れなかった原因。ここが無いと落ちる）
//   Q217901 capitulation    降伏
//   Q334516 declaration of war  宣戦布告
//   Q207326 summit          首脳会談
//   Q131569 treaty          条約（WWII に P361 で繋がるものだけが残る）
//
// ⚠ 戦争犯罪（Q135010）は意図的に外している。南京・カティン等は WWII の一部だが、
//   型と要約を機械推定のまま並べるのは扱いとして雑すぎる。個別に書くとき（P2）に入れる。
const ROOTS = ['Q178561', 'Q645883', 'Q207326', 'Q131569'];

// 外交系は「WWII の一部（P361）」として繋がっていないものが多い。
//   コンピエーニュ休戦・カッシビレ休戦 … P361 を持たない
//   ドイツ降伏文書                     … P361 は WWII だが P31 が「歴史的文書」
// P361 を条件にすると全部落ちるので、こちらは **クラスと日付だけ** で取る。
// 1937〜1945 に限れば数が小さい（休戦 5・降伏 3・宣戦布告 26・講和条約 15・歴史的文書 85）ので、
// 無関係なものが混ざっても selection.yaml で落とせる。
const DIPLOMATIC_ROOTS = ['Q107706', 'Q217901', 'Q334516', 'Q625298', 'Q3771738'];
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
const qSubclasses = (roots) => `
SELECT DISTINCT ?cls WHERE {
  VALUES ?root { ${roots.map((q) => `wd:${q}`).join(' ')} }
  ?cls wdt:P279* ?root .
}`;

/** 戦闘系。WWII の一部であることを P361 でたどる。クラスは小分けに渡す（一度に渡すと timeout） */
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

/** 外交系。P361 は使わず、クラスと日付だけで取る */
const qDiplomatic = (classes) => `
SELECT ?item ?en ?ja ?c ?start ?end WHERE {
  VALUES ?cls { ${classes.map((c) => `wd:${c}`).join(' ')} }
  ?item wdt:P31 ?cls ; ${DATE} ?start .
  FILTER(?start >= "1937-01-01T00:00:00Z"^^xsd:dateTime && ?start < "1946-01-01T00:00:00Z"^^xsd:dateTime)
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

/**
 * ⑦ 日付の精度。
 * wdt: で取り出した日付は、Wikidata 側が「年」までしか持っていなくても
 * 1 月 1 日として返ってくる。実測で 520 件中 52 件が 1 月 1 日に固まっており、
 * 南京戦（実際は 12 月）のようなものが年頭に並んでしまっていた。
 * timePrecision（9=年 / 10=月 / 11=日）を別に取って、選別と表示で使う。
 */
const qPrecision = (values) => `
SELECT ?item ?t ?prec WHERE {
  VALUES ?item { ${values} }
  { ?item p:P580/psv:P580 [ wikibase:timeValue ?t ; wikibase:timePrecision ?prec ] }
  UNION
  { ?item p:P585/psv:P585 [ wikibase:timeValue ?t ; wikibase:timePrecision ?prec ] }
}`;

/** ⑧ 終了日も同じ理由で主張単位に取り直す */
const qEndPrecision = (values) => `
SELECT ?item ?t ?prec WHERE {
  VALUES ?item { ${values} }
  ?item p:P582/psv:P582 [ wikibase:timeValue ?t ; wikibase:timePrecision ?prec ] .
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
        /** 9=年 / 10=月 / 11=日。⑦ で埋める */
        start_precision: null,
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
    const clsRows = await sparql(qSubclasses(ROOTS), { label: 'subclasses' });
    const classes = clsRows.map((b) => qid(v(b, 'cls'))).filter(Boolean);
    const dipRows = await sparql(qSubclasses(DIPLOMATIC_ROOTS), { label: 'subclasses (外交)' });
    const dipClasses = dipRows.map((b) => qid(v(b, 'cls'))).filter(Boolean);
    console.log(`   戦闘系 ${classes.length} / 外交系 ${dipClasses.length} classes`);

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

    console.log("②' 外交系（P361 を使わず日付で絞る）");
    const before = events.size;
    for (let i = 0; i < dipClasses.length; i += CLS_CHUNK) {
      const chunk = dipClasses.slice(i, i + CLS_CHUNK);
      try {
        ingest(await sparql(qDiplomatic(chunk), { label: `dip x${chunk.length}`, retries: 2 }));
      } catch {
        for (const one of chunk) {
          try {
            ingest(await sparql(qDiplomatic([one]), { label: `dip ${one}`, retries: 1 }));
          } catch {
            console.warn(`\n   ✖ ${one} は取得できず（スキップ）`);
          }
        }
      }
      process.stdout.write(`\r   ${Math.min(i + CLS_CHUNK, dipClasses.length)}/${dipClasses.length} classes → +${events.size - before}   `);
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

  // ⑦ 日付と精度は必ず「同じ主張（statement）」から採る。
  // ①② の ingest は複数ある日付のうち最も早いものを採っていたため、
  // 「年どまりで 1/1 に丸まった日付」と「別の主張の日精度」が混ざり、
  // 南京戦が 1937-01-01・精度 11 という嘘の組み合わせになっていた。
  await enrich('⑦ date precision', qPrecision, (e, b) => {
    const prec = Number(v(b, 'prec'));
    const date = toDate(v(b, 't'));
    if (!Number.isFinite(prec) || !date) return;
    const cur = e._best;
    // 精度が高いものを優先し、同じ精度なら早いものを採る
    if (!cur || prec > cur.prec || (prec === cur.prec && date < cur.date)) {
      e._best = { prec, date };
    }
  });

  await enrich('⑧ end precision ', qEndPrecision, (e, b) => {
    const prec = Number(v(b, 'prec'));
    const date = toDate(v(b, 't'));
    if (!Number.isFinite(prec) || !date) return;
    const cur = e._bestEnd;
    // 終了日は精度が高いものを優先し、同じ精度なら遅いものを採る
    if (!cur || prec > cur.prec || (prec === cur.prec && date > cur.date)) {
      e._bestEnd = { prec, date };
    }
  });

  // 採った主張で start / end を上書きする
  for (const e of events.values()) {
    if (e._best) {
      e.start = e._best.date;
      e.start_precision = e._best.prec;
      delete e._best;
    }
    if (e._bestEnd) {
      e.end = e._bestEnd.date;
      e.end_precision = e._bestEnd.prec;
      delete e._bestEnd;
    }
    // 主張を取り直した結果、前後が逆になったものは終了日を落とす
    if (e.end && e.start && e.end < e.start) {
      e.end = null;
      e.end_precision = null;
    }
  }

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
  const byDay = list.filter((e) => (e.start_precision ?? 11) >= 11).length;
  const pct = (n) => `${Math.round((n / list.length) * 100)}%`;
  console.log(`\n→ ${OUT}`);
  console.log(`   ${list.length} events`);
  console.log(`   ja ラベル ${withJa} 件 (${pct(withJa)}) / 座標あり ${withCoord} 件 (${pct(withCoord)})`);
  console.log(`   日付が「日」まである ${byDay} 件 (${pct(byDay)})。年・月どまりのものは 1/1 に丸まる`);
  console.log(`   座標なしは「点を持たない作戦・戦役」。出すなら override で coord を与える`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
