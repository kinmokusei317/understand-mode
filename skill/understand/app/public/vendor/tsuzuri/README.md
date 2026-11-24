# vendor/tsuzuri

tsuzuri（https://github.com/MaryCache/tsuzuri）から取り込んだ同梱ファイル。

- 元のリポジトリ: https://github.com/MaryCache/tsuzuri
- 取り込んだ版: `61e346b5d491b6b25b9b4be28f9496fdfc14789a`（MIT、`LICENSE` は元リポジトリの全文）
- `words.tsv` … `skills/tsuzuri/references/words.tsv` をそのまま写したもの（語をそろえる校正辞書。「探す形 / 直す先 / 補足」のタブ区切り。探す形は正規表現）
- `intent-quality.md` … `skills/tsuzuri/references/intent-quality.md` をそのまま写したもの（執筆意図の質の確認。推敲の依頼に同封する参考資料）

## 使い方（範囲）

取り込みの範囲はこの2ファイルとライセンスだけ。tsuzuri 本体のスキル・閲覧アプリ・サーバーは含めない。

- `words.tsv` は本筋カードの「Tsuzuriで推敲」ノート内の「語の候補」が読む（自動では置き換えない）
- `intent-quality.md` は `POST /api/tsuzuri/revise` が、推敲の依頼のたびに読んでプロンプトに同封する
  （`推敲の参考（Tsuzuri「執筆意図の質の確認」）:` の見出しの下に、ファイル全文をそのまま載せる）

推敲の依頼は AI（Claude か Codex）を呼ぶため、普段どおり費用がかかり得る。
