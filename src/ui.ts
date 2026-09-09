// 右ペイン（司令部 / 国内）と、選択したレコードの詳細の描画。
//
// 司令部・国内は地図に載せない。ここと下段のタイムラインにだけ出す。
// レコード間の移動は Link をたどる ―「この決定が動かした作戦」「当時の発表」。

import {
  DISCREPANCY_LABEL,
  RELATION_LABEL,
  THEATRE_LABEL,
  TYPE_LABEL,
  formatJa,
  type Atlas,
  type Decision,
  type EventRec,
  type HomeFront,
  type Link,
} from './data';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * リンクの見出し。同じリンクでも「どちら側から見ているか」で言い方を変える。
 * outgoing = いま見ているレコードが from 側。
 */
function directedLabel(relation: Link['relation'], outgoing: boolean): string {
  switch (relation) {
    case 'authorizes':
      return outgoing ? 'この決定が動かした作戦' : '根拠になった決定';
    case 'triggers':
      return outgoing ? 'これが動かした決定' : 'きっかけになった戦況';
    case 'responds_to':
      return outgoing ? 'これに備えた／応じた' : 'この備え・対応を促した';
    case 'decided_at':
      return outgoing ? 'ここで決まった' : 'ここで決めたこと';
    case 'reports':
      return outgoing ? '実際の戦況' : '当時の発表';
    default:
      return RELATION_LABEL[relation];
  }
}

const kindOf = (id: string): 'event' | 'decision' | 'homefront' =>
  id.startsWith('dec-') ? 'decision' : id.startsWith('hf-') ? 'homefront' : 'event';

const titleOf = (r: EventRec | Decision | HomeFront): string =>
  'headline_ja' in r ? r.headline_ja : r.name_ja;

const dateOf = (r: EventRec | Decision | HomeFront): string =>
  'start' in r ? r.start : r.date;

/** 未確認・出典・ライセンスの注記。中立性のために必ず出す */
function provenance(r: { verified: boolean; license: string; sources: { title: string; url: string }[] }): string {
  const badge = r.verified
    ? '<span class="badge ok">原典確認済み</span>'
    : '<span class="badge warn">未確認（下書き）</span>';
  const lic =
    r.license === 'link-only'
      ? '<span class="badge">本文非収録・リンクのみ</span>'
      : `<span class="badge">${esc(r.license)}</span>`;
  const src = r.sources
    .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noreferrer noopener">${esc(s.title)}</a></li>`)
    .join('');
  return `<div class="prov">${badge}${lic}<ul class="src">${src}</ul></div>`;
}

/** リンク（決定→作戦 / 発表→実態）。discrepancy があれば発表と実態を並べる */
function linkBlock(atlas: Atlas, id: string): string {
  const links = atlas.linksOf.get(id) ?? [];
  if (!links.length) return '';
  const rows = links
    .map((l: Link) => {
      const otherId = l.from === id ? l.to : l.from;
      const other = atlas.byId.get(otherId);
      if (!other) return '';
      // リンクは向きで読み方が変わる。いま見ているレコードから相手を指す言い方にする
      const outgoing = l.from === id;
      const label = directedLabel(l.relation, outgoing);
      const disc = l.discrepancy
        ? `<div class="disc">
             <div class="disc-row"><span class="disc-tag claimed">発表</span><span>${esc(l.discrepancy.claimed_ja)}</span></div>
             <div class="disc-row"><span class="disc-tag actual">実態</span><span>${esc(l.discrepancy.actual_ja)}</span></div>
             <div class="disc-kind">${esc(DISCREPANCY_LABEL[l.discrepancy.kind] ?? l.discrepancy.kind)}</div>
           </div>`
        : '';
      const note = l.note_ja ? `<div class="note">${esc(l.note_ja)}</div>` : '';
      return `<li>
        <div class="rel">${esc(label)}</div>
        <button class="jump" data-id="${esc(otherId)}">${esc(titleOf(other))}</button>
        <div class="when">${esc(formatJa(dateOf(other)))}</div>
        ${note}${disc}
      </li>`;
    })
    .join('');
  return `<div class="links"><h4>つながり</h4><ul>${rows}</ul></div>`;
}

export function renderDetail(atlas: Atlas, id: string): string {
  const r = atlas.byId.get(id);
  if (!r) return '<p class="empty">見つかりません</p>';
  const kind = kindOf(id);

  if (kind === 'event') {
    const e = r as EventRec;
    const actors = e.actors
      .map((a) => atlas.actorById.get(a))
      .filter(Boolean)
      .map((a) => `<span class="chip" style="--c:${esc(a!.color)}">${esc(a!.name_ja)}</span>`)
      .join('');
    const period = e.end && e.end !== e.start
      ? `${formatJa(e.start)} 〜 ${formatJa(e.end)}`
      : formatJa(e.start);
    const inferred = e.inferred.length
      ? `<div class="inferred">機械推定: ${esc(e.inferred.join(' / '))}（人手未確認）</div>`
      : '';
    return `
      <div class="detail">
        <div class="kicker">現場 ・ ${esc(TYPE_LABEL[e.type] ?? e.type)} ・ ${esc(THEATRE_LABEL[e.theatre] ?? e.theatre)}</div>
        <h3>${esc(e.name_ja)}</h3>
        ${e.name_en ? `<div class="sub">${esc(e.name_en)}</div>` : ''}
        <div class="when">${esc(period)}</div>
        <div class="chips">${actors}</div>
        ${e.summary_ja ? `<p>${esc(e.summary_ja)}</p>` : ''}
        ${inferred}
        ${linkBlock(atlas, id)}
        ${provenance(e)}
      </div>`;
  }

  if (kind === 'decision') {
    const d = r as Decision;
    const period = d.end && d.end !== d.date ? `${formatJa(d.date)} 〜 ${formatJa(d.end)}` : formatJa(d.date);
    const bullets = d.decisions_ja?.length
      ? `<ul class="bullets">${d.decisions_ja.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
      : '';
    const who = [d.place, d.persons?.join('・')].filter(Boolean).join(' ／ ');
    return `
      <div class="detail">
        <div class="kicker">司令部 ・ ${esc(d.type)}</div>
        <h3>${esc(d.name_ja)}</h3>
        ${d.name_en ? `<div class="sub">${esc(d.name_en)}</div>` : ''}
        <div class="when">${esc(period)}${who ? ` ・ ${esc(who)}` : ''}</div>
        ${d.summary_ja ? `<p>${esc(d.summary_ja)}</p>` : ''}
        ${bullets}
        ${linkBlock(atlas, id)}
        ${provenance(d)}
      </div>`;
  }

  const h = r as HomeFront;
  return `
    <div class="detail">
      <div class="kicker">国内 ・ ${esc(h.type)} ・ ${esc(atlas.actorById.get(h.country)?.name_ja ?? h.country)}</div>
      <h3>${esc(h.headline_ja)}</h3>
      <div class="when">${esc(formatJa(h.date))}</div>
      ${h.body_ja ? `<p>${esc(h.body_ja)}</p>` : ''}
      ${linkBlock(atlas, id)}
      ${provenance(h)}
    </div>`;
}

export const shift = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
