// public/data/ の読み込みと、画面から引くための索引づくり。
// ビルド済みの静的 JSON を 1 回読むだけ。サーバ・DB は無い。

export type Control =
  | 'axis'
  | 'axis_occupied'
  | 'allied'
  | 'allied_occupied'
  | 'neutral'
  | 'su';

export type Source = { title: string; url: string; note?: string };

export type EventRec = {
  id: string;
  name_ja: string;
  name_en: string | null;
  type: string;
  theatre: string;
  start: string;
  end: string | null;
  coord: [number, number] | null;
  actors: string[];
  outcome: string | null;
  summary_ja: string | null;
  significance: 1 | 2 | 3;
  wikipedia_ja: string | null;
  wikipedia_en: string | null;
  license: string;
  verified: boolean;
  sources: Source[];
  inferred: string[];
};

export type Decision = {
  id: string;
  type: string;
  name_ja: string;
  /** どこで決めたか。司令部も地図に出すので持つ */
  coord?: [number, number] | null;
  name_en?: string | null;
  date: string;
  end?: string | null;
  actors?: string[];
  persons?: string[];
  place?: string | null;
  summary_ja?: string;
  decisions_ja?: string[];
  license: string;
  verified: boolean;
  sources: Source[];
};

export type HomeFront = {
  id: string;
  type: string;
  country: string;
  /** どこから出た発表・報道か */
  coord?: [number, number] | null;
  date: string;
  headline_ja: string;
  body_ja?: string;
  license: string;
  verified: boolean;
  sources: Source[];
};

export type Discrepancy = {
  claimed_ja: string;
  actual_ja: string;
  kind: string;
};

export type Link = {
  from: string;
  to: string;
  relation: 'authorizes' | 'triggers' | 'responds_to' | 'decided_at' | 'reports';
  note_ja?: string;
  discrepancy?: Discrepancy;
};

export type FrontLine = {
  id: string;
  date: string;
  theatre: string | null;
  name_ja: string;
  note_ja: string | null;
  coords: [number, number][];
  verified: boolean;
  sources: Source[];
};

export type Actor = {
  id: string;
  name_ja: string;
  name_en: string;
  faction: string;
  color: string;
};

export type Atlas = {
  events: EventRec[];
  decisions: Decision[];
  homefront: HomeFront[];
  links: Link[];
  actors: Actor[];
  frontlines: FrontLine[];
  keyframes: string[];
  /**
   * 軍事的な支配を月次で持つレイヤ（Commons の月次図から機械変換）。
   * 政体境界では描けない占領地域を埋めるためのもので、
   * ヨーロッパの 1939-08〜1942-12 しか無い。
   */
  controlMonths: string[];
  /**
   * 概略の支配領域の日付（前線と範囲から導出したもの）。
   * Commons の面が無い期間・地域 ― 1943 年以降のヨーロッパと中国全期間 ― を埋める。
   * 精度は元の折れ線と同じなので、UI では薄く塗って区別している。
   */
  approxDates: string[];
  /**
   * Event の短い要約（Wikipedia のリード文にもとづく・CC BY-SA）。
   * 自前の要約（summary_ja）がある Event はここに入らない。
   * ライセンスが違うので本体と混ぜず、別に持って画面でも印を出す。
   */
  wikiSummaries: Map<string, string>;
  /** id → レコード（Event / Decision / HomeFront をまとめて引く） */
  byId: Map<string, EventRec | Decision | HomeFront>;
  /** id → その id が from か to になっているリンク */
  linksOf: Map<string, Link[]>;
  actorById: Map<string, Actor>;
};

