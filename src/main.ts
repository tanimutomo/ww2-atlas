// 3 ペイン（地図・右ペイン・タイムライン）の組み立てと同期。
//
// 状態は「いま何日か」と「何を選んでいるか」の 2 つだけ。
// 日付が変われば 3 ペインが揃い、選択が変われば地図のハイライトと詳細が揃う。

// CSS は index.html から <link> で読む。
// JS 経由（import './style.css'）だと注入が地図の生成に間に合わず、
// コンテナのサイズが 0 のまま MapLibre が初期化されて描画が止まることがある。
import {
  CONTROL_COLOR,
  CONTROL_LABEL,
  THEATRE_LABEL,
  formatJa,
  fromDayNumber,
  loadAtlas,
  toDayNumber,
  type Atlas,
  type Control,
  type EventRec,
} from './data';
import { AtlasMap } from './map';
import { renderDetail, renderList, shift } from './ui';

const START = '1937-07-07';
const END = '1945-09-02';

/** タイムラインの章ジャンプ */
const CHAPTERS: { label: string; date: string }[] = [
  { label: '日中戦争', date: '1937-07-07' },
  { label: '開戦', date: '1939-09-01' },
  { label: '西方電撃戦', date: '1940-05-10' },
  { label: '独ソ戦', date: '1941-06-22' },
  { label: '太平洋', date: '1941-12-08' },
  { label: 'ミッドウェー', date: '1942-06-05' },
  { label: 'スターリングラード', date: '1942-11-19' },
  { label: 'ノルマンディー', date: '1944-06-06' },
  { label: '終戦', date: '1945-08-15' },
];

const PLAY_STEPS = [
  { label: '1 日', days: 1 },
  { label: '1 週', days: 7 },
  { label: '1 月', days: 30 },
];

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`${sel} が見つかりません`);
  return el;
};

type State = {
  date: string;
  selected: string | null;
  tab: 'command' | 'home';
  theatres: Set<string>;
  step: number;
  playing: boolean;
  windowDays: number;
};

