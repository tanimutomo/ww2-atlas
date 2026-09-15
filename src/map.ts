// 地図（現場レイヤー）。MapLibre GL JS。
//
// タイルサーバは使わない。Natural Earth の陸地と、ビルド済みの領域 GeoJSON、
// イベント点をすべてローカルの GeoJSON ソースとして持つ。オフラインでも動く。
//
// 領域は日付キーフレームのステップ表示（補間しない）。
// イベント点は「その日に進行中のもの」だけを filter 式で出し分ける。

import maplibregl, { type Map as MlMap, type GeoJSONSource } from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import {
  CATEGORY_COLOR,
  CONTROL_COLOR,
  APPROX_COLOR,
  keyframeFor,
  controlMonthFor,
  approxDateFor,
  mapPoints,
  toDayNumber,
  type Atlas,
  type MapPoint,
} from './data';
import { MapLabels, type LabelItem } from './labels';
import {
  bakeArrowhead,
  bakeIcon,
  brighten,
  endBearing,
  movementsOn,
  snapshotsOn,
  type Echelon,
} from './units';

const BASE = import.meta.env.BASE_URL ?? '/';

const OCEAN = '#152029';
const LAND = '#2b3238';

export class AtlasMap {
  readonly map: MlMap;
  private atlas: Atlas;
  /** 現場・司令部・国内を均した地図用の点。重なりのずらしも済んでいる */
  private points: MapPoint[];
  /** ohm_id → 幾何。日付をまたいで共有するので 1 回だけ読む */
  private geometry: Record<string, Geometry> | null = null;
  /** 組み立て済みの日付フレーム */
  private territoryCache = new Map<string, FeatureCollection>();
  private controlCache = new Map<string, FeatureCollection>();
  private currentControl: string | null = null;
  private approxCache = new Map<string, FeatureCollection>();
  private currentApprox: string | null = null;
  private userMoved = false;
  private currentKeyframe: string | null = null;
  private onSelect: (id: string) => void;
  private labels: MapLabels | null = null;
  /** 部隊名のラベル。選択中の戦闘のあいだだけ出す */
  private unitLabels: LabelItem[] = [];
  /** 前回の描画で「進行中」だったイベント。増えたぶんにだけ名前を出す */
  private prevActive = new Set<string>();
  private stickyId: string | null = null;

