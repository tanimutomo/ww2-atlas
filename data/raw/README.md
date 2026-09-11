# data/raw ― 取得したままの外部データ

スクリプトが外部から取ってきたものを置く場所です。**加工前**のものだけが入ります。

| 中身 | 取得 | 出どころ | ライセンス | git |
|---|---|---|---|---|
| `wikidata-events.json` | `npm run fetch:wikidata` | Wikidata | CC0 1.0 | 追跡する |
| `ohm/` | `npm run fetch:territory` | OpenHistoricalMap（Overpass） | CC0 1.0 | 無視する |
| `commons/` | `npm run fetch:control` | Wikimedia Commons | パブリックドメイン | 無視する |
| `cache/` | 各スクリプト | 上記の中間キャッシュ | 元と同じ | 無視する |

`wikidata-events.json` だけを追跡しているのは、これが無いと
`npm run check` が通らない＝CI が回らないからです（1.4MB・CC0）。
残りは再取得できるうえに大きい（`ohm/` は数百 MB）ので無視しています。

## commons/ に入るもの

Wikimedia Commons の「Second World War Europe MM YYYY de.svg」41 枚
（1939-08〜1942-12）。作者は利用者 San Jose、**パブリックドメイン**として
公開されています。ファイル自体は再配布せず、必要なら取り直してください。

```bash
npm run fetch:control     # 41 枚を取得して data/territory/control/ を作る
```

出典ページ: <https://commons.wikimedia.org/wiki/Category:Maps_of_World_War_II>

なぜこの系列を使えるのかは README の「支配領域の 3 層」を参照。
SVG の `<metadata>` に GMT の投影指定が残っていたので、
手でトレースせず逆投影で取り込めています（誤差 1.5km 前後）。

## ohm/ に入るもの

OpenHistoricalMap の Overpass から取った政体境界。
「公開されているものは特記なき限りパブリックドメイン（CC0）」という方針で、
実際に使っている relation にも `license=CC0-1.0` が付いています。

希望されている表記:
> Map data courtesy of the OpenHistoricalMap project, in the public domain unless otherwise noted.
