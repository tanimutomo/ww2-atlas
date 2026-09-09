// フィードのアイコンに使う当時の国旗（インライン SVG）。
//
// 画像ファイルは持たない。数が少なく形も単純なので SVG を直接書いた方が、
// 依存も転送量も増えず、暗い背景に合わせて調整もしやすい。
//
// ⚠ ドイツについて
//   1935 年以降の国旗にはハーケンクロイツが入るが、これは描かない。
//   ドイツでは公共の場での掲示が法律で制限されており、この図像そのものを
//   資料の飾りとして出す必要もない。代わりに 1933〜1935 年に併用された
//   黒・白・赤の三色旗（帝政期からの伝統色。戦時の軍艦旗の下地でもある）を使う。
//   「当時のドイツを指す色」としては通り、問題のある記号は出さずに済む。
//
// 人物のアイコンは置いていない。P0 のアカウントはほぼ全部が機関
//（大本営・御前会議・連合国首脳会談・ホワイトハウス…）で、個人ではないため。

/** 24×24 の円に収まる前提。viewBox は 3:2 を切り出して使う */
const FLAGS: Record<string, string> = {
  // 日章旗
  jp: `<rect width="36" height="24" fill="#f7f7f5"/><circle cx="18" cy="12" r="7" fill="#bc002d"/>`,

  // 黒・白・赤の三色旗（上のコメント参照）
  de: `<rect width="36" height="24" fill="#111"/><rect y="8" width="36" height="8" fill="#f7f7f5"/><rect y="16" width="36" height="8" fill="#c1121f"/>`,

  // イタリア王国（緑白赤。サヴォイア家の紋章は省略）
  it: `<rect width="12" height="24" fill="#237b47"/><rect x="12" width="12" height="24" fill="#f7f7f5"/><rect x="24" width="12" height="24" fill="#c1121f"/>`,

  // 星条旗（48 星時代。星は点で簡略化）
  us: `<rect width="36" height="24" fill="#f7f7f5"/>
    <g fill="#b22234"><rect y="0" width="36" height="2"/><rect y="4" width="36" height="2"/><rect y="8" width="36" height="2"/><rect y="12" width="36" height="2"/><rect y="16" width="36" height="2"/><rect y="20" width="36" height="2"/></g>
    <rect width="16" height="13" fill="#3c3b6e"/>
    <g fill="#fff"><circle cx="3" cy="3" r="1"/><circle cx="7" cy="3" r="1"/><circle cx="11" cy="3" r="1"/><circle cx="5" cy="6.5" r="1"/><circle cx="9" cy="6.5" r="1"/><circle cx="13" cy="6.5" r="1"/><circle cx="3" cy="10" r="1"/><circle cx="7" cy="10" r="1"/><circle cx="11" cy="10" r="1"/></g>`,

  // ユニオンジャック
  uk: `<rect width="36" height="24" fill="#012169"/>
    <path d="M0,0 36,24 M36,0 0,24" stroke="#f7f7f5" stroke-width="5"/>
    <path d="M0,0 36,24 M36,0 0,24" stroke="#c8102e" stroke-width="2.5"/>
    <path d="M18,0 V24 M0,12 H36" stroke="#f7f7f5" stroke-width="8"/>
    <path d="M18,0 V24 M0,12 H36" stroke="#c8102e" stroke-width="4.5"/>`,

  // ソ連（鎚と鎌は簡略化して星のみ）
  su: `<rect width="36" height="24" fill="#c1121f"/>
    <path d="M7 3.5 8.2 6.6 11.5 6.8 9 8.9 9.8 12 7 10.2 4.2 12 5 8.9 2.5 6.8 5.8 6.6Z" fill="#ffd700"/>`,

  // フランス（第三共和政・自由フランス）
  fr: `<rect width="12" height="24" fill="#002395"/><rect x="12" width="12" height="24" fill="#f7f7f5"/><rect x="24" width="12" height="24" fill="#ed2939"/>`,

  // 中華民国（青天白日満地紅）
  cn: `<rect width="36" height="24" fill="#c1121f"/><rect width="18" height="12" fill="#000095"/>
    <circle cx="9" cy="6" r="3.4" fill="#fff"/>
    <g stroke="#fff" stroke-width="1.4"><path d="M9 1.4V10.6M4.4 6h9.2M5.7 2.7l6.6 6.6M12.3 2.7l-6.6 6.6"/></g>
    <circle cx="9" cy="6" r="2.4" fill="#000095"/><circle cx="9" cy="6" r="1.9" fill="#fff"/>`,

  // オランダ・ベルギー等はまとめて汎用。必要になったら足す
};

/** 国旗を持たないアカウント用の記号 */
const GLYPHS: Record<string, string> = {
  // 現場（戦場）＝交差した刀
  front: `<g stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 8l16 16M24 8L8 24"/></g>`,
  // 会議・宣言＝円卓
  table: `<g stroke="currentColor" stroke-width="2.2" fill="none"><ellipse cx="16" cy="17" rx="10" ry="5"/><path d="M16 12V7"/></g>`,
};

export type AvatarSpec =
  | { type: 'flag'; actor: string }
  | { type: 'glyph'; glyph: keyof typeof GLYPHS }
  | { type: 'initials' };

/**
 * アバターの SVG を返す。円形にクリップして返すので、そのまま並べればよい。
 * @param color 国旗が無いときの下地色
 */
export function avatarSvg(spec: AvatarSpec, color: string, initials: string): string {
  if (spec.type === 'flag' && FLAGS[spec.actor]) {
    // 3:2 の旗を正方形の円に収める（左右を少し切る）
    return `<svg class="avatar-svg" viewBox="6 0 24 24" aria-hidden="true">${FLAGS[spec.actor]}</svg>`;
  }
  if (spec.type === 'glyph') {
    return `<svg class="avatar-svg" viewBox="0 0 32 32" aria-hidden="true" style="color:${color}">
      <rect width="32" height="32" fill="#1a252f"/>${GLYPHS[spec.glyph]}</svg>`;
  }
  return `<svg class="avatar-svg" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" fill="${color}"/>
    <text x="16" y="21" text-anchor="middle" font-size="13" font-weight="700" fill="#0d141a">${initials}</text>
  </svg>`;
}

export const hasFlag = (actor: string): boolean => actor in FLAGS;