const BASE = import.meta.env.BASE_URL ?? '/';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}data/${path}`);
  if (!res.ok) throw new Error(`${path} の読み込みに失敗しました (${res.status})`);
  return res.json();
}

export async function loadAtlas(): Promise<Atlas> {
  const [ev, dec, hf, ln, ac, tf, fl] = await Promise.all([
    getJson<{ events: EventRec[] }>('events.json'),
    getJson<{ decisions: Decision[] }>('decisions.json'),
    getJson<{ homefront: HomeFront[] }>('homefront.json'),
    getJson<{ links: Link[] }>('links.json'),
    getJson<{ actors: Actor[] }>('actors.json'),
    getJson<{ keyframes: string[] }>('territory/index.json'),
    getJson<{ frontlines: FrontLine[] }>('frontlines.json'),
  ]);

  // 支配レイヤはまだ無いこともある（npm run fetch:control 未実行）ので、落とさない
  const [control, approx] = await Promise.all([
    getJson<{ months: { month: string }[] }>('territory/control/index.json').catch(() => ({ months: [] })),
    getJson<{ dates: { date: string }[] }>('territory/approx/index.json').catch(() => ({ dates: [] })),
  ]);
  const wiki = await getJson<{ summaries: { id: string; text: string }[] }>(
    'event-summaries.cc-by-sa.json',
  ).catch(() => ({ summaries: [] }));

  const byId = new Map<string, EventRec | Decision | HomeFront>();
  for (const r of ev.events) byId.set(r.id, r);
  for (const r of dec.decisions) byId.set(r.id, r);
  for (const r of hf.homefront) byId.set(r.id, r);

  const linksOf = new Map<string, Link[]>();
  const push = (k: string, l: Link) => {
    const arr = linksOf.get(k);
    if (arr) arr.push(l);
    else linksOf.set(k, [l]);
  };
  for (const l of ln.links) {
    push(l.from, l);
    push(l.to, l);
  }

  return {
    events: ev.events,
    decisions: dec.decisions,
    homefront: hf.homefront,
    links: ln.links,
    actors: ac.actors,
    frontlines: fl.frontlines,
    keyframes: tf.keyframes,
    controlMonths: control.months.map((m) => m.month),
    approxDates: approx.dates.map((d) => d.date),
    wikiSummaries: new Map(wiki.summaries.map((s) => [s.id, s.text])),
    byId,
    linksOf,
    actorById: new Map(ac.actors.map((a) => [a.id, a])),
  };
}

/** 支配区分ごとの色。占領地は本国よりくすませて、斜線パターンと併せて区別する */
export const CONTROL_COLOR: Record<Control, string> = {
  axis: '#8c2f2f',
  axis_occupied: '#b06a5c',
  allied: '#2f5d8c',
  allied_occupied: '#6a8ab0',
  su: '#7a4a2f',
  neutral: '#6b6558',
};

/**
 * 概略の面に使う色。
 *
 * 概略の面は OHM の政体境界の**上に**重なる。素直に半透明で塗ると
 * 下のソ連の青と混ざって紫になり、「占領地」ではなく別の区分に見えてしまう。
 * そこで「陸の色の上に occupied を 0.55 で塗ったとき」の色をあらかじめ計算し、
 * 不透明で塗る。ほかの占領地とまったく同じ見え方になり、下の層も隠れる。
 * ここが概略であることは、上に重なる前線の破線と凡例の注記で示している。
 */
const LAND_MIX = '#2b3238'; // map.ts の LAND と揃える
const mix = (fg: string, bg: string, a: number): string => {
  const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [r1, g1, b1] = hex(fg);
  const [r2, g2, b2] = hex(bg);
  const to = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${to(r1 * a + r2 * (1 - a))}${to(g1 * a + g2 * (1 - a))}${to(b1 * a + b2 * (1 - a))}`;
};
export const APPROX_COLOR: Record<Control, string> = Object.fromEntries(
  (Object.keys(CONTROL_COLOR) as Control[]).map((k) => [
    k,
    mix(CONTROL_COLOR[k], LAND_MIX, k.endsWith('_occupied') ? 0.55 : 0.8),
  ]),
) as Record<Control, string>;

export const CONTROL_LABEL: Record<Control, string> = {
  axis: '枢軸国',
  axis_occupied: '枢軸の占領・傀儡',
  allied: '連合国',
  allied_occupied: '連合国の占領',
  su: 'ソ連（独ソ戦まで）',
  neutral: '中立・その他',
};

export const THEATRE_LABEL: Record<string, string> = {
  europe_west: '西部（西欧）',
  europe_east: '東部（独ソ）',
  mediterranean: '地中海・イタリア',
  africa: '北アフリカ',
  atlantic: '大西洋',
  pacific: '太平洋',
  china: '中国',
};