async function main(): Promise<void> {
  const atlas = await loadAtlas();

  const state: State = {
    date: '1941-06-22',
    selected: null,
    tab: 'command',
    theatres: new Set(Object.keys(THEATRE_LABEL)),
    step: 7,
    playing: false,
    windowDays: 10,
  };

  buildChrome(atlas, state);

  const atlasMap = new AtlasMap($('#map'), atlas, (e) => select(e.id, false));
  await atlasMap.init();

  const slider = $<HTMLInputElement>('#scrub');
  slider.min = String(toDayNumber(START));
  slider.max = String(toDayNumber(END));
  slider.value = String(toDayNumber(state.date));

  let timer: number | undefined;

  function setDate(date: string, fromSlider = false): void {
    state.date = date;
    if (!fromSlider) slider.value = String(toDayNumber(date));
    $('#date-label').textContent = formatJa(date);
    void atlasMap.setDate(date, { theatres: state.theatres, windowDays: state.windowDays });
    renderPane();
    renderDensity();
  }

  function select(id: string | null, pan = true): void {
    state.selected = id;
    const detail = $('#detail');
    if (!id) {
      detail.innerHTML = '<p class="empty">地図の点、または右のカードを選ぶと詳細が出ます</p>';
      atlasMap.highlight([]);
      return;
    }
    detail.innerHTML = renderDetail(atlas, id);

    // 選択したものと、そこから伸びるリンク先のイベントを地図で光らせる
    const related = (atlas.linksOf.get(id) ?? []).map((l) => (l.from === id ? l.to : l.from));
    atlasMap.highlight([id, ...related].filter((x) => !x.startsWith('dec-') && !x.startsWith('hf-')));

    const rec = atlas.byId.get(id);
    if (rec && pan && 'coord' in rec && rec.coord) atlasMap.flyTo(rec.coord as [number, number]);

    // 詳細の中の「つながり」ボタンで別レコードへ飛ぶ
    detail.querySelectorAll<HTMLButtonElement>('button.jump').forEach((b) => {
      b.addEventListener('click', () => {
        const target = b.dataset.id!;
        const t = atlas.byId.get(target);
        // 日付も相手に合わせる（3 ペインが揃う）
        if (t) setDate('start' in t ? t.start : t.date);
        select(target);
      });
    });
  }

  function renderPane(): void {
    $('#list').innerHTML = renderList(atlas, state.tab, state.date, state.windowDays);
    $('#list')
      .querySelectorAll<HTMLButtonElement>('button.card')
      .forEach((b) => b.addEventListener('click', () => select(b.dataset.id!)));
  }

  /** タイムライン上のイベント密度（戦域別に積む） */
  function renderDensity(): void {
    const lo = toDayNumber(START);
    const hi = toDayNumber(END);
    const buckets = 220;
    const counts = new Array(buckets).fill(0);
    for (const e of atlas.events) {
      if (!state.theatres.has(e.theatre)) continue;
      const i = Math.floor(((toDayNumber(e.start) - lo) / (hi - lo)) * (buckets - 1));
      if (i >= 0 && i < buckets) counts[i] += e.significance;
    }
    const max = Math.max(1, ...counts);
    const cur = Math.floor(((toDayNumber(state.date) - lo) / (hi - lo)) * (buckets - 1));
    $('#density').innerHTML = counts
      .map(
        (c, i) =>
          `<span class="bar${i === cur ? ' cur' : ''}" style="height:${Math.round((c / max) * 100)}%"></span>`,
      )
      .join('');
  }

  // ---- イベント配線
  slider.addEventListener('input', () => {
    stop();
    setDate(fromDayNumber(Number(slider.value)), true);
  });

  $('#play').addEventListener('click', () => (state.playing ? stop() : play()));

  function play(): void {
    state.playing = true;
    $('#play').textContent = '⏸ 停止';
    timer = window.setInterval(() => {
      const next = shift(state.date, state.step);
      if (next > END) return stop();
      setDate(next);
    }, 260);
  }
  function stop(): void {
    state.playing = false;
    $('#play').textContent = '▶ 再生';
    if (timer) window.clearInterval(timer);
  }

  $('#steps')
    .querySelectorAll<HTMLButtonElement>('button')
    .forEach((b) =>
      b.addEventListener('click', () => {
        state.step = Number(b.dataset.days);
        $('#steps').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      }),
    );

  $('#chapters')
    .querySelectorAll<HTMLButtonElement>('button')
    .forEach((b) =>
      b.addEventListener('click', () => {
        stop();
        setDate(b.dataset.date!);
      }),
    );

  $('#tabs')
    .querySelectorAll<HTMLButtonElement>('button')
    .forEach((b) =>
      b.addEventListener('click', () => {
        state.tab = b.dataset.tab as 'command' | 'home';
        $('#tabs').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        renderPane();
      }),
    );

  $('#theatres')
    .querySelectorAll<HTMLInputElement>('input')
    .forEach((cb) =>
      cb.addEventListener('change', () => {
        if (cb.checked) state.theatres.add(cb.value);
        else state.theatres.delete(cb.value);
        void atlasMap.setDate(state.date, { theatres: state.theatres, windowDays: state.windowDays });
        renderDensity();
      }),
    );

  setDate(state.date);
  select(null);
}

/** 静的な UI 部品（凡例・章・フィルタ）を組み立てる */
function buildChrome(atlas: Atlas, state: State): void {
  $('#chapters').innerHTML = CHAPTERS.map(
    (c) => `<button data-date="${c.date}">${c.label}</button>`,
  ).join('');

  $('#steps').innerHTML = PLAY_STEPS.map(
    (s) => `<button data-days="${s.days}"${s.days === state.step ? ' class="on"' : ''}>${s.label}</button>`,
  ).join('');

  $('#theatres').innerHTML = Object.entries(THEATRE_LABEL)
    .map(
      ([k, label]) =>
        `<label><input type="checkbox" value="${k}" checked> ${label}</label>`,
    )
    .join('');

  $('#legend').innerHTML = (Object.keys(CONTROL_COLOR) as Control[])
    .map(
      (k) =>
        `<span class="lg"><i style="background:${CONTROL_COLOR[k]}"></i>${CONTROL_LABEL[k]}</span>`,
    )
    .join('');

  const unverified = [...atlas.events, ...atlas.decisions, ...atlas.homefront].filter(
    (r) => !r.verified,
  ).length;
  $('#counts').textContent =
    `現場 ${atlas.events.length} ・ 司令部 ${atlas.decisions.length} ・ 国内 ${atlas.homefront.length} ・ つながり ${atlas.links.length}（未確認 ${unverified}）`;
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div class="fatal">読み込みに失敗しました: ${String(err.message ?? err)}<br><small>先に <code>npm run data</code> を実行してください</small></div>`,
  );
});
