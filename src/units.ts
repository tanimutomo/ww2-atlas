// 部隊配置レイヤー（P2-a）。
//
// 作戦の節目ごとの「スナップショット」を、駒のかたちで地図に重ねる。
//
// 設計上の約束ごとが 4 つある:
//   ① 補間しない。date <= 今 < until のスナップショットだけを出す。
//      間を埋めると、読み取っていない位置を描いたことになる
//   ② 友軍=青・敵軍=赤 の NATO 配色は使わない。どちらの視点かを決めることになるので、
//      駒は「その国の色」（actors.yaml）で塗る
//   ③ **向きが分かっている駒は五角形（尖った側が向き）、分からない駒は四角**。
//      向き不明を五角形で描くと、読み取っていない向きを描いたことになる
//   ④ 大きさは規模（軍集団＞軍＞軍団＞師団＞連隊）。名前は触れるか押したときだけ
//
// ⚠ 当初は milsymbol で APP-6 の記号を出していたが、20 個並べると細かすぎて読めず、
//   「戦況図の駒」に寄せた。規模は記号ではなく大きさで表す。

import type { Map as MlMap } from 'maplibre-gl';

export type Echelon = 'army_group' | 'army' | 'corps' | 'division' | 'regiment';

export interface UnitSnapshot {
  id: string;
  unit: string;
  name_ja: string;
  side: string;
  echelon: Echelon;
  date: string;
  until: string;
  coord: [number, number];
  heading?: number | null;
  event: string;
  source_map: { title: string; url: string; sheet?: string };
  license: string;
  verified: boolean;
}

export interface Movement {
  id: string;
  unit: string;
  from_date: string;
  to_date: string;
  path: [number, number][];
  kind: 'advance' | 'retreat' | 'transfer';
  event: string;
  source_map: { title: string; url: string; sheet?: string };
  license: string;
  verified: boolean;
}

// 駒の幅（px）。規模の差が一目で分かる程度に開けてある
const ECHELON_SIZE: Record<Echelon, number> = {
  army_group: 30,
  army: 25,
  corps: 21,
  division: 17,
  regiment: 14,
};

export const ECHELON_JA: Record<Echelon, string> = {
  army_group: '軍集団',
  army: '軍',
  corps: '軍団',
  division: '師団',
  regiment: '連隊',
};

/**
 * 地図が暗いので、国の色をそのままだと沈む。明度を上げて使う。
 * （面の塗りと違って駒は小さいので、同じ色では読めない）
 */
export function brighten(hex: string, amount = 0.25): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => mix(c).toString(16).padStart(2, '0')).join('')}`;
}

/** 駒 1 つぶんの画像の id。同じ見た目は 1 枚だけ焼いて使い回す */
export function iconId(color: string, echelon: Echelon, heading?: number | null): string {
  const dir = typeof heading === 'number' ? Math.round(heading) : 'x';
  return `unit:${color}:${echelon}:${dir}`;
}

interface Baked {
  id: string;
  /** 画像の中心から実際の位置までのずれ。駒は中心が位置なので常に 0 */
  offset: [number, number];
}

/**
 * 駒を canvas に焼いて map に登録する。
 *
 * 向きが分かっていれば五角形（尖った側が向き）、分からなければ四角。
 * **向き不明を五角形で描かない**のは、読み取っていない向きを描いたことに
 * なるため。回しても画像から食み出さないよう、画布は駒の対角より大きく取る。
 */
export function bakeIcon(
  map: MlMap,
  color: string,
  echelon: Echelon,
  heading?: number | null,
): Baked {
  const id = iconId(color, echelon, heading);
  const offset: [number, number] = [0, 0];
  if (map.hasImage(id)) return { id, offset };

  const w = ECHELON_SIZE[echelon];
  const half = w / 2;
  const box = Math.ceil(w * 1.55);
  const ratio = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  const canvas = document.createElement('canvas');
  canvas.width = box * ratio;
  canvas.height = box * ratio;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { id, offset };
  ctx.scale(ratio, ratio);
  ctx.translate(box / 2, box / 2);
  if (typeof heading === 'number') ctx.rotate((heading * Math.PI) / 180);

  ctx.beginPath();
  if (typeof heading === 'number') {
    // 五角形。上が尖っている（回す前は北を向く）
    ctx.moveTo(0, -half * 1.15);
    ctx.lineTo(half, -half * 0.3);
    ctx.lineTo(half, half * 0.85);
    ctx.lineTo(-half, half * 0.85);
    ctx.lineTo(-half, -half * 0.3);
  } else {
    ctx.rect(-half, -half * 0.85, w, half * 1.7);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#0b1017';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  map.addImage(id, { width: img.width, height: img.height, data: new Uint8Array(img.data) }, {
    pixelRatio: ratio,
  });
  return { id, offset };
}

/** その日に出すスナップショット（補間しない・重なりはビルドで弾いてある） */
export function snapshotsOn(all: UnitSnapshot[], date: string, eventId: string | null): UnitSnapshot[] {
  if (!eventId) return [];
  return all.filter((u) => u.event === eventId && u.date <= date && date < u.until);
}

/** その日に出す移動（配置と同じく、開いている戦闘のものだけ） */
export function movementsOn(all: Movement[], date: string, eventId: string | null): Movement[] {
  if (!eventId) return [];
  return all.filter((m) => m.event === eventId && m.from_date <= date && date <= m.to_date);
}

/** 線の終端の向き（度・北が 0）。矢じりを回すのに使う */
export function endBearing(path: [number, number][]): number {
  const [x1, y1] = path[path.length - 2] ?? path[0];
  const [x2, y2] = path[path.length - 1];
  const dx = (x2 - x1) * Math.cos(((y1 + y2) / 2) * (Math.PI / 180));
  const dy = y2 - y1;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** 移動の矢じり。色ごとに 1 枚焼く（icon-color は SDF 画像にしか効かない） */
export function bakeArrowhead(map: MlMap, color: string): string {
  const id = `unit-arrow:${color}`;
  if (map.hasImage(id)) return id;
  const ratio = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  const px = 14;
  const canvas = document.createElement('canvas');
  canvas.width = px * ratio;
  canvas.height = px * ratio;
  const ctx = canvas.getContext('2d');
  if (!ctx) return id;
  ctx.scale(ratio, ratio);
  // 上向き（北）の三角。icon-rotate で進行方向に回す
  ctx.beginPath();
  ctx.moveTo(px / 2, 1);
  ctx.lineTo(px - 1.5, px - 2);
  ctx.lineTo(px / 2, px - 5);
  ctx.lineTo(1.5, px - 2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#0b1017';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  map.addImage(id, { width: img.width, height: img.height, data: new Uint8Array(img.data) }, {
    pixelRatio: ratio,
  });
  return id;
}
