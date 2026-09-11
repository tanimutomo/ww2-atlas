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
  CATEGORY_COLOR,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  formatJa,
  fromDayNumber,
  loadAtlas,
  toDayNumber,
  type Atlas,
  type Control,
  type EventRec,
} from './data';
import { AtlasMap } from './map';
import { renderDetail, shift } from './ui';
import { buildFeed, countOn, eventDays, renderFeed, type FeedEntry, type FeedKind } from './feed';

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

/**
 * 再生の進み方。
 * 既定は「出来事ごと」― 何も起きていない日を飛ばし、起きた日だけを順に見せる。
 * 日・週・月の連続送りは、戦況が動いていく様子を眺めたいとき用に残す。
 */
const PLAY_MODES = [
  { id: 'events', label: '出来事ごと', days: 0 },
  { id: 'day', label: '1 日', days: 1 },
  { id: 'week', label: '1 週', days: 7 },
  { id: 'month', label: '1 月', days: 30 },
] as const;

type PlayModeId = (typeof PLAY_MODES)[number]['id'];

/** 「出来事ごと」で 1 日を何秒見せるか */
const DWELLS = [3, 5, 10];
/** 連続送りのときの 1 コマの間隔 */
const CONTINUOUS_TICK_MS = 260;

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`${sel} が見つかりません`);
  return el;
};

type State = {
  date: string;
  selected: string | null;
  /** フィードに出す層 */
  kinds: Set<FeedKind>;
  theatres: Set<string>;
  mode: PlayModeId;
  dwellSec: number;
  playing: boolean;
  windowDays: number;
  /** 直前の日付。これより後に増えた投稿を「新着」として光らせる */
  lastDate: string | null;
};

