// 右ペインのフィード。
//
// 以前は「当日 ±N 日」を毎回描き直していたので、再生するとカードが入れ替わって
// 流れを追えなかった。ここでは SNS のタイムラインと同じく、
// **その日までに起きたことを新しい順に積み上げる**。再生すると上に足されていく。
//
// 各レコードには「アカウント」を割り当てる。大本営・総統大本営・御前会議・
// ホワイトハウス・米各紙・銃後の暮らし … といった発信主体で、
// 誰が何を言っている／決めている／やられているのかが縦に並ぶ。
//
// アカウントはレコードの actors / country / type から導く（データ側に持たせていない）。
// 明示したくなったら YAML に account: を足して、ここで優先すればよい。

import {
  DISCREPANCY_LABEL,
  THEATRE_LABEL,
  TYPE_LABEL,
  formatJa,
  type Atlas,
  type Decision,
  type EventRec,
  type HomeFront,
} from './data';
import { avatarSvg, hasFlag, type AvatarSpec } from './flags';

export type FeedKind = 'field' | 'command' | 'home';

export type Account = {
  name: string;
  handle: string;
  color: string;
  role: string;
  /** アイコン。原則その国の当時の国旗 */
  avatar: AvatarSpec;
};

export type FeedEntry = {
  id: string;
  date: string;
  kind: FeedKind;
  account: Account;
  title: string;
  body: string | null;
  /** 「発表と実態に差」など、カードに出す小さな印 */
  flags: string[];
};

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const GREY = '#8fa0ae';

/** 司令部レコードの発信主体 */
function commandAccount(atlas: Atlas, d: Decision): Account {
  const first = d.actors?.[0];
  const color = (first && atlas.actorById.get(first)?.color) || GREY;
  const many = (d.actors?.length ?? 0) > 1;

  const flag = (a?: string): AvatarSpec =>
    a && hasFlag(a) ? { type: 'flag', actor: a } : { type: 'initials' };

  if (d.type === 'imperial_conference') {
    return { name: '御前会議', handle: 'gozen_kaigi', color, role: '日本・最高意思決定', avatar: flag('jp') };
  }
  if (first === 'jp' && d.type === 'order') {
    return { name: '大本営', handle: 'daihonei', color, role: '日本・統帥部', avatar: flag('jp') };
  }
  if (first === 'de' && (d.type === 'directive' || d.type === 'order')) {
    return { name: '総統大本営', handle: 'fuhrer_hq', color, role: 'ドイツ・OKW', avatar: flag('de') };
  }
  if (d.type === 'conference') {
    // 複数国の会談なのでどこか 1 国の旗にはしない
    return {
      name: '連合国首脳会談',
      handle: 'allied_summit',
      color,
      role: '米英ソ・合同参謀本部',
      avatar: { type: 'glyph', glyph: 'table' },
    };
  }
  if (d.type === 'treaty' || d.type === 'declaration') {
    const who = (d.actors ?? []).map((a) => atlas.actorById.get(a)?.name_ja ?? a).join('・');
    return {
      name: many ? '政府間の宣言・条約' : who,
      handle: 'declaration',
      color,
      role: who,
      avatar: many ? { type: 'glyph', glyph: 'table' } : flag(first),
    };
  }
  const who = (d.actors ?? []).map((a) => atlas.actorById.get(a)?.name_ja ?? a).join('・');
  return { name: who || '司令部', handle: 'command', color, role: '司令部', avatar: flag(first) };
}

/** 国内レコードの発信主体 */
function homeAccount(atlas: Atlas, h: HomeFront): Account {
  const color = atlas.actorById.get(h.country)?.color ?? GREY;
  const country = atlas.actorById.get(h.country)?.name_ja ?? h.country;

  const avatar: AvatarSpec = hasFlag(h.country)
    ? { type: 'flag', actor: h.country }
    : { type: 'initials' };

  if (h.country === 'jp') {
    if (h.type === 'announcement') {
      return { name: '大本営発表', handle: 'daihonei_happyo', color, role: '日本・公式発表', avatar };
    }
    return { name: '銃後の暮らし', handle: 'jp_life', color, role: '日本・生活と統制', avatar };
  }
  if (h.country === 'us') {
    if (h.type === 'press') {
      return { name: '米各紙 1 面', handle: 'us_press', color, role: 'アメリカ・報道', avatar };
    }
    if (h.type === 'announcement') {
      return { name: 'ホワイトハウス', handle: 'whitehouse', color, role: 'アメリカ・公式発表', avatar };
    }
    return { name: '大統領演説', handle: 'potus', color, role: 'アメリカ・世論', avatar };
  }
  return { name: `${country}の国内`, handle: h.country, color, role: '国内', avatar };
}

