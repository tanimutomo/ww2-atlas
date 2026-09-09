# ww2-atlas

第二次世界大戦（1937–1945）の日本語・時系列世界地図。**現場（地図）× 司令部（年表）× 国内（発表・報道・生活）** の 3 層を 1 本のタイムラインで同期する。

- 設計の正本: vault `10_Thinking/2026-09-09-WW2-時系列世界地図サイト-設計.md`
- データスキーマ: `docs/SCHEMA.md`（レコードは必ず `license` と `sources` を持つ）
- データ正本は `data/**/*.yaml`。`npm run data` で `public/data/` を生成。生成物はコミットしない
- 転載不可・要申請のソース（防衛研究所・有料新聞・NHK・Bundesarchiv 映像）は **本文を保存しない**。日付・自前要約・URL のみ（`license: link-only`）
- Wikipedia 由来テキストは `data/seed-wikipedia/` に隔離（`cc-by-sa`）
- LLM 下書きの要約は `verified: false`。原典確認したときだけ `true` にする
- 静的サイト（Vite + MapLibre GL）。サーバ・DB なし。Vercel にデプロイ