async function main(): Promise<void> {
  const atlas = await loadAtlas();

  const state: State = {
    date: '1941-06-22',
    selected: null,
    kinds: new Set<FeedKind>(['field', 'command', 'home']),
    theatres: new Set(Object.keys(THEATRE_LABEL)),
    mode: 'events',
    dwellSec: 5,
    playing: false,
    windowDays: 10,
    lastDate: null,
  };

  const feedEntries: FeedEntry[] = buildFeed(atlas);
  // 何かが起きた日だけの並び。◀ ▶ と「出来事ごと」再生はこの上を歩く
  const days: string[] = eventDays(feedEntries);

  /** date より後で最初に何かが起きた日（無ければ null） */
  const nextDay = (date: string): string | null => days.find((d) => d > date) ?? null;
  /** date より前で最後に何かが起きた日（無ければ null） */
  const prevDay = (date: string): string | null =>
    [...days].reverse().find((d) => d < date) ?? null;

  buildChrome(atlas, state);

  const atlasMap = new AtlasMap($('#map'), atlas, (id) => select(id, false));
  await atlasMap.init();

  const slider = $<HTMLInputElement>('#scrub');
  slider.min = String(toDayNumber(START));
  slider.max = String(toDayNumber(END));
  slider.value = String(toDayNumber(state.date));

  let timer: number | undefined;

  /**
   * @param flash 増えたぶんをフィードで光らせるか。
   *   1 コマ進めたとき（◀ ▶・再生）は光らせ、スライダーや章ジャンプでは光らせない。
   */
  function setDate(date: string, opts: { fromSlider?: boolean; flash?: boolean } = {}): void {
    const prev = state.date;
    state.lastDate = opts.flash && date > prev ? prev : null;
    state.date = date;
    if (!opts.fromSlider) slider.value = String(toDayNumber(date));
    $('#date-label').textContent = formatJa(date);
    const n = countOn(feedEntries, date);
    $('#day-count').textContent = n ? `この日 ${n} 件` : '';
    void atlasMap.setDate(date, { theatres: state.theatres, windowDays: state.windowDays });
    renderPane();
    renderDensity();
    syncNav();
  }

  /** 端に来たら ◀ ▶ を押せなくする */
  function syncNav(): void {
    ($('#prev-day') as HTMLButtonElement).disabled = prevDay(state.date) === null;
    ($('#next-day') as HTMLButtonElement).disabled = nextDay(state.date) === null;
  }

  /** 出来事のある日を 1 つ進む／戻る */
  function stepDay(dir: 1 | -1): void {
    const target = dir === 1 ? nextDay(state.date) : prevDay(state.date);
    if (target) setDate(target, { flash: dir === 1 });
  }

  function select(id: string | null, pan = true): void {
    state.selected = id;
    const detail = $('#detail');
    const panel = $('#detail-panel');
    if (!id) {
      panel.hidden = true;
      atlasMap.highlight([]);
      return;
    }
    panel.hidden = false;
    detail.scrollTop = 0;
    detail.innerHTML = renderDetail(atlas, id);

    // 選択したものと、そこから伸びるリンク先を地図で光らせる。
    // 司令部・国内も地図に出るようになったので、層で絞らず全部光らせる
    const related = (atlas.linksOf.get(id) ?? []).map((l) => (l.from === id ? l.to : l.from));
    atlasMap.highlight([id, ...related]);

    const coord = atlasMap.coordOf(id);
    if (coord && pan) {
      // 詳細パネルが地図の右側を覆うので、そのぶん寄せる位置をずらす
      atlasMap.flyTo(coord, panel.clientWidth);
    }

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
    const list = $('#list');
    // 新着は上に積まれるので、いちばん上を見ていたときだけ追従させる
    const wasAtTop = list.scrollTop < 24;
    list.innerHTML = renderFeed(feedEntries, state.date, state.kinds, state.lastDate);
    list
      .querySelectorAll<HTMLButtonElement>('button.post-btn')
      .forEach((b) => b.addEventListener('click', () => select(b.dataset.id!)));
    if (wasAtTop) list.scrollTop = 0;
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
    setDate(fromDayNumber(Number(slider.value)), { fromSlider: true });
  });

  $('#play').addEventListener('click', () => (state.playing ? stop() : play()));

  function play(): void {
    state.playing = true;
    $('#play').textContent = '⏸ 停止';

    if (state.mode === 'events') {
      // 出来事のある日だけを、1 日ずつ dwellSec 秒かけて見せる
      const tick = () => {
        const next = nextDay(state.date);
        if (!next) return stop();
        setDate(next, { flash: true });
      };
      tick();
      timer = window.setInterval(tick, state.dwellSec * 1000);
      return;
    }

    const stepDays = PLAY_MODES.find((m) => m.id === state.mode)?.days ?? 7;
    timer = window.setInterval(() => {
      const next = shift(state.date, stepDays);
      if (next > END) return stop();
      setDate(next, { flash: true });
    }, CONTINUOUS_TICK_MS);
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
        state.mode = b.dataset.mode as PlayModeId;
        $('#steps').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        // 表示時間の選択は「出来事ごと」のときだけ意味がある
        $('#dwells').classList.toggle('is-off', state.mode !== 'events');
        if (state.playing) {
          stop();
          play();
        }
      }),
    );

  $('#dwells')
    .querySelectorAll<HTMLButtonElement>('button')
    .forEach((b) =>
      b.addEventListener('click', () => {
        state.dwellSec = Number(b.dataset.sec);
        $('#dwells').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        if (state.playing && state.mode === 'events') {
          stop();
          play();
        }
      }),
    );

  $('#prev-day').addEventListener('click', () => {
    stop();
    stepDay(-1);
  });
  $('#next-day').addEventListener('click', () => {
    stop();
    stepDay(1);
  });

  $('#chapters')
    .querySelectorAll<HTMLButtonElement>('button')
    .forEach((b) =>
      b.addEventListener('click', () => {
        stop();
        setDate(b.dataset.date!);
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

  $('#detail-close').addEventListener('click', () => select(null));

  // 右ペインの幅をドラッグで変える。地図側は ResizeObserver が追随する
  {
    const DEFAULT = 440;
    const MIN = 300;
    const KEY = 'ww2-atlas:side-width';
    const stage = $('#stage');
    const setWidth = (px: number) => {
      // 地図が潰れないよう、ステージの幅から最低限を残す
      const max = Math.max(MIN, stage.getBoundingClientRect().width - 360);
      const w = Math.round(Math.min(max, Math.max(MIN, px)));
      document.documentElement.style.setProperty('--side', `${w}px`);
      return w;
    };
    const saved = Number(localStorage.getItem(KEY));
    if (Number.isFinite(saved) && saved > 0) setWidth(saved);

    const handle = $('#side-resizer');
    handle.addEventListener('pointerdown', (e) => {
      const ev = e as PointerEvent;
      if (ev.button !== 0) return;
      ev.preventDefault();
      handle.setPointerCapture(ev.pointerId);
      document.body.classList.add('resizing');
      const right = stage.getBoundingClientRect().right;
      const move = (m: PointerEvent) => setWidth(right - m.clientX);
      const up = () => {
        handle.releasePointerCapture(ev.pointerId);
        document.body.classList.remove('resizing');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        const now = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side'), 10);
        if (Number.isFinite(now)) localStorage.setItem(KEY, String(now));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('dblclick', () => {
      setWidth(DEFAULT);
      localStorage.removeItem(KEY);
    });
  }

  // 地図の注記。常時出しておくと地図が隠れるので、押したときだけ開く
  const notes = $('#map-notes');
  const notesToggle = $('#notes-toggle');
  const showNotes = (open: boolean) => {
    notes.hidden = !open;
    notesToggle.setAttribute('aria-expanded', String(open));
  };
  notesToggle.addEventListener('click', () => showNotes(notes.hidden));
  $('#notes-close').addEventListener('click', () => showNotes(false));

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !notes.hidden) return showNotes(false);
    if (e.key === 'Escape' && state.selected) return select(null);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      // 入力欄（スライダー）にフォーカスがあるときは邪魔しない
      if (document.activeElement instanceof HTMLInputElement) return;
      e.preventDefault();
      stop();
      stepDay(e.key === 'ArrowRight' ? 1 : -1);
    }
  });

  setDate(state.date);
  select(null);
}

/** 静的な UI 部品（凡例・章・フィルタ）を組み立てる */
function buildChrome(atlas: Atlas, state: State): void {
  $('#chapters').innerHTML = CHAPTERS.map(
    (c) => `<button data-date="${c.date}">${c.label}</button>`,
  ).join('');

  $('#steps').innerHTML = PLAY_MODES.map(
    (m) => `<button data-mode="${m.id}"${m.id === state.mode ? ' class="on"' : ''}>${m.label}</button>`,
  ).join('');

  $('#dwells').innerHTML =
    `<span class="dwell-label">1 件あたり</span>` +
    DWELLS.map(
      (sec) => `<button data-sec="${sec}"${sec === state.dwellSec ? ' class="on"' : ''}>${sec}秒</button>`,
    ).join('');
  $('#dwells').classList.toggle('is-off', state.mode !== 'events');

  $('#theatres').innerHTML = Object.entries(THEATRE_LABEL)
    .map(
      ([k, label]) =>
        `<label><input type="checkbox" value="${k}" checked> ${label}</label>`,
    )
    .join('');

  // 点の色。地図と同じ定義（CATEGORY_COLOR）を使うのでズレない
  $('#type-key').innerHTML = CATEGORY_ORDER.map(
    (c) => `<span class="tk"><i style="background:${CATEGORY_COLOR[c]}"></i>${CATEGORY_LABEL[c]}</span>`,
  ).join('');

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