  constructor(container: HTMLElement, atlas: Atlas, onSelect: (id: string) => void) {
    this.atlas = atlas;
    this.points = mapPoints(atlas);
    this.onSelect = onSelect;
    this.map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        // グリフを外部から取らない（フォントを使うシンボルレイヤーは置かない）
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': OCEAN } }],
      },
      center: [20, 35],
      zoom: 2.1,
      minZoom: 1.2,
      maxZoom: 7,
      attributionControl: false,
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    // 出典表示は地図の下端のバー（index.html の .mb-attr）に出しているので、
    // MapLibre のコントロールは足さない。全件の一覧は public/data/sources.json
  }

  async init(): Promise<void> {
    // 'load' はここに来る前に発火していることがある（そのまま待つと永久に解決しない）。
    // すでに読み込み済みかを先に確かめる。
    // 'load' を待つのは危険が 2 つある。
    //   ① ここに来る前に発火済みだと、そのまま待つと永久に解決しない
    //   ② 'load' は初回描画のときに出るので、コンテナのサイズが 0 だと出ない
    //      （タブが非表示・パネルが畳まれている・遅延表示のとき）
    // スタイルは自前のインライン定義なので、'styledata' が出た時点でソースを足してよい。
    await new Promise<void>((resolve) => {
      if (this.map.isStyleLoaded()) return resolve();
      const done = () => resolve();
      this.map.once('load', done);
      this.map.once('styledata', done);
    });

    // CSS が当たる前に構築されるとキャンバスが極小のまま固定されることがある。
    // 初回に明示的に測り直し、以後はコンテナのサイズ変化を監視して追随する。
    this.map.resize();
    new ResizeObserver(() => this.map.resize()).observe(this.map.getContainer());
    this.labels = new MapLabels(this.map);

    const land = await fetch(`${BASE}base/ne_50m_land.geojson`).then((r) => r.json());
    this.map.addSource('land', { type: 'geojson', data: land });
    this.map.addLayer({
      id: 'land',
      type: 'fill',
      source: 'land',
      paint: { 'fill-color': LAND },
    });

    // 支配領域（面）
    this.map.addSource('territory', { type: 'geojson', data: emptyFc() });
    this.map.addLayer({
      id: 'territory-fill',
      type: 'fill',
      source: 'territory',
      paint: {
        'fill-color': [
          'match',
          ['get', 'control'],
          'axis', CONTROL_COLOR.axis,
          'axis_occupied', CONTROL_COLOR.axis_occupied,
          'allied', CONTROL_COLOR.allied,
          'allied_occupied', CONTROL_COLOR.allied_occupied,
          'su', CONTROL_COLOR.su,
          CONTROL_COLOR.neutral,
        ],
        // 占領地はやや薄くして「本国ではない」ことを出す
        'fill-opacity': [
          'match',
          ['get', 'control'],
          'axis_occupied', 0.55,
          'allied_occupied', 0.55,
          'neutral', 0.3,
          0.8,
        ],
      },
    });
    this.map.addLayer({
      id: 'territory-line',
      type: 'line',
      source: 'territory',
      paint: { 'line-color': '#0d141a', 'line-width': 0.5, 'line-opacity': 0.7 },
    });

    // 概略の支配領域（前線と範囲から導出）。政体境界の上、正確な面の下。
    // 輪郭線を引かず薄めに塗ることが「ここは概略」という合図になっている
    // （はっきりした境界を描くと、実測の面と同じ確かさに見えてしまう）。
    this.map.addSource('approx', { type: 'geojson', data: emptyFc() });
    this.map.addLayer({
      id: 'approx-fill',
      type: 'fill',
      source: 'approx',
      paint: {
        // 下の政体境界と混ざらないよう、混色済みの色を不透明で塗る（data.ts の APPROX_COLOR）
        'fill-color': [
          'match',
          ['get', 'control'],
          'axis', APPROX_COLOR.axis,
          'axis_occupied', APPROX_COLOR.axis_occupied,
          'allied', APPROX_COLOR.allied,
          'allied_occupied', APPROX_COLOR.allied_occupied,
          APPROX_COLOR.neutral,
        ],
        'fill-opacity': 1,
      },
    });

    // 軍事的な支配（Commons の月次図から機械変換）。政体境界の上に重ねる。
    // OHM は国境しか持たないので、独ソ戦のようにソ連領内へ食い込んだ占領地域は
    // こちらでしか塗れない。収録はヨーロッパ・1939-08〜1942-12 だけなので、
    // それ以外の地域と時期では下の territory-fill がそのまま見える。
    this.map.addSource('control', { type: 'geojson', data: emptyFc() });
    this.map.addLayer({
      id: 'control-fill',
      type: 'fill',
      source: 'control',
      paint: {
        'fill-color': [
          'match',
          ['get', 'control'],
          'axis', CONTROL_COLOR.axis,
          'axis_occupied', CONTROL_COLOR.axis_occupied,
          'allied', CONTROL_COLOR.allied,
          'allied_occupied', CONTROL_COLOR.allied_occupied,
          CONTROL_COLOR.neutral,
        ],
        'fill-opacity': [
          'match',
          ['get', 'control'],
          'axis_occupied', 0.55,
          'allied_occupied', 0.55,
          0.8,
        ],
      },
    });
    this.map.addLayer({
      id: 'control-line',
      type: 'line',
      source: 'control',
      paint: { 'line-color': '#0d141a', 'line-width': 0.5, 'line-opacity': 0.7 },
    });

    // 前線ライン。面（政体境界）では描けない戦線を折れ線で補う
    this.map.addSource('frontlines', { type: 'geojson', data: emptyFc() });
    this.map.addLayer({
      id: 'frontline-glow',
      type: 'line',
      source: 'frontlines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffd479', 'line-width': 7, 'line-blur': 5, 'line-opacity': 0.28 },
    });
    this.map.addLayer({
      id: 'frontline',
      type: 'line',
      source: 'frontlines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffd479',
        'line-width': 2,
        // 概略線であることが見て分かるよう破線にする
        'line-dasharray': [3, 2],
      },
    });

    // 部隊の移動（矢印つきの線）。配置より下に敷く
    this.map.addSource('unit-moves', { type: 'geojson', data: emptyFc() });
    this.map.addLayer({
      id: 'unit-moves-line',
      type: 'line',
      source: 'unit-moves',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 2,
        'line-opacity': 0.9,
        // 後退は破線にして、前進と一目で見分ける
        'line-dasharray': ['case', ['==', ['get', 'kind'], 'retreat'], ['literal', [2, 2]], ['literal', [1]]],
      },
    });
    this.map.addSource('unit-move-heads', { type: 'geojson', data: emptyFc() });
    this.map.addLayer({
      id: 'unit-move-heads',
      type: 'symbol',
      source: 'unit-move-heads',
      layout: {
        // 矢じりは色ごとに焼いてある（icon-color は SDF 画像にしか効かない）
        'icon-image': ['get', 'icon'],
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });

    // 部隊の配置（NATO 記号）
    this.map.addSource('units', { type: 'geojson', data: emptyFc() });
    this.map.addLayer({
      id: 'units-symbol',
      type: 'symbol',
      source: 'units',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-offset': ['get', 'offset'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      // 部隊名はグリフを持っていないので、地図のラベル（HTML 側）に出す
    });

    // イベント点
    this.map.addSource('events', { type: 'geojson', data: emptyFc() });
    this.map.addLayer({
      id: 'events-halo',
      type: 'circle',
      source: 'events',
      filter: ['==', ['get', 'phase'], 2],
      paint: {
        'circle-radius': ['*', ['get', 'significance'], 5],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.18,
      },
    });
    this.map.addLayer({
      id: 'events-dot',
      type: 'circle',
      source: 'events',
      paint: {
        'circle-radius': [
          'match',
          ['get', 'phase'],
          2, ['+', 2, ['*', ['get', 'significance'], 1.8]],
          1, ['+', 1.6, ['*', ['get', 'significance'], 1.2]],
          // 痕跡。小さすぎると集まっても「濃い地域」に見えないので、
          // 単体では控えめ・重なると効く程度の大きさにしてある
          ['+', 1.5, ['*', ['get', 'significance'], 1.0]],
        ],
        'circle-color': ['get', 'color'],
        'circle-opacity': ['match', ['get', 'phase'], 2, 1, 1, 0.7, 0.45],
        'circle-stroke-color': '#0d141a',
        'circle-stroke-width': ['match', ['get', 'phase'], 2, 1, 1, 0.6, 0],
      },
    });
    // 選択中のイベント・リンク先を光らせる
    this.map.addLayer({
      id: 'events-highlight',
      type: 'circle',
      source: 'events',
      filter: ['==', ['get', 'id'], '__none__'],
      paint: {
        'circle-radius': ['+', 8, ['*', ['get', 'significance'], 2.5]],
        'circle-color': 'transparent',
        'circle-stroke-color': '#ffd479',
        'circle-stroke-width': 2.5,
      },
    });

    this.map.on('click', 'events-dot', (e) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      if (id) this.onSelect(id);
    });
    for (const layer of ['events-dot']) {
      this.map.on('mouseenter', layer, () => (this.map.getCanvas().style.cursor = 'pointer'));
      this.map.on('mouseleave', layer, () => (this.map.getCanvas().style.cursor = ''));
    }

    // 利用者の手による移動だけを拾う（自前の easeTo には originalEvent が無い）
    this.map.on('movestart', (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) this.userMoved = true;
    });
  }

  /** 日付を変える。領域はキーフレームが変わったときだけ読み直す */
  async setDate(date: string, filters: { theatres: Set<string>; windowDays: number }): Promise<void> {
    const kf = keyframeFor(this.atlas.keyframes, date);
    if (kf && kf !== this.currentKeyframe) {
      this.currentKeyframe = kf;
      const fc = await this.territoryFrame(kf);
      // 取得を待つあいだに日付が変わっていたら、古い枠を描かない
      if (this.currentKeyframe === kf) {
        (this.map.getSource('territory') as GeoJSONSource | undefined)?.setData(fc as never);
      }
    }

    // 軍事的な支配（月次）。収録の外に出たら空にして政体境界だけに戻す
    const cm = controlMonthFor(this.atlas.controlMonths, date);
    if (cm !== this.currentControl) {
      this.currentControl = cm;
      const fc = cm ? await this.controlFrame(cm) : emptyFc();
      if (this.currentControl === cm) {
        (this.map.getSource('control') as GeoJSONSource | undefined)?.setData(fc as never);
      }
    }

    // 概略の面（1943 年以降のヨーロッパと中国）
    const ad = approxDateFor(this.atlas.approxDates, date);
    if (ad !== this.currentApprox) {
      this.currentApprox = ad;
      const fc = ad ? await this.approxFrame(ad) : emptyFc();
      if (this.currentApprox === ad) {
        (this.map.getSource('approx') as GeoJSONSource | undefined)?.setData(fc as never);
      }
    }

    // その日までに起きたことは消さずに残す。
    // 消してしまうと「どのあたりで何が積み重なったか」が読めなくなるので、
    // 3 段階に落として、古いものほど小さく薄くする。
    //   2 進行中     … いちばん大きく、まわりに光を出す
    //   1 直近に終了 … 中くらい
    //   0 それ以前   … 小さな痕跡。集まると「濃い地域」として見える
    const feats = this.visible(date, filters).map((p) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: p.coord },
      properties: {
        id: p.id,
        significance: p.significance,
        color: CATEGORY_COLOR[p.category],
        phase: phaseOf(p, date, filters.windowDays),
      },
    }));
    (this.map.getSource('events') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: feats,
    });

    // 前線は日付以下で最も新しいものを出す（面と同じくステップ表示・補間しない）
    const flDates = [...new Set(this.atlas.frontlines.map((f) => f.date))].sort();
    let flDate: string | null = null;
    for (const d of flDates) if (d <= date) flDate = d;
    const lines = flDate
      ? this.atlas.frontlines.filter(
          (f) => f.date === flDate && (!f.theatre || filters.theatres.has(f.theatre)),
        )
      : [];
    (this.map.getSource('frontlines') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: lines.map((f) => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: f.coords },
        properties: { id: f.id, name: f.name_ja },
      })),
    });

    // 開いている戦闘の配置は日付で入れ替わる（スナップショットの区間をまたぐ）
    this.setUnits(date, this.stickyId);
    this.refreshLabels(date, filters);
  }

  /** その日までに起きていて、フィルタを通る点。戦域フィルタは現場だけに効く */
  /**
   * 部隊配置を出す。開いている戦闘のものだけ・その日のスナップショットだけ。
   * 何も開いていなければ空にする（常時出すと地図が記号で埋まる）。
   */
  setUnits(date: string, eventId: string | null): void {
    const snaps = snapshotsOn(this.atlas.unitSnapshots, date, eventId);
    const moves = movementsOn(this.atlas.movements, date, eventId);
    const colorOf = (side: string) => brighten(this.atlas.actorById.get(side)?.color ?? '#9aa7b4');

    (this.map.getSource('units') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: snaps.map((u) => {
        const color = colorOf(u.side);
        const { id, offset } = bakeIcon(this.map, color, u.echelon as Echelon, u.heading);
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: u.coord },
          properties: { icon: id, offset, color },
        };
      }),
    } as never);

    // 部隊名はグリフが無いので HTML のラベルで出す。開いているあいだは消さない
    this.unitLabels = snaps.map((u) => ({
      id: `unit:${u.id}`,
      coord: u.coord,
      text: `${u.name_ja}`,
      sticky: true,
    }));

    const unitOf = new Map(snaps.map((u) => [u.unit, u]));
    (this.map.getSource('unit-moves') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: moves.map((m) => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: m.path },
        properties: { kind: m.kind, color: colorOf(unitOf.get(m.unit)?.side ?? '') },
      })),
    } as never);
    (this.map.getSource('unit-move-heads') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: moves.map((m) => {
        const color = colorOf(unitOf.get(m.unit)?.side ?? '');
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: m.path[m.path.length - 1] },
          properties: { icon: bakeArrowhead(this.map, color), bearing: endBearing(m.path) },
        };
      }),
    } as never);
  }

  private visible(date: string, filters: { theatres: Set<string> }): MapPoint[] {
    return this.points.filter(
      (p) => p.start <= date && (p.theatre === null || filters.theatres.has(p.theatre)),
    );
  }

  /**
   * 名前ラベルの出し分け。
   *   - その日に「新しく始まった」ものだけを一時的に出す（全部出すと埋まる）
   *   - 選択中のものは出したままにする
   */
  private refreshLabels(date: string, filters: { theatres: Set<string> }): void {
    if (!this.labels) return;
    const active = this.visible(date, filters).filter((p) => isOn(p, date));
    const activeIds = new Set(active.map((p) => p.id));

    const items: LabelItem[] = active
      // 前回まで進行中でなかった＝この日に始まったもの
      .filter((p) => !this.prevActive.has(p.id))
      // 一度に出しすぎないよう、重要なものから
      .sort((a, b) => b.significance - a.significance)
      .slice(0, 6)
      .map((p) => ({ id: p.id, coord: p.coord, text: p.name }));

    if (this.stickyId) {
      const sel = this.points.find((p) => p.id === this.stickyId);
      if (sel) {
        const already = items.find((i) => i.id === sel.id);
        if (already) already.sticky = true;
        else items.push({ id: sel.id, coord: sel.coord, text: sel.name, sticky: true });
      }
    }

    // 部隊名は開いている戦闘のあいだだけ、常に出す
    items.push(...this.unitLabels);

    this.labels.show(items);
    this.prevActive = activeIds;
  }

  /**
   * 日付フレームを組み立てる。
   * 幾何（geometry.json）は全日付で共有し、フレーム側は「どの政体がどの陣営か」だけを持つ。
   * 日付を増やしてもフレーム 1 枚ぶん（数十 KB）しか増えない。
   */
  private async territoryFrame(kf: string): Promise<FeatureCollection> {
    const cached = this.territoryCache.get(kf);
    if (cached) return cached;

    if (!this.geometry) {
      this.geometry = await fetch(`${BASE}data/territory/geometry.json`).then((r) => r.json());
    }
    const frame: { polities: Record<string, unknown>[] } = await fetch(
      `${BASE}data/territory/${kf}.json`,
    ).then((r) => r.json());

    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: frame.polities.flatMap((p) => {
        const g = this.geometry?.[String(p.ohm_id)];
        return g ? [{ type: 'Feature', properties: p, geometry: g } as Feature] : [];
      }),
    };
    this.territoryCache.set(kf, fc);
    return fc;
  }

  /** 概略の面は日付ごとに 1 ファイル（5〜17KB） */
  private async approxFrame(date: string): Promise<FeatureCollection> {
    const cached = this.approxCache.get(date);
    if (cached) return cached;
    const fc: FeatureCollection = await fetch(`${BASE}data/territory/approx/${date}.json`).then((r) =>
      r.json(),
    );
    this.approxCache.set(date, fc);
    return fc;
  }

  /** 支配レイヤは月ごとに 1 ファイル（20〜35KB）。共有幾何は要らない */
  private async controlFrame(month: string): Promise<FeatureCollection> {
    const cached = this.controlCache.get(month);
    if (cached) return cached;
    const fc: FeatureCollection = await fetch(`${BASE}data/territory/control/${month}.json`).then((r) =>
      r.json(),
    );
    this.controlCache.set(month, fc);
    return fc;
  }

  /** 選択・リンク先のハイライト。先頭が選択中のもので、その名前は出したままにする */
  highlight(ids: string[], date?: string): void {
    this.map.setFilter('events-highlight', ['in', ['get', 'id'], ['literal', ids]]);
    this.stickyId = ids[0] ?? null;
    if (date) this.setUnits(date, this.stickyId);
    else this.unitLabels = [];
    if (!this.labels) return;
    // ハイライトされた点すべてに名前を出す（リンク先がどれか分かるように）
    const items = ids
      .map((id) => this.points.find((p) => p.id === id))
      .filter((p): p is MapPoint => Boolean(p))
      .map((p) => ({ id: p.id, coord: p.coord, text: p.name, sticky: true }));
    this.labels.show([...items, ...this.unitLabels]);
  }

  /** ずらし込み後の座標。詳細を開いたときに寄せる先として使う */
  coordOf(id: string): [number, number] | null {
    return this.points.find((p) => p.id === id)?.coord ?? null;
  }

  /**
   * 選択した点へ寄せる。
   * @param obscuredRight 右側が詳細パネルで隠れている幅(px)。
   *   そのぶん左にずらして、見えている範囲の真ん中に点が来るようにする。
   */
  flyTo(coord: [number, number], obscuredRight = 0): void {
    this.map.easeTo({
      center: coord,
      zoom: Math.max(this.map.getZoom(), 3.6),
      offset: [-obscuredRight / 2, 0],
      duration: 600,
    });
  }

  /** いまの視点。詳細を閉じたときに戻すため、寄る前に控えておく */
  view(): CameraView {
    const c = this.map.getCenter();
    return { center: [c.lng, c.lat], zoom: this.map.getZoom() };
  }

  /** 控えておいた視点へ戻す */
  easeToView(v: CameraView): void {
    this.map.easeTo({ center: v.center, zoom: v.zoom, offset: [0, 0], duration: 600 });
  }

  /**
   * 詳細を開いたあとで利用者が自分で地図を動かしたか。
   * 動かしたのなら閉じたときに戻さない（せっかく見ている場所を奪わないため）。
   * 自前の easeTo と手の操作は originalEvent の有無で見分ける。
   */
  hasUserMoved(): boolean {
    return this.userMoved;
  }
  clearUserMoved(): void {
    this.userMoved = false;
  }
}

export type CameraView = { center: [number, number]; zoom: number };

const emptyFc = () => ({ type: 'FeatureCollection' as const, features: [] });

/** その日に「進行中」か（単日のものはその日だけ） */
const isOn = (p: MapPoint, date: string): boolean => p.start <= date && date <= (p.end ?? p.start);

/** 2 進行中 / 1 直近 / 0 それ以前 */
function phaseOf(p: MapPoint, date: string, windowDays: number): 0 | 1 | 2 {
  if (isOn(p, date)) return 2;
  const d = toDayNumber(date);
  const end = toDayNumber(p.end ?? p.start);
  return d - end <= windowDays ? 1 : 0;
}
