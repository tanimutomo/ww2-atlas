# ww2-atlas ― Claude Code 向けのメモ

第二次世界大戦（1937–1945）の日本語・時系列世界地図。
**現場（地図）× 司令部（決定）× 国内（発表・報道）** の 3 層を 1 本のタイムラインで同期する。

使い方・ライセンス・貢献のしかたは [README.md](README.md) と
[CONTRIBUTING.md](CONTRIBUTING.md) にある。ここには**コードに手を入れるときに
知らないと事故るところ**だけを書く。

## 約束ごと（破るとビルドが落ちる／静かに壊れる）

- **データの正本は `data/**/*.yaml`。** `npm run data` で `public/data/` を生成する。
  生成物はコミットしない（`.gitignore` 済み）
- **レコードは必ず `license` と `sources` を持つ。** 無いと `npm run data` が落ちる
- **転載不可のソース**（防衛研究所・有料新聞・NHK・Bundesarchiv 映像）は
  **本文を保存しない**。日付・自前要約・URL の 3 点だけ（`license: link-only`）
- **Wikipedia 由来のテキストは `data/seed-wikipedia/` に隔離**（CC BY-SA）。
  自前要約（CC BY 4.0）と同じファイルに混ぜない。出力も別ファイルに分けてある
- **LLM 下書きの要約は `verified: false`。** 一次史料の全文に当たったときだけ `true`
- 静的サイト（Vite + MapLibre GL）。サーバも DB も無い。タイルサーバも使わない

## 現在地

| 層 | 件数 |
|---|---|
| 現場 Event | 493（Wikidata 2,060 件から選別） |
| 司令部 Decision | 101 |
| 国内 HomeFront | 40 |
| つながり Link | 84（うち discrepancy 付き 30） |
| 前線ライン | 16（**概略**） |
| フィードの要約 | 493（自前 16・Wikipedia 由来 477） |

**`verified: true` は 634 件中 14 件。** 残りは LLM 下書きか Wikipedia 由来。
出典 URL 732 件は `npm run check:sources` で到達確認済み。

## 支配領域は 3 層ある（ここを取り違えない）

精度がまるで違うものを重ねている。**②だけが実測相当。**

1. **政体境界**（`data/territory/geometry.json` ＋ `frames/`）― OHM。国境しか持たない
2. **軍事的支配**（`data/territory/control/`）― Commons の月次図を逆投影。
   ヨーロッパ 1939-08〜1942-12・**誤差 1.5km**
3. **導出した概略**（`data/territory/approx/`）― 1943 年以降と中国。
   `frontlines.yaml` と `approx-zones.yaml` から `npm run build:approx` が作る。
   **数十 km 単位**。輪郭を引かず、上に前線の破線を重ねるのが「概略」の合図

③が下の①と混ざって紫にならないよう、混色済みの色（`src/data.ts` の `APPROX_COLOR`）を
不透明で塗っている。ここを半透明に戻すと色が壊れる。

## 踏むと厄介な落とし穴

- **js-yaml の既定スキーマは `1940-12-18` を JS の `Date` に変換する。**
  YAML の読み込みは必ず `scripts/lib/yamlio.mjs`（CORE_SCHEMA）を通す
- **Wikidata の日付を `wdt:` で取ると年精度のものが 1/1 に丸まる。**
  日付と精度は必ず同じ statement から採る（別々に集計すると嘘の組み合わせができる）
- **OHM の Overpass は `[date:...]`（attic）では何も返らない。**
  `start_date` / `end_date` タグに `(if:...)` をかける
- **OHM に日付ごとに `out geom` を投げない**（1 日付 100MB 超）。
  日付ごとは `out tags` だけ、geometry は relation 単位で 1 回取ってキャッシュする
- **Commons の月次 SVG の月レイヤ id は決め打ちできない。**
  変化の無い月は `C_1940_06_07` のように 2 か月まとまっている。
  決め打ちするとその月だけ「占領地がほぼ無い」静かに間違った地図が出る
- **mapshaper の `-simplify 1%` は「頂点の 1% を残す」。**
  clip の後にかけると切り出した形が数点の箱になる
- **出典 URL を書いたのに実在しない、が一番たちの悪い壊れ方。**
  史料を書いたら `npm run check:sources` を必ず走らせる
- **ja.wikisource の詔書は旧字**（`大東亞戰爭終結ノ詔書`）。新字は 404
- **Wikidata の日本語ラベルは当てにならない。** 名前が文になっていたり
  （「1939年12月18日のこと」）、記事の中身と食い違っていたり（「バリクパパン攻防戦」の
  記事が Battle of Palembang）する。上書きは `data/events/overrides/fixes.yaml`

## 公開の方針

**OSS として 2 段階で公開する（2026-09-11 決定）。**

- **Stage 1（済）** ― ライセンス 3 本・README 日英・CONTRIBUTING・Issue テンプレ・CI を
  整えてリポを public に。**サイトは noindex のまま**で、誰にも知らせない
- **Stage 2（未・別途 GO が要る）** ― レコード毎の「未検証」バッジと
  「この記述を訂正する」Issue リンクを画面に付ける → 主要 50 件を verified に →
  noindex を外す → 1 回だけ発信する

Stage 2 に入る条件は「訂正導線が画面にあること」。verified の件数は条件にしない
（それを増やすためのループなので）。