/**
 * 地図に出す点の分類。
 *
 * 設計ノートでは司令部・国内は地図に置かない方針だったが、
 * 「会議も発表も、どこで起きたかが分かった方がいい」という判断で全部出すことにした。
 * 戦闘は陸・海・空の 3 つに留め（種別 8 つを色にすると読めないうえ、
 * 種別の 8 割は名前からの機械推定なので細かく言い切る根拠が弱い）、
 * 意思決定（会議・指令・宣言・降伏）と国内（発表・報道・生活）を別の色にする。
 */
export type PointCategory = 'land' | 'sea' | 'air' | 'decision' | 'home';

const DOMAIN_OF: Record<string, PointCategory> = {
  battle: 'land',
  invasion: 'land',
  siege: 'land',
  landing: 'land',
  uprising: 'land',
  naval: 'sea',
  air_raid: 'air',
  // 降伏・休戦は戦闘ではなく「大きな意思決定」として会議・指令と同じ色にする
  surrender: 'decision',
};

export const CATEGORY_COLOR: Record<PointCategory, string> = {
  land: '#e8c26a',
  sea: '#6ac8e8',
  air: '#b58ae8',
  decision: '#7fe0a0',
  home: '#f0919f',
};

export const CATEGORY_LABEL: Record<PointCategory, string> = {
  land: '陸戦',
  sea: '海戦',
  air: '空襲',
  decision: '会議・指令・降伏',
  home: '発表・報道・生活',
};

/** 凡例の並び。現場 3 つ／意思決定／国内 の順 */
export const CATEGORY_ORDER: PointCategory[] = ['land', 'sea', 'air', 'decision', 'home'];

export const categoryOfEvent = (type: string): PointCategory => DOMAIN_OF[type] ?? 'land';

export const TYPE_LABEL: Record<string, string> = {
  battle: '戦闘',
  invasion: '侵攻',
  naval: '海戦',
  air_raid: '空襲',
  siege: '包囲',
  surrender: '降伏',
  uprising: '蜂起',
  landing: '上陸',
};

export const RELATION_LABEL: Record<Link['relation'], string> = {
  authorizes: 'この決定が動かした作戦',
  triggers: 'これが引き金になった',
  responds_to: 'これへの対応',
  decided_at: 'ここで決まった',
  reports: '当時の発表',
};

export const DISCREPANCY_LABEL: Record<string, string> = {
  own_losses_understated: '自軍の損害を小さく伝えた',
  enemy_losses_overstated: '敵の損害を大きく伝えた',
  omitted: '都合の悪い事実を伝えなかった',
  euphemism: '言い換えた',
  accurate: 'ほぼ実態どおり',
};

/**
 * その日に出す支配レイヤの月を選ぶ。
 *
 * 原図は「その月末時点」を描いたもの（凡例が "Ende Nov. 1942"）なので、
 * 月末がいちばん近い枚を出す。前月末に固定すると、フランス降伏のように
 * 月の途中で大きく塗りが変わる回で 1 か月遅れて見えてしまう。
 * 収録範囲の外（1943 年以降・1939-08 より前）では null を返して、
 * OHM の政体境界だけを出す。
 */
/** 概略の面は「その日以下で最新」を出す。前線と同じステップ表示 */
export function approxDateFor(dates: string[], date: string): string | null {
  let hit: string | null = null;
  for (const d of dates) if (d <= date) hit = d;
  return hit;
}

export function controlMonthFor(months: string[], date: string): string | null {
  if (!months.length) return null;
  const d = toDayNumber(date);
  const endOf = (m: string) => {
    const [y, mm] = m.split('-').map(Number);
    return toDayNumber(new Date(Date.UTC(mm === 12 ? y + 1 : y, mm === 12 ? 0 : mm, 0)).toISOString().slice(0, 10));
  };
  let best: string | null = null;
  let bd = Infinity;
  for (const m of months) {
    const gap = Math.abs(endOf(m) - d);
    if (gap < bd) { bd = gap; best = m; }
  }
  // 端の外まで引き伸ばさない（収録は 1939-08〜1942-12 のヨーロッパだけ）
  return bd <= 31 ? best : null;
}

/** YYYY-MM-DD → 数値（比較・スライダー用の通し日数） */
export const toDayNumber = (iso: string): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
export const fromDayNumber = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);

