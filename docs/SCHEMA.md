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

  値は 2 通り書ける。OHM は多くの政体を日付で版分けしているので（ギリシャ・ベルギー・ルーマニアなど）、
  期間指定が要るのは「同じ relation のまま陣営が変わった国」（ノルウェー・オランダ・米国など）だけ。

  ```yaml
  by_ohm_id:
    2692712: axis            # 単一の値
    2851798:                 # 期間で変わる場合（keyframe 日付以下で最後に当たった控えを採る）
      - { control: allied }
      - { control: axis_occupied, from: 1940-06-10 }
      - { control: allied, from: 1945-05-08 }
  ```

## ライセンス区画（ビルド出力）

`public/data/` に `events.json` `decisions.json` `homefront.json` `links.json` `actors.json` `territory/<date>.geojson` `sources.json`（帰属一覧）。
`license: cc-by-sa` のレコードは `*.cc-by-sa.json` に分けて出す。`data/seed-wikipedia/` 配下は全部 `cc-by-sa`。


## ビルドと検証

| コマンド | 何をするか |
|---|---|
| `npm run fetch:wikidata` | Wikidata から戦闘・作戦を取得 → `data/raw/wikidata-events.json`（`--refresh` で引き直し） |
| `npm run fetch:territory` | OHM から keyframes 各日付の境界を取得 → `data/territory/<date>.geojson` |
| `npm run data` | YAML を結合・検証して `public/data/` を生成 |
| `npm run check` | 検証だけ（書き出さない）。`--strict` で警告も失敗にする |
| `npm run check:sources` | `sources[].url` を実際に叩いて切れリンクを洗う |
| `npm run build` | `npm run data` ＋ Vite ビルド |

`npm run data` は次のときにビルドを落とす:

- レコードに `license` / `sources` / `verified` が無い
- 未知の `license` / `type` / `theatre` / `outcome` / `actor` / `control`
- Link の `from` / `to` が存在しない、または重複している
- `discrepancy` が `relation: reports` 以外に付いている
- `data/seed-wikipedia/` 配下が `cc-by-sa` 以外
- `selection.yaml` の QID が raw にも override にも無い（座標が決まらない）

`faction-map.yaml` に控えの無い政体は警告として一覧され、`neutral` 扱いで出力される。

## 取得スクリプトの実測メモ（P0 で踏んだところ）

- **Wikidata**: `wdt:P31/wdt:P279*` を本体クエリに書くと必ず timeout する。逆にクラス条件を外して
  `wdt:P361+` だけにすると 502。先にサブクラス集合（296 件）を引いて、本体では 16 件ずつ
  `VALUES` で与えるのが通る形。付加情報（参加者・sitelink・親・勝者）は QID を `VALUES` で
  直接渡して 80 件ずつ引く
- **日付**: `P580`（開始日）だけだと真珠湾・広島・ドーリットル空襲が落ちる。単日で終わる事件は
  `P585`（時点）しか持たないので両方を受ける
- **座標**: 必須にするとバルバロッサ・ポーランド侵攻・フランス侵攻のような「点を持たない作戦・戦役」が
  丸ごと落ちる。取り込みでは OPTIONAL にして、地図に出す代表点は override で与える
- **OHM**: 日付ごとに `out geom;` を投げると 1 日付 100MB 超になる。日付ごとは `out tags;` だけにして、
  geometry は relation id ごとに 1 回取って簡略化してキャッシュする（`data/raw/ohm/` は gitignore）
- **YAML**: js-yaml の既定スキーマは `1940-12-18` を JS の `Date` に変換してしまう。
  日付を文字列のまま扱うため、読み込みは必ず `scripts/lib/yamlio.mjs` を通す（CORE_SCHEMA）
