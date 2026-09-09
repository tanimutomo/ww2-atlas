// 地図（現場レイヤー）。MapLibre GL JS。
//
// タイルサーバは使わない。Natural Earth の陸地と、ビルド済みの領域 GeoJSON、
// イベント点をすべてローカルの GeoJSON ソースとして持つ。オフラインでも動く。
//
// 領域は日付キーフレームのステップ表示（補間しない）。
// イベント点は「その日に進行中のもの」だけを filter 式で出し分ける。

import maplibregl, { type Map as MlMap, type GeoJSONSource } from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { CONTROL_COLOR, TYPE_COLOR, type Atlas, type EventRec, isActive, isNear, keyframeFor } from './data';
import { MapLabels, type LabelItem } from './labels';

const BASE = import.meta.env.BASE_URL ?? '/';

const OCEAN = '#152029';
const LAND = '#2b3238';

export class AtlasMap {
  readonly map: MlMap;
  private atlas: Atlas;
  /** ohm_id → 幾何。日付をまたいで共有するので 1 回だけ読む */
  private geometry: Record<string, Geometry> | null = null;
  /** 組み立て済みの日付フレーム */
  private territoryCache = new Map<string, FeatureCollection>();
  private currentKeyframe: string | null = null;
  private onSelect: (e: EventRec) => void;
  private labels: MapLabels | null = null;
  /** 前回の描画で「進行中」だったイベント。増えたぶんにだけ名前を出す */
  private prevActive = new Set<string>();
  private stickyId: string | null = null;

  constructor(container: HTMLElement, atlas: Atlas, onSelect: (e: EventRec) => void) {
    this.atlas = atlas;
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
    this.map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution:
          'Natural Earth (PD) / OpenHistoricalMap (CC0) / Wikidata (CC0)',
      }),
      'bottom-right',
    );
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
      if (!id) return;
      const rec = this.atlas.events.find((x) => x.id === id);
      if (rec) this.onSelect(rec);
    });
    for (const layer of ['events-dot']) {
      this.map.on('mouseenter', layer, () => (this.map.getCanvas().style.cursor = 'pointer'));
      this.map.on('mouseleave', layer, () => (this.map.getCanvas().style.cursor = ''));
    }
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

    // その日までに起きたことは消さずに残す。
    // 消してしまうと「どのあたりで何が積み重なったか」が読めなくなるので、
    // 3 段階に落として、古いものほど小さく薄くする。
    //   2 進行中     … いちばん大きく、まわりに光を出す
    //   1 直近に終了 … 中くらい
    //   0 それ以前   … 小さな痕跡。集まると「濃い地域」として見える
    const feats = this.atlas.events
      .filter((e) => e.coord && e.start <= date && filters.theatres.has(e.theatre))
      .map((e) => {
        const active = isActive(e, date);
        const recent = !active && isNear(e, date, filters.windowDays);
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: e.coord as [number, number] },
          properties: {
            id: e.id,
            significance: e.significance,
            color: TYPE_COLOR[e.type] ?? '#e8c26a',
            phase: active ? 2 : recent ? 1 : 0,
          },
        };
      });
    (this.map.getSource('events') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: feats,
    });

    this.refreshLabels(date, filters);
  }

  /**
   * 名前ラベルの出し分け。
   *   - その日に「新しく始まった」ものだけを一時的に出す（全部出すと埋まる）
   *   - 選択中のものは出したままにする
   */
  private refreshLabels(date: string, filters: { theatres: Set<string> }): void {
    if (!this.labels) return;
    const active = this.atlas.events.filter(
      (e) => e.coord && isActive(e, date) && filters.theatres.has(e.theatre),
    );
    const activeIds = new Set(active.map((e) => e.id));

    const items: LabelItem[] = active
      // 前回まで進行中でなかった＝この日に始まったもの
      .filter((e) => !this.prevActive.has(e.id))
      // 一度に出しすぎないよう、重要なものから
      .sort((a, b) => b.significance - a.significance)
      .slice(0, 6)
      .map((e) => ({ id: e.id, coord: e.coord as [number, number], text: e.name_ja }));

    if (this.stickyId) {
      const sel = this.atlas.events.find((e) => e.id === this.stickyId);
      if (sel?.coord) {
        const already = items.find((i) => i.id === sel.id);
        if (already) already.sticky = true;
        else items.push({ id: sel.id, coord: sel.coord as [number, number], text: sel.name_ja, sticky: true });
      }
    }

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

  /** 選択・リンク先のハイライト。先頭が選択中のもので、その名前は出したままにする */
  highlight(ids: string[]): void {
    this.map.setFilter('events-highlight', ['in', ['get', 'id'], ['literal', ids]]);
    this.stickyId = ids[0] ?? null;
    if (!this.labels) return;
    // ハイライトされた点すべてに名前を出す（リンク先がどれか分かるように）
    const items = ids
      .map((id) => this.atlas.events.find((e) => e.id === id))
      .filter((e): e is EventRec => Boolean(e?.coord))
      .map((e) => ({
        id: e.id,
        coord: e.coord as [number, number],
        text: e.name_ja,
        sticky: true,
      }));
    this.labels.show(items);
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
}

const emptyFc = () => ({ type: 'FeatureCollection' as const, features: [] });