export const formatJa = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
};

/** その日付に有効な領域キーフレーム（補間しない。以下で最も新しいもの） */
export function keyframeFor(keyframes: string[], date: string): string | null {
  let hit: string | null = null;
  for (const k of keyframes) if (k <= date) hit = k;
  return hit ?? keyframes[0] ?? null;
}

/** その日付に「進行中」のイベントか */
export function isActive(e: EventRec, date: string): boolean {
  const end = e.end ?? e.start;
  return e.start <= date && date <= end;
}

/**
 * 地図に出すか。進行中のものに加えて、前後 windowDays 日以内に始まった／終わったものも出す。
 * 単日で終わる事件（空襲・奇襲）が多く、厳密に「その日」だけにすると地図がほぼ空になるため。
 */
export function isNear(e: EventRec, date: string, windowDays: number): boolean {
  if (isActive(e, date)) return true;
  const d = toDayNumber(date);
  const s = toDayNumber(e.start);
  const t = toDayNumber(e.end ?? e.start);
  return Math.abs(s - d) <= windowDays || Math.abs(t - d) <= windowDays;
}


/** 地図に置く 1 点。現場・司令部・国内をここで同じ形に均す */
export type MapPoint = {
  id: string;
  coord: [number, number];
  name: string;
  category: PointCategory;
  significance: number;
  start: string;
  end: string | null;
  /** 戦域フィルタの対象になるのは現場だけ */
  theatre: string | null;
};

/**
 * 3 層をまとめて地図の点にする。
 *
 * 同じ座標に何件も重なるもの（東京の大本営発表 20 件、ワシントンの会談など）は
 * そのままだと 1 点にしか見えず、クリックでも 1 件しか掴めない。
 * 重なったぶんだけ小さな環状にずらして置く。位置をずらすのは表示上の都合なので、
 * データ側（YAML）には手を入れない。
 */
export function mapPoints(atlas: Atlas): MapPoint[] {
  const pts: MapPoint[] = [];

  for (const e of atlas.events) {
    if (!e.coord) continue;
    pts.push({
      id: e.id,
      coord: e.coord,
      name: e.name_ja,
      category: categoryOfEvent(e.type),
      significance: e.significance,
      start: e.start,
      end: e.end,
      theatre: e.theatre,
    });
  }

  for (const d of atlas.decisions) {
    const coord = (d as { coord?: [number, number] }).coord;
    if (!coord) continue;
    pts.push({
      id: d.id,
      coord,
      name: d.name_ja,
      category: 'decision',
      significance: 2,
      start: d.date,
      end: d.end ?? null,
      theatre: null,
    });
  }

  for (const h of atlas.homefront) {
    const coord = (h as { coord?: [number, number] }).coord;
    if (!coord) continue;
    pts.push({
      id: h.id,
      coord,
      name: h.headline_ja,
      category: 'home',
      significance: 1,
      start: h.date,
      end: null,
      theatre: null,
    });
  }

  // 同じ場所に重なるものを環状にずらす
  const groups = new Map<string, MapPoint[]>();
  for (const p of pts) {
    const key = `${p.coord[0].toFixed(3)},${p.coord[1].toFixed(3)}`;
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  // 同心円に並べると外周がどんどん遠くなる（東京は 39 件重なるので最外周が 280km 先になった）。
  // ひまわりの種の並び（黄金角）にすると中心から詰まって広がり、上限も掛けやすい。
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const MAX_SPREAD_DEG = 1.2; // 東京で 130km 前後。これ以上ずらすと別の場所に見えてしまう
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const radius = Math.min(MAX_SPREAD_DEG, 0.35 * Math.sqrt(g.length));
    g.forEach((p, i) => {
      const r = radius * Math.sqrt((i + 0.5) / g.length);
      const angle = i * GOLDEN;
      // 緯度が高いほど経度 1 度は短いので、見た目の間隔を揃えるために割る
      const lonScale = Math.max(0.25, Math.cos((p.coord[1] * Math.PI) / 180));
      p.coord = [p.coord[0] + (Math.cos(angle) * r) / lonScale, p.coord[1] + Math.sin(angle) * r];
    });
  }

  return pts;
}
