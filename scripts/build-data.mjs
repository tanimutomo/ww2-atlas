#!/usr/bin/env node
// data/**/*.yaml（正本）と data/raw/wikidata-events.json（CC0 生データ）を結合・検証して
// public/data/*.json を出す。生成物はコミットしない。
//
//   node scripts/build-data.mjs           # 生成する
//   node scripts/build-data.mjs --check   # 検証だけ（書き出さない）
//   node scripts/build-data.mjs --strict  # 警告も失敗として扱う
//
// 落とす条件（設計の約束）:
//   - license / sources が無いレコード
//   - 未知の license・type・theatre・actor
//   - Link の from / to が存在しない
//   - data/seed-wikipedia/ 配下が cc-by-sa 以外

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { loadYaml } from './lib/yamlio.mjs';
import { inferTheatre, inferType, inferSignificance, inferActors, inferOutcome } from './lib/infer.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const OUT = resolve(ROOT, 'public/data');

const CHECK_ONLY = process.argv.includes('--check');
const STRICT = process.argv.includes('--strict');

const LICENSES = ['pd', 'cc0', 'cc-by-sa', 'noncommercial', 'link-only'];
const EVENT_TYPES = ['battle', 'invasion', 'naval', 'air_raid', 'siege', 'surrender', 'uprising', 'landing'];
const THEATRES = ['europe_west', 'europe_east', 'mediterranean', 'pacific', 'china', 'atlantic', 'africa'];
const OUTCOMES = ['axis_victory', 'allied_victory', 'inconclusive'];
const DECISION_TYPES = ['conference', 'directive', 'order', 'diplomatic_note', 'declaration', 'treaty', 'imperial_conference'];
const HOMEFRONT_TYPES = ['announcement', 'press', 'newsreel', 'life', 'opinion', 'policy'];
const RELATIONS = ['authorizes', 'triggers', 'responds_to', 'decided_at', 'reports'];
const DISCREPANCY_KINDS = ['own_losses_understated', 'enemy_losses_overstated', 'omitted', 'euphemism', 'accurate'];
const CONTROLS = ['axis', 'axis_occupied', 'allied', 'allied_occupied', 'neutral', 'su'];

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const readYaml = loadYaml;

/** ディレクトリ内の *.yaml を全部読んで [{file, records}] にする */
async function readYamlDir(dir) {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const records = (await readYaml(resolve(dir, f))) ?? [];
    if (!Array.isArray(records)) {
      err(`${dir}/${f}: トップレベルが配列でない`);
      continue;
    }
    out.push({ file: f, dir, records });
  }
  return out;
}

/**
 * 座標の検証。司令部・国内も地図に出すので coord を持たせる
 * （決定なら「どこで決めたか」、発表・報道なら「どこから出たか」）。
 */
function checkCoord(rec, where) {
  const c = rec.coord;
  if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number') {
    warn(`${where} (${rec.id}): coord が無い（地図に出ない）`);
    return;
  }
  if (c[0] < -180 || c[0] > 180 || c[1] < -90 || c[1] > 90) {
    err(`${where} (${rec.id}): coord は [経度, 緯度] の順。範囲外の値`);
  }
}

/** license / sources / verified の共通検証 */
function checkCommon(rec, where) {
  if (!rec.id) err(`${where}: id が無い`);
  if (!rec.license) err(`${where} (${rec.id}): license が無い`);
  else if (!LICENSES.includes(rec.license)) err(`${where} (${rec.id}): 未知の license "${rec.license}"`);
  if (!Array.isArray(rec.sources) || rec.sources.length === 0) {
    err(`${where} (${rec.id}): sources が無い`);
  } else {
    for (const s of rec.sources) {
      if (!s?.title || !s?.url) err(`${where} (${rec.id}): sources に title/url が欠けた要素`);
    }
  }
  if (typeof rec.verified !== 'boolean') err(`${where} (${rec.id}): verified が bool でない`);
}

