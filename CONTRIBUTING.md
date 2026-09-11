# 直し方

間違いを見つけてもらうために公開しています。歓迎します。

ただし、このリポジトリには**受け取れる修正と受け取れない修正**があります。
先にそこを書きます。

---

## 受け取れるもの / 受け取れないもの

### ✅ 受け取ります

- **一次史料の URL を添えた事実の訂正**
  日付・地名・座標・名前・数字・「どの決定がどの作戦を動かしたか」
- 一次史料に当たって `verified: true` に上げる PR（いちばんありがたい）
- 明らかな誤字・リンク切れ・コードのバグ
- 「この出典は原本ではなく孫引きだ」という指摘

### ❌ 受け取れません

- **根拠の URL が無い修正**。「間違っている」だけでは直せません
- **解釈・評価・意義づけ**。「〜は正当だった」「〜は失敗だった」は入れません
  （何が起きたかは書きます。どう評価するかは書きません）
- **転載できない資料の本文**。詳しくは下の「転載不可のもの」
- 出典が個人ブログ・まとめサイト・生成 AI の出力のもの

論争になりやすい主題（南京・大本営発表・降伏の扱いなど）については、
**一次史料の URL があるかどうかだけで判断**します。議論には乗りません。

---

## 誤りを報告する

[Issue テンプレート「誤りの報告」](../../issues/new?template=error-report.yml)を使ってください。

必要なのは 3 つです。

1. **レコードの id** ― `Q173034` / `dec-19401218-weisung-21` / `hf-19420610-daihonei-midway` など。
   地図の点や右のカードをクリックすると詳細に出ます
2. **何が間違っているか** ― 現在の記述と、正しい記述
3. **根拠の一次史料 URL** ― 官報・条約集・公文書・Avalon Project・Wikisource・
   国立国会図書館デジタルコレクション・FRUS など

## PR を送る

```bash
npm ci
npm run check          # 検証だけ（書き出さない）
npm run check:sources  # 出典 URL に実際に到達できるか
```

**この 2 つを通らない PR はマージできません。** CI でも同じものが走ります。

直すのは `data/**/*.yaml` です。`public/data/` は生成物なので触らないでください
（`.gitignore` に入っています）。

### `verified: true` に上げるとき

これがいちばん価値のある変更です。手順は:

1. 一次史料の**全文**に当たる（要約や解説記事ではなく）
2. 日付と、レコードの `summary_ja` / `decisions_ja` の中身が合っているか確かめる
3. `sources` にその URL を足す。何の文書かが分かる `title` を付ける
4. `verified: true` にする

合っていなければ、先に本文を直してください。

### 書き方の約束

- **事実と解釈を分ける。** 要約には「何が起きたか」だけを書きます
- **断定的な因果を書かない。** つながり（`links.yaml`）の `note_ja` には
  「なぜそう結びつけたか」の根拠を書き、「Aが原因でBが起きた」とは書きません
- **日付は `YYYY-MM-DD`。** 年や月までしか分からないものは入れません
  （Wikidata の年精度の日付が 1 月 1 日に化けるので、機械的に弾いています）
- **座標は `[経度, 緯度]`** の順です。逆にするとビルドが落ちます

## 転載不可のもの

著作権や利用条件で本文を持てない資料があります。これらは

**日付・自前の要約・原本の URL の 3 点だけ**

を持ち、`license: link-only` を付けます（現在 23 件）。本文は入れないでください。

Wikipedia 由来のテキストは `data/seed-wikipedia/` にだけ置きます。
CC BY-SA なので、自前の要約（CC BY 4.0）と**同じファイルに混ぜないでください**。
出力も別ファイルに分けています。

## ライセンスへの同意

CLA は取りません。**PR を送った時点で、その内容を**

- `data/seed-wikipedia/` への変更は **CC BY-SA 4.0**
- それ以外のデータへの変更は **CC BY 4.0**
- コードへの変更は **MIT**

**で提供することに同意したもの**とみなします。詳しくは [data/LICENSE](data/LICENSE)。

## 運営について

正直に書いておきます。

- メンテナンスは 1 人でやっています。**返事のできない Issue があります**
- CI を通らない PR は、説明なしに閉じることがあります
- 機能追加の提案より、**事実の訂正**のほうが確実に扱われます

---

# Contributing (English)

This repository is public so that errors get found. Contributions are welcome,
with one hard rule: **corrections must carry a URL to a primary source.**
"This is wrong" without a source cannot be acted on.

**Accepted**: factual corrections with a primary-source URL; pull requests that
raise a record to `verified: true` after checking the full text of a primary
source (the most valuable kind); typos, dead links, code bugs.

**Not accepted**: changes without a source URL; interpretation, evaluation or
significance ("this was justified", "this was a failure") — the data records
what happened, not how to judge it; the body text of material that cannot be
reproduced; sources that are personal blogs, aggregator sites, or LLM output.

On contested subjects the only test applied is whether a primary-source URL is
present. Debates are not entered into.

**Before opening a PR**, run `npm run check` and `npm run check:sources`. CI
runs both; a pull request that fails them cannot be merged. Edit
`data/**/*.yaml` — `public/data/` is generated and gitignored.

**Conventions**: keep facts and interpretation separate; do not assert causation
in link notes (record *why you connected them*, not "A caused B"); dates are
`YYYY-MM-DD` only (records known only to a year or month are excluded);
coordinates are `[longitude, latitude]`.

**Licensing**: no CLA. By opening a pull request you agree to contribute under
CC BY-SA 4.0 for `data/seed-wikipedia/`, CC BY 4.0 for other data, and MIT for
code.

**Maintenance is one person.** Some issues will go unanswered, and pull requests
failing CI may be closed without comment.
