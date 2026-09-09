// 地図上に出す一時的な名前ラベル。
//
// 点が光っても何なのか分からない、という問題への対応。光った直後だけ名前を出して、
// 数秒で消す。選択中のものは消さずに出し続ける。
//
// MapLibre のシンボルレイヤーは使わない ― 文字を描くには glyphs（フォント）の配信元が要り、
// 日本語だと相当な容量になる。タイルサーバを持たない方針と合わないので、
// HTML の要素を地図に重ねて map.project() で位置を合わせる。

import type { Map as MlMap } from 'maplibre-gl';

export type LabelItem = {
  id: string;
  coord: [number, number];
  text: string;
  /** true なら自動で消えない（選択中のもの） */
  sticky?: boolean;
};

const FADE_AFTER_MS = 2600;

export class MapLabels {
  private map: MlMap;
  private layer: HTMLDivElement;
  private items = new Map<string, { el: HTMLDivElement; coord: [number, number]; timer?: number }>();

  constructor(map: MlMap) {
    this.map = map;
    this.layer = document.createElement('div');
    this.layer.className = 'map-labels';
    map.getContainer().appendChild(this.layer);

    // 地図が動いたら位置を合わせ直す
    const reposition = () => this.reposition();
    map.on('move', reposition);
    map.on('zoom', reposition);
    map.on('resize', reposition);
  }

  /** ラベルを出す。すでに出ているものは寿命を延ばすだけ（点滅させない） */
  show(list: LabelItem[]): void {
    const keep = new Set(list.map((l) => l.id));
    // sticky でなくなった／対象から外れたものを消す
    for (const [id, entry] of this.items) {
      if (!keep.has(id)) {
        window.clearTimeout(entry.timer);
        entry.el.remove();
        this.items.delete(id);
      }
    }

    for (const item of list) {
      let entry = this.items.get(item.id);
      if (!entry) {
        const el = document.createElement('div');
        el.className = 'map-label';
        el.textContent = item.text;
        this.layer.appendChild(el);
        entry = { el, coord: item.coord };
        this.items.set(item.id, entry);
        // 追加直後に位置を当ててからフェードインさせる
        this.place(entry);
        requestAnimationFrame(() => el.classList.add('is-in'));
      } else {
        entry.coord = item.coord;
        entry.el.textContent = item.text;
      }

      entry.el.classList.toggle('is-sticky', Boolean(item.sticky));
      window.clearTimeout(entry.timer);
      if (!item.sticky) {
        const target = entry;
        target.timer = window.setTimeout(() => {
          target.el.classList.remove('is-in');
          window.setTimeout(() => {
            target.el.remove();
            for (const [id, e] of this.items) if (e === target) this.items.delete(id);
          }, 400);
        }, FADE_AFTER_MS);
      }
    }
    this.reposition();
  }

  clear(): void {
    for (const [, entry] of this.items) {
      window.clearTimeout(entry.timer);
      entry.el.remove();
    }
    this.items.clear();
  }

  private place(entry: { el: HTMLDivElement; coord: [number, number] }): void {
    const p = this.map.project(entry.coord);
    entry.el.style.transform = `translate(-50%, -100%) translate(${p.x}px, ${p.y - 14}px)`;
  }

  private reposition(): void {
    for (const [, entry] of this.items) this.place(entry);
  }
}
