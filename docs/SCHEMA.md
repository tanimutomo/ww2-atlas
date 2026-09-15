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

## Decision（司令部）`data/decisions/*.yaml`

⚠ 当初は「地図に出さない」方針だったが、会議・指令も **どこで決めたかが分かった方がいい**
という判断で地図に出すことにした。`coord` を必須に近い扱いで持つ（無いと警告が出て地図に出ない）。

```yaml
- id: dec-19401218-weisung-21
  type: directive        # conference | directive | order | diplomatic_note | declaration | treaty | imperial_conference
  name_ja: 総統指令第21号（バルバロッサ作戦）
  name_en: Führer Directive No. 21 (Case Barbarossa)
  date: 1940-12-18       # 会議は start/end も可
  end: null
  actors: [de]           # 国コード。会議は複数
  persons: [ヒトラー]
  place: ベルリン          # 表示用の地名
  coord: [13.405, 52.52]  # [lon, lat]。決めた場所。無いと地図に出ない
  summary_ja: 何を決めたか 2〜4 文
  decisions_ja: [箇条書き 1〜5]
  license: pd
  verified: false
  sources: [{title: ..., url: ...}]
```

## HomeFront（国内）`data/homefront/*.yaml`

こちらも地図に出す。`coord` は「発表・報道が出た場所」（大本営発表なら東京、米紙ならニューヨーク）。

```yaml
- id: hf-19420610-daihonei-midway
  type: announcement     # announcement | press | newsreel | life | opinion | policy
  country: jp
  coord: [139.7528, 35.6852]  # 発表・報道が出た場所
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

- `keyframes.yaml` — 切り出す日付のリスト。四半期＋**OHM が実際に版を分けている転換日**。
  四半期だけだと動きの速い時期が 1 コマに潰れる（1941-12〜1942-05 の南方進出が
  1942-07-01 に一気に広がって見えていた）
- `geometry.json` — `ohm_id` → 幾何。**全日付で共有する**。
  日付ごとに幾何を持つと 1 枚 1.1MB × 枚数になるので分けている
- `frames/<YYYY-MM-DD>.json` — その日に存在した政体の一覧（幾何は持たない・1 枚 30KB 前後）。
  `{date, polities: [{ohm_id, name, name_ja, name_en, admin_level, start_date, end_date}]}`

日付を増やすコストはフレーム 1 枚ぶんで済む（36 枚で計 3.8MB。旧形式なら 14 枚で 15MB だった）。
フロントは `geometry.json` を 1 回読み、フレームと突き合わせて FeatureCollection を組み立てる。
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

`public/data/` に `events.json` `decisions.json` `homefront.json` `links.json` `actors.json` `sources.json`（帰属一覧）、
および `territory/index.json` `territory/geometry.json` `territory/<date>.json`。
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


## 地図の点の分類（表示）

`src/data.ts` の `PointCategory` が正本。現場・司令部・国内を 1 つの点の集合に均している。

| 分類 | 中身 | 件数 |
|---|---|---|
| `land` | 戦闘・侵攻・包囲・上陸・蜂起 | 106 |
| `sea` | 海戦 | 34 |
| `air` | 空襲 | 10 |
| `decision` | 会議・指令・宣言・条約 ＋ **降伏・休戦** | 34 |
| `home` | 公式発表・報道・生活 | 40 |

- 戦闘を陸・海・空までしか割らないのは、種別 8 つを色にすると読めないのと、
  種別の 8 割が名前からの機械推定で細かく言い切る根拠が弱いため
- 降伏・休戦は戦闘ではなく「大きな意思決定」として `decision` に入れる
- 同じ座標に重なる点（東京に 39 件など）は、ひまわり配置で最大 1.2 度までずらして表示する。
  ずらすのは表示上の都合なので YAML の座標は動かさない

## 部隊配置の作り方（P2-a）― 3 つのファイルに分かれている

実装して分かったことが 2 つあり、設計から作り方を変えた。

**① QGIS で手作業、ではなく「画素を残して機械で変換する」。**
読み取りは「図の上のどこか」であって経緯度ではない。生の画素を残しておけば、
基準点を取り直したときに全部が自動で直る。経緯度だけ手で書くと精度を上げる手立てが消える。

```
data/units/georef/<sheet>.yaml    図ごとの基準点（地名の画素 ↔ 実座標）
data/units/readings/<op>.yaml     部隊記号の画素での読み取り（正本）
        ↓  npm run build:units（scripts/lib/affine.mjs で最小二乗）
