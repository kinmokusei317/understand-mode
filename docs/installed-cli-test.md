# インストールしたアプリで CLI ログインを確認する

macOS / Linux、Node.js 18 以上が対象。リポジトリのルートから実行する。`npm install` やサーバーの事前起動は不要。

```sh
node --check dev/test-installed-login.js
node dev/test-installed-login.js
```

既定はローカルの偽 CLI。実際のログイン情報やモデルは使わない。インストール先の違いも検査するため、次の順で別々の一時 `HOME` にインストールし、それぞれにコピーされた `app/server.js` を起動する。

| 順 | インストール | 質問の宛先 |
| --- | --- | --- |
| 1 | `bash install.sh --codex` → `.agents/skills/understand` | `codex` / `gpt-6.2-terra` |
| 2 | `bash install.sh` → `.claude/skills/understand` | `claude` / `haiku` |

## 実ログインで確認するときだけ

```sh
node dev/test-installed-login.js --live
```

このコマンドは、実際に各モデルに質問する。契約の利用枠や料金が発生しうる。環境変数では実行を切り替えられない。実行するシェルの `PATH` に本物の `codex` と `claude` を置き、あらかじめ通常の ChatGPT / Claude アカウントでログインしておく。テストはログイン操作を行わない。

両方の検査が終わり、片方だけ失敗した場合は、失敗した側だけを再試行できる。モデルや質問は変更できない。

```sh
node dev/test-installed-login.js --live codex
node dev/test-installed-login.js --live claude
```

サーバーの `HOME`、ボード、作業ディレクトリは空の一時ディレクトリから始める。どちらの CLI も空の作業ディレクトリで動かす。認証ファイルの中身を読む・コピーする・ハードリンクする処理はテストにはない。

- **Codex:** サーバーに認証元の `CODEX_HOME`（既定 `~/.codex`）を知らせる。CLI は別の一時 `CODEX_HOME` を使い、`auth.json` だけをシンボリックリンクで参照する。
- **Claude:** 認証の更新先が変わらないよう、CLI は元の `CLAUDE_CONFIG_DIR`（既定 `~/.claude`）を直接使う。別のホームに `.credentials.json` をリンクしない。ログイン確認も質問も `--safe-mode --setting-sources ''` で実行する。

偽 CLI では、この使い分けと空の作業ディレクトリ、質問の標準入力に固定文しかないことを確認する。認証元もテスト専用で、実際の親セッションやプロジェクトは使わない。実ログイン時も環境の API キー、接続先の上書き、ツール設定、モック指定は引き継がない。

両モードとも、使い捨てサーバーの `GET /api/providers` に対象とモデルが載っていることを確認してから、`POST /api/cli-question` に次のいずれか一件だけを送る。

```json
{"provider":"codex","model":"gpt-6.2-terra","question":"Reply exactly OK","anchor":""}
```

```json
{"provider":"claude","model":"haiku","question":"Reply exactly OK","anchor":""}
```

固定の架空の会話 ID を使い、実際の親スレッドは探さない。質問にファイル名やボードの内容は入れない。成功条件は `ok: true` かつ `text` の前後の空白を除いた値が `OK`。別モデルや `/api/ask` には切り替えない。

通常は一方が失敗してももう一方を試し、両方が `PASS` のときだけ終了コード `0`。再試行は選んだ側だけを判定する。`FAIL ... setup:` はインストール・起動・API の失敗。`FAIL ... provider:` はログイン、モデル利用不可、利用上限などの固定の分類だけを示す。CLI が失敗した場合と、成功と返したのに本文が `OK` でない場合は区別する。未導入・未ログイン・モデル利用不可をスキップしない。認証情報、アカウント名、URL、ホームのパス、標準エラーや応答本文は表示しない。各回の終了時と通常の中断時は、自分が起動したサーバーに終了を求めて待ち、一時ディレクトリを片付ける。
