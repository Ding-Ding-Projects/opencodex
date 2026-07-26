---
title: インストール
description: opencodex(ocx)プロキシと前提条件をインストールし、正常に実行できるか確認します。
---

opencodex をインストールすると同じ実行ファイルを指す `ocx` と `opencodex` コマンドが一緒に提供されます。
対応する npm 環境では、パッケージ同梱の Go ランタイムで小さなローカル HTTP サーバーを実行します。モデルリクエストはルーティングで選ばれたプロバイダーに
転送され、必要に応じて vision とウェブ検索のサイドカーが ChatGPT ログインを使うこともあります。

## 前提条件

| 要件 | 理由 |
 --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | 小さなランチャーが macOS、Linux、Windows の amd64/x64・arm64 用 Go バイナリを検証して起動します。Bun を自分でインストールする必要は**ありません**。 |
| **[OpenAI Codex](https://openai.com/codex)**(CLI、App、または SDK) | opencodex が前に立つクライアントです。opencodex は `$CODEX_HOME/config.toml`(デフォルト `~/.codex/config.toml`)に書き込みます。 |
| プロバイダーアカウントまたは API キー | Anthropic、xAI、Kimi、Ollama Cloud、OpenRouter、OpenAI API キー、OpenAI 互換エンドポイント、または ChatGPT ログイン。 |

## インストール

```bash
npm install -g @bitkyc08/opencodex
```

:::note[Bun が引き続きインストールされる理由]
Bun 依存関係は、旧 updater、従来の Codex shim を一度だけ更新する移行処理、Bun 向け
パッケージ API を明示的に使う呼び出し元のために当面残ります。対応する 6 ターゲットの通常の
コマンドでは Bun は起動しません。未対応プラットフォームでは互換ブリッジが Bun を使う場合があり、
依存関係の削除はこれらの移行経路を廃止した後に行います。
:::

両方のコマンドが `PATH` にあることを確認します:

```bash
ocx --version
opencodex --version
```

### 配布チャネル

安定チャネルの `latest` にも ChatGPT、OpenAI API キー、OpenRouter、実験段階の Cursor 経路のための
GPT-5.6 Sol/Terra/Luna カタログ情報がすでに含まれています。ただしモデルの利用権まで付与されるわけでは
ありません。まだ正式配布されていない opencodex ビルドを試す場合のみ preview チャネルを使ってください:

```bash
npm install -g @bitkyc08/opencodex@preview
ocx update --tag preview
```

## ソースから実行

opencodex 自体を開発するには、ローカルに `bun` CLI をインストールして `PATH` に追加してください:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # 開発モードでプロキシ API を起動 (src/cli/index.ts start)
bun run dev:gui     # ダッシュボード dev サーバーを起動 (別ターミナル)
```

`bun run dev` は `bun run dev:proxy` のエイリアスとして残っています。プロキシ API は `/healthz`、
`/v1/responses`、`/api/*` を公開し、`GET /` は `bun run build:gui` が `gui/dist` を生成した
後にのみパッケージされたダッシュボードを提供します。ダッシュボードを編集する際は `bun run dev:gui` でフロントエンドを
別途実行してください。

## 生成されるもの

opencodex の状態ファイルは `$OPENCODEX_HOME`(デフォルト `~/.opencodex`)の下に、Codex 連携ファイルは
`$CODEX_HOME`(デフォルト `~/.codex`)の下に保存されます。

| パス | 用途 |
 --- | --- |
| `$OPENCODEX_HOME/config.json` | プロバイダー、デフォルトプロバイダー、ポート、オプション。 |
| `$OPENCODEX_HOME/ocx.pid` | 実行中のプロキシの PID(単一インスタンスガード)。 |
| `$OPENCODEX_HOME/runtime-port.json` | 自動で選んだ代替ポートを含む現在の PID、ホスト名、ポート。 |
| `$OPENCODEX_HOME/auth.json` | 保存された OAuth 認証情報(`ocx login` 時)。 |
| `$OPENCODEX_HOME/catalog-backup*.json` | opencodex が変更する前に作成した Codex モデルカタログのバックアップ。 |
| `$CODEX_HOME/config.toml` | ローカル専用構成では opencodex が管理するルート `openai_base_url` を追加します。ローカル以外のアドレスにバインドする場合は Codex が API 認証ヘッダーを送れるよう `model_provider = "opencodex"` と `[model_providers.opencodex]` を使います。 |
| `$CODEX_HOME/opencodex.config.toml` | デフォルト Codex 設定と一緒に生成される参考用 fallback プロファイル。 |
| `$CODEX_HOME/opencodex-catalog.json` | Codex が使うネイティブおよびルーティングモデルカタログ。 |

:::note
opencodex は決して Codex 設定を削除しません。すべての注入は元に戻せます — `ocx stop`、`ocx restore`、
または `ocx eject` は opencodex が追加した行だけを正確に削除し、ネイティブ Codex を復元します。
:::

## 次へ

[クイックスタート](/ja/getting-started/quickstart/)に進んで最初のプロバイダーを設定するか、
アーキテクチャを知るには[仕組み](/ja/getting-started/how-it-works/)をお読みください。