data/units/snapshots/<op>.yaml    経緯度に直したもの（⚠ 自動生成・直接編集しない）
```

`npm run check:georef` が図ごとの残差を出す。`max_rmse_km` を超えたら落ちるので、
基準点を触って黙って精度が下がることはない。1 枚が数百 km を超える図は円錐図法の
曲がりがアフィンに収まらないので `order: 2`（2 次）にする。

**読み取りの実務（10 作戦ぶんやって効いたもの）:**

1. **精度は図の広さに比例する。** 目で読む誤差はどの図でも 6〜10 画素で変わらないので、
   実距離の誤差は「1 画素が何 km か」で決まる。ノルマンディー 0.3km/px → RMSE 1.7km、
   バルバロッサ 2.7km/px → 18km。**軍団を置いてよいのは 1km/px を切る図だけ。**
2. **概観（幅 1400）から基準点を読んではいけない。** 21km ずれる。小さく見ていると
   地名の「文字」を点と取り違える。**部隊の箱は大きいので概観でよい。**
3. **切り出しは出力幅を固定する**（`scripts/crop-sheet.py` は 1200 に揃える）。
   大きいまま出すと表示側で縮められ、読んだ画素が縮尺ぶんずれる。
4. **1 枚の画像に地図が 2 枚入っていることがある**（27・38・48）。縮尺が違うので
   変換も別。sheet 名を `…27b` のように分ける。
5. **下図が使い回されていることがある。** 19 番（バルバロッサ）と 30 番
   （バグラチオン）は都市の画素が 1 つも動いていなかった。新しい図はまず数点を
   照合すると、ジオリファレンスを 1 回まるごと省ける。
6. **軍集団・方面軍の箱は受け持ち区域**であって司令部の所在地ではない。
7. **QID は必ず引いてから書く。** とくに「英語版の記事が現代の後継部隊に転送される」型
   （ソ連第 5・第 51・第 65 軍、米第 3 軍など）。別部隊なら自前 id にする。

**② 図の記号には「位置」と「編成表」の 2 種類がある。**
地面に置いてある記号はその部隊がそこにいたことを示すが、図の外（海の上・
イギリス側）に並べてある記号は上陸予定日つきの編成表であって位置ではない。
たとえば WWIIEurope55 の UTAH/OMAHA/GOLD/JUNO/SWORD の上に並ぶ連合軍師団は
全部これなので、**採らない**。採ると「6 月 6 日に英第 7 機甲師団が海の上にいた」
という図になる。どちらなのかは図ごとに違うので、読むたびに判断が要る。

## UnitSnapshot（部隊配置・P2-a）`data/units/snapshots/*.yaml`

作戦フェーズ単位のスナップショット。West Point 史学科アトラス等の PD 状況図から**位置と向きだけをトレース**する（画像はリポに入れない）。設計: garden 設計ページ §9。

```yaml
- id: us-19440606-overlord-p1-us-first-army
  unit: Q1142417                 # Wikidata QID（無ければ 自前 id: unit-…）
  name_ja: 米 第1軍
  side: us                       # actors.yaml の id
  echelon: army                  # army | corps | division | regiment
  date: 1944-06-06               # このスナップショットの日付
  until: 1944-06-12              # 次の節目まで表示（date <= 今 < until）
  coord: [-0.85, 49.35]
  heading: 180                   # 北を 0 とした時計回りの度。不明なら null
  event: Q16470                  # 紐づく Event（作戦）
  source_map: {title: "West Point Atlas WWII Europe 51", url: https://dhc.westpoint.edu/atlases/, sheet: WWIIEurope51}
  license: pd
  verified: false
```

## Movement（部隊の移動・P2-a）`data/units/movements/*.yaml`

```yaml
- id: mv-19440606-19440612-us-first-army
  unit: Q1142417
  from_date: 1944-06-06
  to_date: 1944-06-12
  path: [[-0.85, 49.35], [-1.10, 49.20]]   # LineString [lon, lat]
  kind: advance                  # advance | retreat | transfer
  event: Q16470
  source_map: {title: ..., url: ..., sheet: ...}
  license: pd
  verified: false
```

描画: `milsymbol`（MIT）で APP-6 記号を生成し `map.addImage`。**友軍青・敵軍赤の配色は使わず**、単色記号＋陣営色の枠。表示はタイムライン日付に一致するスナップショットのみ（補間しない）。
