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
  keyframes: string[];
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
  const [ev, dec, hf, ln, ac, tf] = await Promise.all([
    getJson<{ events: EventRec[] }>('events.json'),
    getJson<{ decisions: Decision[] }>('decisions.json'),
    getJson<{ homefront: HomeFront[] }>('homefront.json'),
    getJson<{ links: Link[] }>('links.json'),
    getJson<{ actors: Actor[] }>('actors.json'),
    getJson<{ keyframes: string[] }>('territory/index.json'),
  ]);

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
    keyframes: tf.keyframes,
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

export const CONTROL_LABEL: Record<Control, string> = {
  axis: '枢軸国',
  axis_occupied: '枢軸の占領・傀儡',
  allied: '連合国',
  allied_occupied: '連合国の占領',
  su: 'ソ連',
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

/** 地図の点の色。種別ごとに変える（大きさは重要度と新しさで決まる） */
export const TYPE_COLOR: Record<string, string> = {
  battle: '#e8c26a',
  invasion: '#e8875a',
  naval: '#6ac8e8',
  air_raid: '#d98ae8',
  siege: '#e8a06a',
  surrender: '#9ae86a',
  uprising: '#e86a8a',
  landing: '#6ae8b0',
};

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
