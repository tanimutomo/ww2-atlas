# データスキーマ（P0）

正本は `data/**/*.yaml`。`scripts/build-data.mjs` が結合・検証して `public/data/*.json` を出す。
全レコード共通フィールド:

| field | 値 | 意味 |
|---|---|---|
| `id` | string | Event は Wikidata QID（`Q12345`）。Decision は `dec-YYYYMMDD-slug`、HomeFront は `hf-YYYYMMDD-slug` |
| `license` | `pd` / `cc0` / `cc-by-sa` / `noncommercial` / `link-only` | **必須**。ビルドでファイルを分ける根拠 |
| `sources` | `[{title, url, note?}]` | 一次・二次の出典。`link-only` のレコードは本文を保存せず要約と URL のみ |
| `verified` | bool | 人が原典で確認したか。LLM 下書きは必ず `false` |

## Event（現場・地図に出す）`data/events/`

- `data/raw/wikidata-events.json` — `fetch-wikidata.mjs` の生出力（CC0）。手で編集しない
- `data/events/selection.yaml` — P0 で採用する QID のリスト（`- Q12345`）。ここに無いものは出さない
- `data/events/overrides/*.yaml` — QID ごとの補正・追記（配列）

```yaml
- id: Q12345
  name_ja: ミッドウェー海戦        # Wikidata の ja ラベルを上書きしたい時だけ
  type: naval                      # battle | invasion | naval | air_raid | siege | surrender | uprising | landing
  theatre: pacific                 # europe_west | europe_east | mediterranean | pacific | china | atlantic | africa
  start: 1942-06-04
  end: 1942-06-07
  coord: [177.4, 30.0]             # [lon, lat]
  actors: [jp, us]                 # actors.yaml の id
  outcome: allied_victory          # axis_victory | allied_victory | inconclusive
  summary_ja: ...                  # 2〜3 文。自前で書く
  significance: 3                  # 1〜3。地図の点の大きさ・タイムライン密度の重み
  license: cc0
  verified: false
  sources: [{title: ..., url: ...}]
```

Wikidata から自動で埋まるもの: `name_ja` `name_en` `coord` `start` `end` `wikipedia_ja` `wikipedia_en` `participants`。override が勝つ。

## Decision（司令部・地図に出さない）`data/decisions/*.yaml`

```yaml
- id: dec-19401218-weisung-21
  type: directive        # conference | directive | order | diplomatic_note | declaration | treaty | imperial_conference
  name_ja: 総統指令第21号（バルバロッサ作戦）
  name_en: Führer Directive No. 21 (Case Barbarossa)
  date: 1940-12-18       # 会議は start/end も可
  end: null
  actors: [de]           # 国コード。会議は複数
  persons: [ヒトラー]
  place: ベルリン          # 任意。coord は持たない（地図に出さない）
  summary_ja: 何を決めたか 2〜4 文
  decisions_ja: [箇条書き 1〜5]
  license: pd
  verified: false
  sources: [{title: ..., url: ...}]
```

## HomeFront（国内・地図に出さない）`data/homefront/*.yaml`

```yaml
- id: hf-19420610-daihonei-midway
  type: announcement     # announcement | press | newsreel | life | opinion | policy
  country: jp
  date: 1942-06-10
  headline_ja: 大本営発表「ミッドウェー海戦で空母1隻喪失、敵空母2隻撃沈」
  body_ja: 要約 1〜3 文。原文は転載しない（license: link-only のとき）
  license: link-only
  verified: false
  sources: [{title: JACAR C16120676900, url: ...}]
```

## Link `data/links.yaml`

```yaml
- from: dec-19401218-weisung-21
  to: Q83233                        # バルバロッサ作戦
  relation: authorizes              # authorizes | triggers | responds_to | decided_at | reports
  note_ja: 根拠メモ 1 文
- from: hf-19420610-daihonei-midway
  to: Q47493
  relation: reports
  discrepancy:                      # relation: reports のときだけ
    claimed_ja: 空母1隻喪失・敵空母2隻撃沈
    actual_ja: 空母4隻喪失・敵空母1隻
    kind: own_losses_understated    # own_losses_understated | enemy_losses_overstated | omitted | euphemism | accurate
```

## Actor `data/actors.yaml`

`id`（`jp` `de` `it` `us` `uk` `su` `fr` `cn` …）、`name_ja`、`faction`（`axis` | `allied` | `neutral`）、`color`。

## Territory `data/territory/`

- `keyframes.yaml` — 日付リスト（P0 は四半期）
- `<YYYY-MM-DD>.geojson` — OHM（CC0）から取得・簡略化済み。Feature properties: `ohm_id` `name` `name_ja?` `start_date` `end_date`
- `faction-map.yaml` — `ohm_id` or `name` → `control`（`axis` | `axis_occupied` | `allied` | `allied_occupied` | `neutral` | `su`）。地図の塗り分けはこれで決める

## ライセンス区画（ビルド出力）

`public/data/` に `events.json` `decisions.json` `homefront.json` `links.json` `actors.json` `territory/<date>.geojson` `sources.json`（帰属一覧）。
`license: cc-by-sa` のレコードは `*.cc-by-sa.json` に分けて出す。`data/seed-wikipedia/` 配下は全部 `cc-by-sa`。
