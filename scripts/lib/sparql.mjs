// Wikidata SPARQL の薄いクライアント。
// User-Agent 必須（付けないと 403）。timeout・429 はバックオフして再試行する。

const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA =
  'ww2-atlas/0.1 (https://github.com/tanimutomo/ww2-atlas; t.tanimura@ispec.tech) node-fetch';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * SPARQL を投げて bindings 配列を返す。
 * @param {string} query
 * @param {{label?: string, retries?: number}} opts
 */
export async function sparql(query, opts = {}) {
  const { label = 'query', retries = 4 } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = 3000 * 2 ** (attempt - 1);
      console.warn(`  retry ${attempt}/${retries} after ${wait}ms (${label})`);
      await sleep(wait);
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Accept: 'application/sparql-results+json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ query }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
      }
      const json = await res.json();
      return json.results.bindings;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`sparql failed (${label}): ${lastErr?.message ?? lastErr}`);
}

/** エンティティ URI から QID を取り出す */
export const qid = (uri) => (uri ? uri.replace(/^.*\/entity\//, '') : null);

/** SPARQL の日付リテラルを YYYY-MM-DD に落とす（紀元前・精度不足は null） */
export function toDate(lit) {
  if (!lit) return null;
  const m = /^(-?\d{4})-(\d{2})-(\d{2})/.exec(lit);
  if (!m || m[1].startsWith('-')) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Point(lon lat) → [lon, lat] */
export function toCoord(wkt) {
  if (!wkt) return null;
  const m = /Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(wkt);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}
