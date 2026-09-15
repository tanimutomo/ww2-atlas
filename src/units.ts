// 部隊配置レイヤー（P2-a）。
//
// 作戦の節目ごとの「スナップショット」を NATO 記号（APP-6）で地図に重ねる。
// milsymbol（MIT）で SVG を作り、canvas に焼いて map.addImage する。
//
// 設計上の約束ごとが 3 つある:
//   ① 補間しない。date <= 今 < until のスナップショットだけを出す。
//      間を埋めると、読み取っていない位置を描いたことになる
//   ② 友軍=青・敵軍=赤 の NATO 配色は使わない。どちらの視点かを決めることになるので、
//      記号は単色にして、枠を「その国の色」（actors.yaml）で塗る
//   ③ 向きは記号を回さず、NATO の作法どおり別に矢印を出す（milsymbol の direction）

import ms from 'milsymbol';
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

// SIDC の 12 文字目（2525C の規模）。大きい順
const ECHELON_SIDC: Record<Echelon, string> = {
  army_group: 'L',
  army: 'K',
  corps: 'J',
  division: 'I',
  regiment: 'G',
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
 * （面の塗りと違って記号は線が細いので、同じ色では読めない）
 */
export function brighten(hex: string, amount = 0.3): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => mix(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 記号の大きさは規模で変える。数字は milsymbol の size（おおよそ枠の高さの px）。
 * 師団を基準に、上の規模ほど大きくする。常時 20 個前後が同時に出るので、
 * 地図が記号で埋まらない範囲に抑えてある。
 */
const ECHELON_SIZE: Record<Echelon, number> = {
  army_group: 22,
  army: 19,
  corps: 16,
  division: 13,
  regiment: 11,
};

/** 位置を指す三角。コマの下に付けて、どの地点の話かを外さないようにする */
const POINTER_H = 5;
const POINTER_W = 8;

/** 記号 1 つぶんの画像の id。同じ見た目は 1 枚だけ作って使い回す */
export function iconId(color: string, echelon: Echelon, heading?: number | null): string {
  const dir = typeof heading === 'number' ? Math.round(heading) : 'x';
  return `unit:${color}:${echelon}:${dir}`;
}

interface Baked {
  id: string;
  /** 画像の中心から、記号の足元（実際の位置）までのずれ。icon-offset に渡す */
  offset: [number, number];
}

/**
 * milsymbol の記号を canvas に焼いて map に登録する。
 * 向きの矢印が付くと絵の外形が上下に伸びるので、記号の基準点が画像の中心から
 * ずれる。そのぶんを icon-offset で戻さないと、部隊が座標からずれて見える。
 */
export function bakeIcon(
  map: MlMap,
  color: string,
  echelon: Echelon,
  heading?: number | null,
): Baked {
  const id = iconId(color, echelon, heading);
  // 記号の中身は指定しない（`U------` ＝ 種別不明）。
  // 軍・軍団までしか読めない図から兵種を決め打ちする根拠が無いので、枠と規模だけにする。
  // 色は所属を問わず同じ扱いにして、陣営色をそのまま流し込む
  //（Friend を青・Hostile を赤にする NATO の配色は、どちらの視点かを決めてしまう）
  const sym = new ms.Symbol(`SFGPU------${ECHELON_SIDC[echelon]}---`, {
    size: ECHELON_SIZE[echelon],
    fill: true,
    colorMode: { Friend: color, Hostile: color, Neutral: color, Unknown: color, Civilian: color, Suspect: color },
    outlineColor: '#0b1017',
    outlineWidth: 2,
    infoColor: '#0b1017',
    ...(typeof heading === 'number' ? { direction: heading } : {}),
  });
  const anchor = sym.getAnchor();
  const size = sym.getSize();
  // 三角のぶんだけ下に伸ばした絵にする。指す先（三角の先端）が実際の位置なので、
  // icon-offset で「絵の中心 → 三角の先端」のずれを打ち消す
  const w = Math.ceil(size.width);
  const h = Math.ceil(size.height) + POINTER_H;
  const tipX = anchor.x;
  const tipY = h;
  const offset: [number, number] = [w / 2 - tipX, h / 2 - tipY];
  if (map.hasImage(id)) return { id, offset };

  const ratio = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * ratio);
  canvas.height = Math.ceil(h * ratio);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(ratio, ratio);
    ctx.drawImage(sym.asCanvas(ratio) as HTMLCanvasElement, 0, 0, size.width, size.height);
    ctx.beginPath();
    ctx.moveTo(tipX - POINTER_W / 2, h - POINTER_H);
    ctx.lineTo(tipX + POINTER_W / 2, h - POINTER_H);
    ctx.lineTo(tipX, h);
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
  }
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