async function main() {
  // ---------------------------------------------------------------- actors
  const actors = await readYaml(resolve(DATA, 'actors.yaml'));
  const actorIds = new Set(actors.map((a) => a.id));
  const factionOf = (id) => actors.find((a) => a.id === id)?.faction ?? null;

  // ---------------------------------------------------------------- events
  const rawPath = resolve(DATA, 'raw/wikidata-events.json');
  let raw = { events: [] };
  if (existsSync(rawPath)) raw = JSON.parse(await readFile(rawPath, 'utf8'));
  else warn('data/raw/wikidata-events.json が無い（npm run fetch:wikidata）');
  const rawById = new Map(raw.events.map((e) => [e.id, e]));

  const selectionPath = resolve(DATA, 'events/selection.yaml');
  const selection = existsSync(selectionPath) ? ((await readYaml(selectionPath)) ?? []) : [];
  if (!selection.length) warn('data/events/selection.yaml が空（イベントが 1 件も出ない）');

  const overrideFiles = await readYamlDir(resolve(DATA, 'events/overrides'));
  const overrides = new Map();
  for (const { file, records } of overrideFiles) {
    for (const rec of records) {
      if (!rec.id) {
        err(`events/overrides/${file}: id の無いレコード`);
        continue;
      }
      if (overrides.has(rec.id)) err(`events/overrides/${file}: ${rec.id} が重複`);
      overrides.set(rec.id, rec);
    }
  }
  for (const id of overrides.keys()) {
    if (!selection.includes(id)) warn(`overrides に ${id} があるが selection.yaml に無い（出力されない）`);
  }

  const events = [];
  for (const id of selection) {
    const base = rawById.get(id);
    const ov = overrides.get(id) ?? {};
    if (!base && !ov.coord) {
      err(`selection.yaml: ${id} が raw に無く、override にも coord が無い`);
      continue;
    }
    const b = base ?? {};
    const inferred = [];
    const pick = (key, fallback) => {
      if (ov[key] !== undefined && ov[key] !== null) return ov[key];
      inferred.push(key);
      return fallback;
    };

    const ev = {
      id,
      name_ja: ov.name_ja ?? b.name_ja ?? ov.name_en ?? b.name_en ?? id,
      name_en: ov.name_en ?? b.name_en ?? null,
      type: pick('type', inferType(b)),
      theatre: pick('theatre', inferTheatre(b)),
      start: ov.start ?? b.start ?? null,
      end: ov.end ?? b.end ?? null,
      coord: ov.coord ?? b.coord ?? null,
      actors: pick('actors', inferActors(b)),
      outcome: ov.outcome ?? inferOutcome(b, factionOf),
      summary_ja: ov.summary_ja ?? null,
      significance: pick('significance', inferSignificance(b)),
      wikipedia_ja: ov.wikipedia_ja ?? b.wikipedia_ja ?? null,
      wikipedia_en: ov.wikipedia_en ?? b.wikipedia_en ?? null,
      license: ov.license ?? 'cc0',
      verified: ov.verified ?? false,
      // 名前・座標・日付は Wikidata（CC0）由来なので、出典は機械的に付ける
      sources: ov.sources ?? [
        { title: `Wikidata ${id}`, url: `https://www.wikidata.org/wiki/${id}`, note: 'CC0' },
      ],
      // 推定値であることをフロントに残す（未確認の印を出すため）
      inferred: inferred.filter((k) => ov[k] === undefined || ov[k] === null),
    };

    const where = 'events';
    checkCommon(ev, where);
    if (!ev.start) err(`${where} (${id}): start が無い`);
    if (!ev.coord) err(`${where} (${id}): coord が無い`);
    if (!EVENT_TYPES.includes(ev.type)) err(`${where} (${id}): 未知の type "${ev.type}"`);
    if (!THEATRES.includes(ev.theatre)) err(`${where} (${id}): 未知の theatre "${ev.theatre}"`);
    if (ev.outcome && !OUTCOMES.includes(ev.outcome)) err(`${where} (${id}): 未知の outcome "${ev.outcome}"`);
    if (![1, 2, 3].includes(ev.significance)) err(`${where} (${id}): significance は 1〜3`);
    for (const a of ev.actors) if (!actorIds.has(a)) err(`${where} (${id}): 未知の actor "${a}"`);
    if (ev.end && ev.start && ev.end < ev.start) err(`${where} (${id}): end < start`);

    events.push(ev);
  }
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id.localeCompare(b.id)));

  // ------------------------------------------------------------- decisions
  const decisions = [];
  for (const { file, dir, records } of [
    ...(await readYamlDir(resolve(DATA, 'decisions'))),
    ...(await readYamlDir(resolve(DATA, 'seed-wikipedia'))).filter((g) => /decision/.test(g.file)),
  ]) {
    const isSeed = dir.includes('seed-wikipedia');
    for (const rec of records) {
      const where = `decisions/${file}`;
      checkCommon(rec, where);
      if (!DECISION_TYPES.includes(rec.type)) err(`${where} (${rec.id}): 未知の type "${rec.type}"`);
      if (!rec.date) err(`${where} (${rec.id}): date が無い`);
      if (!/^dec-\d{8}-/.test(rec.id ?? '')) err(`${where} (${rec.id}): id は dec-YYYYMMDD-slug`);
      for (const a of rec.actors ?? []) if (!actorIds.has(a)) err(`${where} (${rec.id}): 未知の actor "${a}"`);
      if (!rec.summary_ja) warn(`${where} (${rec.id}): summary_ja が無い`);
      checkCoord(rec, where);
      decisions.push({ ...rec, _seed: isSeed });
    }
  }
  // seed-wikipedia は cc-by-sa 固定
  for (const { file, records } of await readYamlDir(resolve(DATA, 'seed-wikipedia'))) {
    for (const rec of records) {
      if (rec.license !== 'cc-by-sa') {
        err(`seed-wikipedia/${file} (${rec.id}): seed-wikipedia は license: cc-by-sa 固定`);
      }
    }
  }
  decisions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));

  // ------------------------------------------------------------- homefront
  const homefront = [];
  for (const { file, records } of await readYamlDir(resolve(DATA, 'homefront'))) {
    for (const rec of records) {
      const where = `homefront/${file}`;
      checkCommon(rec, where);
      if (!HOMEFRONT_TYPES.includes(rec.type)) err(`${where} (${rec.id}): 未知の type "${rec.type}"`);
      if (!rec.date) err(`${where} (${rec.id}): date が無い`);
      if (!/^hf-\d{8}-/.test(rec.id ?? '')) err(`${where} (${rec.id}): id は hf-YYYYMMDD-slug`);
      if (rec.country && !actorIds.has(rec.country)) err(`${where} (${rec.id}): 未知の country "${rec.country}"`);
      if (!rec.headline_ja) err(`${where} (${rec.id}): headline_ja が無い`);
      checkCoord(rec, where);
      homefront.push(rec);
    }
  }
  homefront.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));

  // ----------------------------------------------------------------- links
  const linksPath = resolve(DATA, 'links.yaml');
  const links = (existsSync(linksPath) ? await readYaml(linksPath) : null) ?? [];
  const known = new Set([...events.map((e) => e.id), ...decisions.map((d) => d.id), ...homefront.map((h) => h.id)]);
  const seenLink = new Set();
  for (const l of links) {
    const tag = `links.yaml (${l.from} → ${l.to})`;
    if (!l.from || !l.to) {
      err(`${tag}: from / to が必要`);
      continue;
    }
    if (!RELATIONS.includes(l.relation)) err(`${tag}: 未知の relation "${l.relation}"`);
    if (!known.has(l.from)) err(`${tag}: from "${l.from}" が存在しない`);
    if (!known.has(l.to)) err(`${tag}: to "${l.to}" が存在しない`);
    const key = `${l.from}|${l.to}|${l.relation}`;
    if (seenLink.has(key)) err(`${tag}: 重複したリンク`);
    seenLink.add(key);
    if (l.discrepancy) {
      if (l.relation !== 'reports') err(`${tag}: discrepancy は relation: reports のときだけ`);
      if (!DISCREPANCY_KINDS.includes(l.discrepancy.kind)) err(`${tag}: 未知の discrepancy.kind`);
      if (!l.discrepancy.claimed_ja || !l.discrepancy.actual_ja) err(`${tag}: claimed_ja / actual_ja が必要`);
    }
    if (!l.note_ja && l.relation !== 'reports') warn(`${tag}: note_ja（根拠メモ）が無い`);
  }

  // ------------------------------------------------------------- territory
  const keyframes = await readYaml(resolve(DATA, 'territory/keyframes.yaml'));
  const fmPath = resolve(DATA, 'territory/faction-map.yaml');
  const factionMap = existsSync(fmPath) ? ((await readYaml(fmPath)) ?? {}) : {};
  const byId = new Map(Object.entries(factionMap.by_ohm_id ?? {}).map(([k, v]) => [String(k), v]));
  const byName = new Map(Object.entries(factionMap.by_name ?? {}));

  // 値は「単一の control」か「{control, from} の配列」。
  // 配列のときは keyframe の日付以下で最後に当たった控えを採る（from 無しが既定値）
  const resolveControl = (value, date) => {
    if (value == null) return null;
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return null;
    let hit = null;
    for (const entry of value) {
      if (!entry?.from || entry.from <= date) hit = entry.control;
    }
    return hit;
  };
  for (const [key, value] of [...byId, ...byName]) {
    const list = typeof value === 'string' ? [{ control: value }] : Array.isArray(value) ? value : null;
    if (!list) {
      err(`faction-map.yaml (${key}): 値は control 文字列か {control, from} の配列`);
      continue;
    }
    for (const entry of list) {
      if (!CONTROLS.includes(entry?.control)) err(`faction-map.yaml (${key}): 未知の control "${entry?.control}"`);
      if (entry?.from && !/^\d{4}-\d{2}-\d{2}$/.test(entry.from)) {
        err(`faction-map.yaml (${key}): from は YYYY-MM-DD`);
      }
    }
  }

  // 幾何は日付をまたいで共有する（日付ごとに持つと 1 枚 1.1MB × 枚数になる）
  const geomPath = resolve(DATA, 'territory/geometry.json');
  const geometry = existsSync(geomPath) ? JSON.parse(await readFile(geomPath, 'utf8')) : null;
  if (!geometry) warn('data/territory/geometry.json が無い（npm run fetch:territory）');

  const territoryOut = [];
  const unassigned = new Map(); // name → [dates]
  const usedGeom = new Set();
  for (const date of keyframes) {
    const p = resolve(DATA, `territory/frames/${date}.json`);
    if (!existsSync(p) || !geometry) {
      warn(`territory/frames/${date}.json が無い（npm run fetch:territory）`);
      continue;
    }
    const frame = JSON.parse(await readFile(p, 'utf8'));
    const polities = [];
    for (const pr of frame.polities) {
      if (!geometry[pr.ohm_id]) {
        warn(`territory/frames/${date}.json: ${pr.ohm_id} の幾何が geometry.json に無い`);
        continue;
      }
      const control =
        resolveControl(byId.get(String(pr.ohm_id)), date) ?? resolveControl(byName.get(pr.name), date);
      if (!control) {
        const key = `${pr.name} (ohm_id ${pr.ohm_id})`;
        if (!unassigned.has(key)) unassigned.set(key, []);
        unassigned.get(key).push(date);
      }
      usedGeom.add(String(pr.ohm_id));
      polities.push({
        ohm_id: pr.ohm_id,
        name: pr.name,
        name_ja: pr.name_ja ?? null,
        control: control ?? 'neutral',
        control_assigned: Boolean(control),
        start_date: pr.start_date ?? null,
        end_date: pr.end_date ?? null,
      });
    }
    territoryOut.push({ date, polities });
  }
  if (unassigned.size) {
    warn(
      `faction-map.yaml に control が無い政体 ${unassigned.size} 件（neutral 扱い）:\n` +
        [...unassigned.entries()]
          .slice(0, 40)
          .map(([k, d]) => `      - ${k}  [${d[0]}〜]`)
          .join('\n') +
        (unassigned.size > 40 ? `\n      … ほか ${unassigned.size - 40} 件` : ''),
    );
  }

  // ─────────────────────────────────── 軍事的な支配（Commons の月次図から機械変換）
  // OHM は「政体の境界」しか持たないので、独ソ戦のようにソ連領内へ食い込んだ占領地域が
  // 面として描けない。Commons の月次図（PD）は軍事的な支配で塗り分けられていて、
  // 凡例の 5 区分がこちらの control とそのまま対応する。
  // ⚠ ヨーロッパのみ・1939-08〜1942-12。それ以外の時期と地域は従来どおり OHM。
  const controlDir = resolve(DATA, 'territory/control');
  const controlIdxPath = resolve(controlDir, 'index.json');
  let controlMonths = [];
  let controlMeta = null;
  if (existsSync(controlIdxPath)) {
    const idx = JSON.parse(await readFile(controlIdxPath, 'utf8'));
    controlMeta = idx._meta ?? null;
    for (const m of idx.months ?? []) {
      const p = resolve(controlDir, m.file);
      if (!existsSync(p)) {
        warn(`territory/control/${m.file} が無い（npm run fetch:control）`);
        continue;
      }
      const fc = JSON.parse(await readFile(p, 'utf8'));
      for (const f of fc.features ?? []) {
        const c = f.properties?.control;
        if (!CONTROLS.includes(c)) err(`territory/control/${m.file}: 未知の control "${c}"`);
      }
      controlMonths.push({ month: m.month, fc, rmse_px: m.rmse_px ?? null });
    }
    if (!controlMonths.length) warn('territory/control/ が空（npm run fetch:control）');
  } else {
    warn('data/territory/control/index.json が無い（npm run fetch:control）');
  }

  // ------------------------------------------------------------- 前線ライン
  // OHM の面は「政体の境界」しか持たないので、独ソ戦のようにソ連領内へ食い込んだ
  // 戦線は面として描けない。折れ線で補う。
  const flPath = resolve(DATA, 'territory/frontlines.yaml');
  const frontlines = existsSync(flPath) ? ((await readYaml(flPath)) ?? []) : [];
  for (const fl of frontlines) {
    const where = 'territory/frontlines.yaml';
    checkCommon(fl, where);
    if (!/^fl-\d{8}-/.test(fl.id ?? '')) err(`${where} (${fl.id}): id は fl-YYYYMMDD-slug`);
    if (!fl.date) err(`${where} (${fl.id}): date が無い`);
    if (fl.theatre && !THEATRES.includes(fl.theatre)) err(`${where} (${fl.id}): 未知の theatre`);
    if (!Array.isArray(fl.coords) || fl.coords.length < 2) {
      err(`${where} (${fl.id}): coords は 2 点以上の [経度, 緯度] の配列`);
    } else {
      for (const c of fl.coords) {
        if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number') {
          err(`${where} (${fl.id}): coords の要素が [経度, 緯度] でない`);
          break;
        }
      }
    }
  }
  frontlines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // ─────────────────────────── 概略の支配領域（前線と範囲から導出したもの）
  // Commons の面が無い期間・地域（1943 年以降のヨーロッパ・中国全期間）を、
  // frontlines.yaml と approx-zones.yaml から導出した層。精度は折れ線と同じ。
  const zonesPath = resolve(DATA, 'territory/approx-zones.yaml');
  const approxZones = existsSync(zonesPath) ? ((await readYaml(zonesPath)) ?? []) : [];
  for (const z of approxZones) {
    const where = 'territory/approx-zones.yaml';
    checkCommon(z, where);
    if (!/^(pk|zn)-/.test(z.id ?? '')) err(`${where} (${z.id}): id は pk-（孤立陣地）か zn-（範囲）で始める`);
    if (!CONTROLS.includes(z.control)) err(`${where} (${z.id}): 未知の control "${z.control}"`);
    for (const k of ['from', 'to']) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(z[k] ?? ''))) err(`${where} (${z.id}): ${k} は YYYY-MM-DD`);
    }
    if (z.from && z.to && z.to < z.from) err(`${where} (${z.id}): to < from`);
    if (!z.clip_to) err(`${where} (${z.id}): clip_to（切り抜く政体名の正規表現）が無い`);
    if (!Array.isArray(z.coords) || z.coords.length < 3) {
      err(`${where} (${z.id}): coords は 3 点以上の [経度, 緯度] の配列`);
    } else {
      for (const c of z.coords) {
        if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number') {
          err(`${where} (${z.id}): coords の要素が [経度, 緯度] でない`);
          break;
        }
      }
    }
  }

  const approxDir = resolve(DATA, 'territory/approx');
  const approxIdxPath = resolve(approxDir, 'index.json');
  let approxDates = [];
  let approxMeta = null;
  if (existsSync(approxIdxPath)) {
    const idx = JSON.parse(await readFile(approxIdxPath, 'utf8'));
    approxMeta = idx._meta ?? null;
    for (const d of idx.dates ?? []) {
      const p = resolve(approxDir, d.file);
      if (!existsSync(p)) {
        warn(`territory/approx/${d.file} が無い（npm run build:approx）`);
        continue;
      }
      const fc = JSON.parse(await readFile(p, 'utf8'));
      for (const f of fc.features ?? []) {
        const c = f.properties?.control;
        if (!CONTROLS.includes(c)) err(`territory/approx/${d.file}: 未知の control "${c}"`);
      }
      approxDates.push({ date: d.date, fc, parts: d.parts ?? [] });
    }
  } else if (approxZones.length || frontlines.some((f) => f.theatre === 'europe_east' && f.date >= '1943-01-01')) {
    warn('data/territory/approx/index.json が無い（npm run build:approx）');
  }

  // --------------------------------------------------------------- 検証結果
  if (warnings.length) {
    console.warn(`\n⚠ 警告 ${warnings.length} 件`);
    for (const w of warnings) console.warn(`   - ${w}`);
  }
  if (errors.length) {
    console.error(`\n✖ エラー ${errors.length} 件 — ビルドを中止します`);
    for (const e of errors) console.error(`   - ${e}`);
    process.exit(1);
  }
  if (STRICT && warnings.length) {
    console.error('\n✖ --strict: 警告があるので中止します');
    process.exit(1);
  }

  const counts = {
    events: events.length,
    decisions: decisions.length,
    homefront: homefront.length,
    links: links.length,
    territory: territoryOut.length,
    frontlines: frontlines.length,
    control: controlMonths.length,
    approx: approxDates.length,
  };
  if (CHECK_ONLY) {
    console.log('\n✓ 検証だけ実行（--check）');
    console.log('  ', JSON.stringify(counts));
    return;
  }

  // ----------------------------------------------------------------- 出力
  // license: cc-by-sa は帰属＋継承が要るので別ファイルに分ける
  const splitByLicense = (records) => ({
    open: records.filter((r) => r.license !== 'cc-by-sa'),
    share: records.filter((r) => r.license === 'cc-by-sa'),
  });

  await rm(OUT, { recursive: true, force: true });
  await mkdir(resolve(OUT, 'territory'), { recursive: true });

  const meta = (name, extra = {}) => ({
    generated_at: new Date().toISOString(),
    generator: 'scripts/build-data.mjs',
    name,
    ...extra,
  });

  const write = (file, obj) => writeFile(resolve(OUT, file), JSON.stringify(obj) + '\n');

  for (const [name, records] of [
    ['events', events],
    ['decisions', decisions.map(({ _seed, ...r }) => r)],
    ['homefront', homefront],
  ]) {
    const { open, share } = splitByLicense(records);
    await write(`${name}.json`, { _meta: meta(name, { count: open.length }), [name]: open });
    if (share.length) {
      await write(`${name}.cc-by-sa.json`, {
        _meta: meta(`${name} (CC BY-SA)`, {
          count: share.length,
          license: 'CC BY-SA 4.0',
          note: 'Wikipedia / Wikimedia Commons 由来。帰属表示と同一ライセンスでの継承が必要',
        }),
        [name]: share,
      });
    }
  }

  await write('links.json', { _meta: meta('links', { count: links.length }), links });
  await write('frontlines.json', {
    _meta: meta('frontlines', {
      count: frontlines.length,
      note: '概略線。地図のトレースではないので数十 km 単位の精度は無い',
    }),
    frontlines: frontlines.map((fl) => ({
      id: fl.id,
      date: fl.date,
      theatre: fl.theatre ?? null,
      name_ja: fl.name_ja,
      note_ja: fl.note_ja ?? null,
      coords: fl.coords,
      verified: fl.verified,
      sources: fl.sources,
    })),
  });
  await write('actors.json', { _meta: meta('actors', { count: actors.length }), actors });
  await write('territory/index.json', {
    _meta: meta('territory keyframes', { count: territoryOut.length }),
    keyframes: territoryOut.map((t) => t.date),
  });
  // 実際に使われた幾何だけを 1 ファイルに出す。フロントは 1 回読んで使い回す
  const geomOut = {};
  for (const id of usedGeom) if (geometry?.[id]) geomOut[id] = geometry[id];
  await write('territory/geometry.json', geomOut);
  for (const { date, polities } of territoryOut) {
    await write(`territory/${date}.json`, { date, polities });
  }
  if (approxDates.length) {
    await mkdir(resolve(OUT, 'territory/approx'), { recursive: true });
    for (const { date, fc } of approxDates) await write(`territory/approx/${date}.json`, fc);
    await write('territory/approx/index.json', {
      _meta: meta('approximate control (derived)', { count: approxDates.length, source: approxMeta }),
      dates: approxDates.map(({ date, parts }) => ({ date, parts })),
    });
  }
  if (controlMonths.length) {
    await mkdir(resolve(OUT, 'territory/control'), { recursive: true });
    for (const { month, fc } of controlMonths) await write(`territory/control/${month}.json`, fc);
    await write('territory/control/index.json', {
      _meta: meta('military control (Commons)', { count: controlMonths.length, source: controlMeta }),
      months: controlMonths.map(({ month, rmse_px }) => ({ month, rmse_px })),
    });
  }

  // 帰属一覧。公開時に書き直さないよう source フィールドから自動生成する
  const datasets = [
    { title: 'Wikidata', url: 'https://www.wikidata.org/', license: 'CC0', use: 'イベントの名称・座標・日付・参加者' },
    { title: 'OpenHistoricalMap', url: 'https://www.openhistoricalmap.org/', license: 'ODbL / CC0 (contributor terms)', use: '支配領域の境界（時点指定）' },
    { title: 'Natural Earth', url: 'https://www.naturalearthdata.com/', license: 'Public Domain', use: 'ベースマップ（陸・海）' },
    {
      title: 'Wikimedia Commons「Second World War Europe MM YYYY de.svg」（作者 San Jose）',
      url: 'https://commons.wikimedia.org/wiki/Category:Maps_of_World_War_II',
      license: 'Public Domain',
      use: '軍事的な支配領域（ヨーロッパ・1939-08〜1942-12 の月次）。図の投影指定から逆投影して取り込み',
    },
  ];
  const recordSources = new Map();
  for (const r of [...events, ...decisions, ...homefront]) {
    for (const s of r.sources ?? []) {
      const key = s.url;
      if (!recordSources.has(key)) recordSources.set(key, { title: s.title, url: s.url, count: 0, licenses: new Set() });
      const agg = recordSources.get(key);
      agg.count++;
      agg.licenses.add(r.license);
    }
  }
  await write('sources.json', {
    _meta: meta('attribution'),
    datasets,
    records: [...recordSources.values()]
      .map((s) => ({ ...s, licenses: [...s.licenses] }))
      .sort((a, b) => b.count - a.count),
  });

  console.log('\n✓ public/data/ を生成');
  for (const [k, n] of Object.entries(counts)) console.log(`   ${k.padEnd(10)} ${n}`);
  const ccbysa = [...events, ...decisions, ...homefront].filter((r) => r.license === 'cc-by-sa').length;
  const linkOnly = [...events, ...decisions, ...homefront].filter((r) => r.license === 'link-only').length;
  const unverified = [...events, ...decisions, ...homefront].filter((r) => !r.verified).length;
  console.log(`   ${'cc-by-sa'.padEnd(10)} ${ccbysa}（別ファイル）`);
  console.log(`   ${'link-only'.padEnd(10)} ${linkOnly}（本文を保存していない）`);
  console.log(`   ${'未確認'.padEnd(9)} ${unverified}（verified: false）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
