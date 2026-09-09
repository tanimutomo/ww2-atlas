// Wikidata 由来の値から type / theatre / significance を機械推定する。
// 推定はあくまで既定値で、data/events/overrides/*.yaml の手当てが常に勝つ。
// 推定した項目は inferred[] に残して、フロントで「未確認」と分かるようにする。

/** 戦域: 親（P361 直上）のラベルで決める → 座標の箱でフォールバック */
const PARENT_THEATRE = [
  [/eastern front|great patriotic|独ソ|東部戦線/i, 'europe_east'],
  [/western front|western europe|西部戦線|normandy|北西ヨーロッパ/i, 'europe_west'],
  [/pacific (war|theatre|theater|ocean)|太平洋/i, 'pacific'],
  [/south[- ]east asia|burma|malaya|東南アジア|ビルマ/i, 'pacific'],
  [/mediterranean|italian campaign|balkan|地中海|イタリア戦線|バルカン/i, 'mediterranean'],
  [/north african|africa|africain|アフリカ/i, 'africa'],
  [/atlantic|大西洋/i, 'atlantic'],
  [/sino-japanese|china|日中戦争|支那/i, 'china'],
];

/** [lonMin, lonMax, latMin, latMax] → theatre。上から順に当てる */
const THEATRE_BOXES = [
  ['china', 97, 126, 18, 43],
  ['europe_east', 16, 62, 43, 72],
  ['europe_west', -12, 16, 41, 62],
  ['mediterranean', -7, 43, 29, 43],
  ['africa', -20, 52, -36, 29],
  ['atlantic', -82, -11, -10, 72],
  ['pacific', 100, 180, -50, 60],
  ['pacific', -180, -100, -50, 60],
];

export function inferTheatre(ev) {
  for (const p of ev.parents ?? []) {
    const label = `${p.name_en ?? ''} ${p.name_ja ?? ''}`;
    for (const [re, theatre] of PARENT_THEATRE) if (re.test(label)) return theatre;
  }
  const [lon, lat] = ev.coord ?? [];
  if (typeof lon === 'number') {
    for (const [theatre, x0, x1, y0, y1] of THEATRE_BOXES) {
      if (lon >= x0 && lon <= x1 && lat >= y0 && lat <= y1) return theatre;
    }
  }
  return 'europe_west';
}

/** 種別: 名前のキーワードで決める */
const TYPE_RULES = [
  [/海戦|沖海戦|naval battle|battle of the .*sea|convoy|海上護衛/i, 'naval'],
  [/空襲|爆撃|bombing of|air raid|bombardment|strategic bombing|原子爆弾|atomic bomb/i, 'air_raid'],
  [/包囲|攻囲|siege of|blockade of/i, 'siege'],
  [/上陸|landing|landings|amphibious/i, 'landing'],
  [/侵攻|進攻|invasion of|invasion|occupation of|進駐/i, 'invasion'],
  [/降伏|surrender|capitulation/i, 'surrender'],
  [/蜂起|反乱|uprising|revolt|insurrection/i, 'uprising'],
];

export function inferType(ev) {
  const label = `${ev.name_ja ?? ''} ${ev.name_en ?? ''}`;
  for (const [re, type] of TYPE_RULES) if (re.test(label)) return type;
  return 'battle';
}

/**
 * 重要度の既定値。3（＝地図で最も大きく出す）は手で override するときだけ。
 * 日本語版 Wikipedia に記事があるものは 2、それ以外は 1。
 */
export function inferSignificance(ev) {
  return ev.wikipedia_ja ? 2 : 1;
}

/** 参加者（P710・部隊まで含む生データ）を actors.yaml の id に寄せる */
const ACTOR_RULES = [
  [/^(empire of )?japan|大日本帝国|日本軍|日本$/i, 'jp'],
  [/nazi germany|german reich|wehrmacht|^germany|ドイツ国|ナチス・?ドイツ|ドイツ軍|ドイツ$/i, 'de'],
  [/kingdom of italy|^italy|イタリア王国|イタリア$/i, 'it'],
  [/united states|^u\.?s\.?a?$|アメリカ合衆国|アメリカ$|米軍/i, 'us'],
  [/united kingdom|great britain|^britain|british|イギリス|英国/i, 'uk'],
  [/soviet union|^ussr$|ソビエト連邦|ソ連|赤軍/i, 'su'],
  [/free france|french (third )?republic|^france$|フランス共和国|自由フランス|フランス$/i, 'fr'],
  [/republic of china|nationalist china|^china$|中華民国|国民政府|中国$/i, 'cn'],
  [/^poland|polish|ポーランド/i, 'pl'],
  [/netherlands|dutch|オランダ/i, 'nl'],
  [/^belgium|ベルギー/i, 'be'],
  [/^norway|ノルウェー/i, 'no'],
  [/^greece|kingdom of greece|ギリシャ/i, 'gr'],
  [/yugoslavia|ユーゴスラビア/i, 'yu'],
  [/^australia|オーストラリア/i, 'au'],
  [/^canada|カナダ/i, 'ca'],
  [/^finland|フィンランド/i, 'fi'],
  [/^(kingdom of )?romania|ルーマニア/i, 'ro'],
  [/^(kingdom of )?hungary|ハンガリー/i, 'hu'],
  [/^thailand|siam|タイ王国|タイ$/i, 'th'],
  [/vichy|french state|ヴィシー/i, 'vichy'],
];

export function inferActors(ev) {
  const out = new Set();
  for (const p of ev.participants ?? []) {
    const label = `${p.name_en ?? ''}`.trim();
    const labelJa = `${p.name_ja ?? ''}`.trim();
    for (const [re, id] of ACTOR_RULES) {
      if ((label && re.test(label)) || (labelJa && re.test(labelJa))) {
        out.add(id);
        break;
      }
    }
  }
  return [...out];
}

/** 勝者（P1346）から結果を推定する。actors.yaml の faction を引く */
export function inferOutcome(ev, factionOf) {
  const factions = new Set();
  for (const w of ev.winners ?? []) {
    const label = `${w.name_en ?? ''}`;
    for (const [re, id] of ACTOR_RULES) {
      if (re.test(label)) {
        const f = factionOf(id);
        if (f) factions.add(f);
        break;
      }
    }
  }
  if (factions.size !== 1) return null;
  const [f] = [...factions];
  if (f === 'axis') return 'axis_victory';
  if (f === 'allied') return 'allied_victory';
  return null;
}