/** 現場レコードの発信主体は「戦場そのもの」に見立てる */
function fieldAccount(atlas: Atlas, e: EventRec): Account {
  const first = e.actors?.[0];
  const color = (first && atlas.actorById.get(first)?.color) || '#e8c26a';
  return {
    name: THEATRE_LABEL[e.theatre] ?? '戦場',
    handle: `front_${e.theatre}`,
    color,
    // 戦域には国旗を当てない（交戦の場であって 1 国のものではない）
    role: '現場・戦況',
    avatar: { type: 'glyph', glyph: 'front' },
  };
}

/** 全レコードをフィードの投稿に均す */
export function buildFeed(atlas: Atlas): FeedEntry[] {
  const entries: FeedEntry[] = [];

  for (const e of atlas.events) {
    entries.push({
      id: e.id,
      date: e.start,
      kind: 'field',
      account: fieldAccount(atlas, e),
      title: e.name_ja,
      body: e.summary_ja,
      flags: [TYPE_LABEL[e.type] ?? e.type],
    });
  }

  for (const d of atlas.decisions) {
    const drives = (atlas.linksOf.get(d.id) ?? []).filter(
      (l) => l.from === d.id && l.relation === 'authorizes',
    ).length;
    entries.push({
      id: d.id,
      date: d.date,
      kind: 'command',
      account: commandAccount(atlas, d),
      title: d.name_ja,
      body: d.summary_ja ?? null,
      flags: drives ? [`動かした作戦 ${drives}`] : [],
    });
  }

  for (const h of atlas.homefront) {
    const disc = (atlas.linksOf.get(h.id) ?? []).find((l) => l.discrepancy)?.discrepancy;
    entries.push({
      id: h.id,
      date: h.date,
      kind: 'home',
      account: homeAccount(atlas, h),
      title: h.headline_ja,
      body: h.body_ja ?? null,
      flags: disc ? [DISCREPANCY_LABEL[disc.kind] ?? '発表と実態に差'] : [],
    });
  }

  // 新しい順。同じ日なら 現場 → 司令部 → 国内（起きた順に近い並び）
  const rank: Record<FeedKind, number> = { field: 0, command: 1, home: 2 };
  entries.sort((a, b) =>
    a.date === b.date ? rank[a.kind] - rank[b.kind] : a.date < b.date ? 1 : -1,
  );
  return entries;
}

/**
 * その日までの投稿を新しい順に描く。
 * @param since これより後の投稿を「新着」として光らせる（再生中に何が増えたか分かるように）
 */
export function renderFeed(
  entries: FeedEntry[],
  date: string,
  kinds: Set<FeedKind>,
  since: string | null,
  limit = 80,
): string {
  const visible = entries.filter((e) => e.date <= date && kinds.has(e.kind));
  if (!visible.length) {
    return `<p class="empty">まだ何も起きていません。タイムラインを進めるか、章を選んでください</p>`;
  }
  const shown = visible.slice(0, limit);
  const rows = shown
    .map((e) => {
      const isNew = since !== null && e.date > since && e.date <= date;
      const flags = e.flags
        .map((f) => `<span class="post-flag">${esc(f)}</span>`)
        .join('');
      const body = e.body
        ? `<p class="post-body">${esc(e.body.replace(/\n+/g, ' ').trim())}</p>`
        : '';
      return `<li class="post kind-${e.kind}${isNew ? ' is-new' : ''}">
        <button class="post-btn" data-id="${esc(e.id)}">
          <span class="post-avatar" style="--c:${esc(e.account.color)}" title="${esc(e.account.role)}">${avatarSvg(
            e.account.avatar,
            e.account.color,
            e.account.name.slice(0, 2),
          )}</span>
          <span class="post-main">
            <span class="post-head">
              <b class="post-name">${esc(e.account.name)}</b>
              <span class="post-handle">@${esc(e.account.handle)}</span>
              <time class="post-date">${esc(formatJa(e.date))}</time>
            </span>
            <span class="post-title">${esc(e.title)}</span>
            ${body}
            ${flags ? `<span class="post-flags">${flags}</span>` : ''}
          </span>
        </button>
      </li>`;
    })
    .join('');
  const more =
    visible.length > shown.length
      ? `<li class="post-more">これより前の ${visible.length - shown.length} 件は省略（タイムラインを戻すと出ます）</li>`
      : '';
  return `<ul class="feed">${rows}${more}</ul>`;
}


/** 何かが起きた日だけを古い順に並べる（空の日を飛ばして進むため） */
export function eventDays(entries: FeedEntry[]): string[] {
  return [...new Set(entries.map((e) => e.date))].sort();
}

/** その日に何件あるか */
export function countOn(entries: FeedEntry[], date: string): number {
  return entries.reduce((n, e) => (e.date === date ? n + 1 : n), 0);
}
