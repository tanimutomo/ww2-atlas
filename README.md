# ww2-atlas ― 第二次世界大戦の時系列世界地図

**現場（地図）・司令部（決定）・国内（発表と報道）の 3 層を、同じ時間軸で読む**ための
日本語のデータセットとビューアです。

> ⚠️ **このデータの大半は未検証です。** 650 件のレコードのうち、一次史料に当たって
> 確認したのは **38 件だけ**。残りは LLM が下書きしたか、Wikipedia の記述に拠っています。
> **史実の典拠として引用しないでください。** 詳しくは [未検証であること](#未検証であること) を読んでください。
> このリポジトリを公開しているのは、**間違いを見つけて直してもらうため**です。

[English](#english) ｜ [データの中身](#データの中身) ｜ [ライセンス](#ライセンス) ｜
[訂正の送り方](#訂正の送り方) ｜ [動かし方](#動かし方)

---

## 何をするものか

「なぜその作戦が始まったのか」「発表と実態はどれだけ違ったのか」を、
3 つの層を同じタイムラインに並べて追えるようにしています。

- **現場** ― 戦闘・侵攻・空襲・降伏。地図の点
- **司令部** ― 総統指令・御前会議・大陸命・連合国の会談。「どこで決めたか」の点
- **国内** ― 大本営発表・米紙 1 面・配給と生活

3 層は **つながり（Link）** で結んであります。たとえば

- 総統指令第 21 号（1940-12-18）→ **authorizes** → バルバロッサ作戦（1941-06-22）
- 大本営発表（1942-06-10）→ **reports** → ミッドウェー海戦
  … 発表は「空母 1 隻喪失」、実際は 4 隻。この差を `discrepancy` として構造化

## データの中身

| 層 | 件数 | 中身 |
|---|---:|---|
| 現場 Event | 493 | Wikidata 2,060 件から選別。名前・座標・日付は CC0 |
| 司令部 Decision | 101 | 独 24・日 25・連合 26・ソ 11・伊 7・その他 8 |
| 国内 HomeFront | 40 | 大本営発表 20・米報道 10・生活 10 |
| つながり Link | 84 | うち「発表と実態の差」30 |
| 前線ライン | 16 | **概略**。地図のトレースではない |
| フィードの要約 | 493 | 自前 17 ＋ Wikipedia 由来 476 |

出典 URL は **756 件すべて到達を確認**しています（`npm run check:sources`）。

### 支配領域の 3 層

地図の面はひとつではありません。**精度がまるで違う 3 つを重ねています。**

| | 範囲 | 出どころ | 精度 |
|---|---|---|---|
| ① 政体境界 | 全期間・全世界 | OpenHistoricalMap の 36 キーフレーム | 国境のみ。占領地域は含まない |
| ② 軍事的支配 | ヨーロッパ 1939-08〜1942-12 | Wikimedia Commons の月次図 41 枚を逆投影 | **誤差 1.5km。ここだけ実測相当** |
| ③ 導出した概略 | 1943 年以降のヨーロッパ・中国の全期間 | 前線の折れ線と範囲指定から切り出し | **数十 km 単位** |

②が取り込めたのは、元の SVG が GMT で描かれていて `<metadata>` に投影指定
（`pscoast -R-10/30/80/60r -JL15/0/45/60/15c`）が残っていたからです。
図中の都市点 14 個で係数を当てると RMSE 0.46px＝約 1.5km で逆投影できました。
手でトレースするより正確です。

③は「1943 年以降のソ連が無傷に見える」「中国大陸が 8 年間まったく塗り分けられない」
という別の嘘を避けるための補完で、**実測ではありません**。地図では輪郭を引かず、
上に前線の破線を重ねて「ここは概略」を示しています。

## 未検証であること

各レコードは `verified` という真偽値を持ちます。

- `verified: true` ― **一次史料の全文を読んで**、日付と中身が要約と合うことを確認した
- `verified: false` ― LLM の下書きか、Wikipedia などの二次情報に拠っているだけ

**現在 650 件中 38 件のみが `true`** です（司令部 29・現場 5・国内 4）。
`true` にしてあるのは、たとえば

- 米國及英國ニ對スル宣戰ノ詔書（官報号外 1941-12-08・国立国会図書館デジタルコレクション）
- 大東亞戰爭終結ノ詔書（官報号外 1945-08-14）
- ハル・ノート／独の対米宣戦布告／三国単独不講和協定（Avalon Project の全文）
- 独の降伏文書 2 通・日本の降伏文書・ヴァンゼー議定書
- 原爆投下命令（NARA ARC 542193 の原文）

画面上部に「未確認 612」と実数を出し、各レコードの詳細にも
「未検証／原典確認済み」のバッジを出しています。隠していません。

**原典に当たると、記述のほうが間違っていることがあります。** これまでに
ミュンヘン協定の「4 か国で保障する」（付属文書では独伊の保障が条件付き）、
絶対国防圏の「圏外の要地は持久」（原文にない）など 3 件を訂正しました。
会談系（カサブランカ・ダンバートンオークスなど）は公表された共同声明に
「決定内容は発表しない」としか書かれておらず、FRUS を読まないと確認できません。
カサブランカは確認できた範囲を `note` に書いて `verified: false` のままにしてあります。

**このリポジトリを公開している目的は、この 38 件を増やすことです。**

## 訂正の送り方

間違いを見つけたら **Issue を立ててください**。
[誤りの報告テンプレート](../../issues/new?template=error-report.yml)があります。

必要なのは 3 つだけです。

1. レコードの id（`Q173034`、`dec-19401218-weisung-21` など）
2. 何が間違っているか
3. **根拠になる一次史料の URL**

PR も歓迎します。ただし **3 の無い修正は受け取れません**。
理由と、その他の約束ごとは [CONTRIBUTING.md](CONTRIBUTING.md) にあります。

> メンテナンスは 1 人でやっています。**返事のできない Issue があります。**
> CI を通らない PR は説明なしに閉じることがあります。ご容赦ください。

## ライセンス

**3 本立てです。**混ざらないように置き場を分けてあります。

| 対象 | ライセンス |
|---|---|
| コード（`src/` `scripts/` `index.html`） | **MIT** → [LICENSE](LICENSE) |
| 自前で書いたデータ（要約・選別・概略面・前線・faction-map） | **CC BY 4.0** → [data/LICENSE](data/LICENSE) |
| Wikipedia 由来の要約（`data/seed-wikipedia/`） | **CC BY-SA 4.0** |
| 外部の生データ（Wikidata・OpenHistoricalMap・Commons） | 元のまま（CC0 / PD） |

Wikipedia 由来のぶんは出力ファイルも `event-summaries.cc-by-sa.json` として
分離しています。**再配布するときに本体と混ぜないでください。**

転載できない資料は本文を持たず、日付・自前の要約・URL の 3 点だけにしています
（`license: link-only`・23 件）。

出典の一覧はビルド時に `public/data/sources.json` へ自動生成されます。

## 動かし方

Node.js 20 以上。

```bash
npm ci
npm run data     # data/**/*.yaml → public/data/*.json（検証つき）
npm run dev      # 開発サーバ
```

`npm run data` は**検証を兼ねています**。`license` か `sources` の無いレコード、
未知の enum、リンク切れ（存在しない id を指すつながり）があるとビルドが落ちます。

```bash
npm run check          # 書き出さずに検証だけ
npm run check:sources  # 出典 URL 756 件に実際に到達できるか確認（数分かかる）
```

外部からの取得は済んでいるので普段は不要です。引き直したいときだけ:

```bash
npm run fetch:wikidata    # Wikidata SPARQL（10 分ほど・キャッシュあり）
npm run fetch:territory   # OpenHistoricalMap Overpass
npm run fetch:control     # Commons の月次図 41 枚 → 逆投影
npm run fetch:summaries   # 日本語版 Wikipedia のリード文
npm run build:approx      # 前線と範囲 → 概略の面
```

データの形は [docs/SCHEMA.md](docs/SCHEMA.md) にあります。

## 出典

- [Wikidata](https://www.wikidata.org/) ― 出来事の名前・座標・日付（CC0）
- [OpenHistoricalMap](https://www.openhistoricalmap.org/) ― 時点指定の政体境界（CC0）
  > Map data courtesy of the OpenHistoricalMap project, in the public domain unless otherwise noted.
- [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:Maps_of_World_War_II) ―
  「Second World War Europe MM YYYY de.svg」（作者 San Jose・PD）
- [Natural Earth](https://www.naturalearthdata.com/) ― ベースマップの陸と海（PD）
- Wikipedia 日本語版・英語版 ― フィードの要約（CC BY-SA 4.0）
- 一次史料 ― Avalon Project、Wikisource、国立国会図書館デジタルコレクション、FRUS ほか

タイルサーバは使っていません。地図はすべてローカルの GeoJSON です。

---

# English

**A Japanese-language dataset and viewer that reads the Second World War in three
synchronised layers**: the field (a map), the high command (decisions), and the
home front (announcements and press).

> ⚠️ **Most of this data is unverified.** Of 650 records, only **38** have been
> checked against primary sources. The rest are LLM drafts or rest on Wikipedia.
> **Do not cite this as a historical authority.** This repository is public so
> that people can find the errors and fix them.

## What it does

Three layers on one timeline, joined by explicit links — for example
*Führer Directive No. 21 (1940-12-18) → **authorizes** → Operation Barbarossa*,
or *Imperial General Headquarters communiqué (1942-06-10) → **reports** →
Battle of Midway*, where the announcement claimed one carrier lost and the
actual figure was four. That gap is stored as a structured `discrepancy`.

Contents: 493 events, 101 decisions, 40 home-front records, 84 links,
16 (approximate) front lines, and a short summary on every event.
All 756 source URLs are checked for reachability.

**Territory comes from three layers of very different accuracy**: political
boundaries from OpenHistoricalMap (36 keyframes, borders only); military
control for Europe 1939-08→1942-12, reverse-projected from 41 public-domain
Commons maps (RMSE 0.46 px ≈ 1.5 km — the only measured layer); and a derived
approximation for 1943 onward and for China (tens of kilometres, drawn without
outlines to signal that it is a sketch).

## Contributing

Found an error? Open an issue using the
[error report template](../../issues/new?template=error-report.yml). Three
things are needed: the record id, what is wrong, and **a URL to a primary
source**. Corrections without the third are not accepted. See
[CONTRIBUTING.md](CONTRIBUTING.md).

This is maintained by one person. Some issues will go unanswered, and pull
requests that fail CI may be closed without comment.

## Licensing

Three licences, kept in separate directories so they do not mix:

- **Code** (`src/`, `scripts/`, `index.html`) — MIT, see [LICENSE](LICENSE)
- **Original data** (summaries, selection, approximate areas, front lines) —
  CC BY 4.0, see [data/LICENSE](data/LICENSE)
- **Wikipedia-derived summaries** (`data/seed-wikipedia/`) — CC BY-SA 4.0,
  emitted to a separate `event-summaries.cc-by-sa.json`; please keep it separate
  when redistributing
- **Third-party raw data** (Wikidata, OpenHistoricalMap, Commons) — under their
  original CC0 / public-domain terms

## Running it

Node.js 20+. `npm ci && npm run data && npm run dev`. `npm run data` doubles as
validation: it fails on a record without `license` or `sources`, an unknown
enum value, or a link pointing at an id that does not exist.
