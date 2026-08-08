---
title: クイックスタート
description: 既存の ChatGPT/Codex ログインで opencodex を起動します。ローカル利用にプロバイダー API キーは不要です。
---

新規ローカル構成では、既存の ChatGPT/Codex ログインを転送する組み込み `openai`
プロバイダーが使われます。初回起動の前にプロバイダー API キーを用意したり、`ocx init`
を実行したりする必要は**ありません**。

## 1. プロキシを起動

```bash
ocx start            # デフォルトポート 10100
ocx start --port 8080
```

このターミナルは開いたままにしてください。起動時に opencodex は:

- 構成ファイルがなければ、キー不要の ChatGPT 転送プロバイダーを読み込み、
- PID を `~/.opencodex/ocx.pid` に記録して二重起動を拒否し、
- 利用可能なモデルを Codex のモデルカタログへ同期し、
- ローカルプロキシを Codex の構成へ可逆的に追加し、
- `http://localhost:<port>/v1` で待機します。

要求したポートが使用中なら、空きポートを `runtime-port.json` に記録し、Codex が実際の
リスナーを使うよう更新します。別のターミナルから確認またはダッシュボードを開けます:

```bash
ocx status
ocx gui
```

## 2. ChatGPT/Codex ログインを使う

Codex がすでに ChatGPT にログイン済みなら、追加設定はありません。未ログインの場合だけ、
通常の Codex ログインを一度実行します:

```bash
codex login
```

次に、実行中のプロキシへ接続済みの Codex を起動します:

```bash
ocx codex
```

`gpt-5.6-sol` などの名前空間なしモデル ID は、組み込み ChatGPT 転送経路を使います。
カタログ項目だけでは利用権は付与されないため、アカウント側にも対象モデルの権限が必要です。

## どの認証情報を求められているか

| 認証情報 | 必要な場合 | 意味 |
| --- | --- | --- |
| **ChatGPT/Codex ログイン** | デフォルトのローカル `openai` 経路 | `codex login` または Codex App が作成するアカウントセッションです。API キーではありません。 |
| **上流プロバイダーの認証情報** | 別のプロバイダーを自分で追加した場合だけ | そのプロバイダーの API キーまたは OAuth/アカウントログインです。ローカルプロバイダーは通常どちらも不要です。 |
| **OpenCodex アドミッションキー** | 非ループバック/LAN バインドへ接続するデータプレーンクライアント | `ocx host enable --new-key --yes` が生成し、`/v1/*` を保護します。プロバイダー課金用キーではなく、`localhost` では不要です。 |

クライアントが **`opencodex API key required`** と返した場合、非ループバックのリスナーへ
OpenCodex アドミッションキーなしで接続しています。`localhost` を使うか、生成済みの
アドミッションキーをそのクライアントに設定してください。プロバイダー API キーを購入・貼り付けても
このメッセージは解決しません。

## 3. 別のプロバイダーを追加する（任意）

最も簡単なのは `ocx gui` の **Add provider** です。アカウントログイン、API キー、ローカル
サーバー、またはカスタムエンドポイントを選べます。新規構成をターミナルから変更する場合だけ:

```bash
ocx init
```

**Select default provider** で <kbd>Enter</kbd> を押すと、プロバイダー **1** の
**OpenAI — ChatGPT login (no key)** が選ばれます。選択した経路に必要な情報だけが求められます:

1. **ChatGPT 転送** — API キー不要。Codex ログインを使います。
2. **アカウントログイン（OAuth）** — 保存後、表示された `ocx login <provider>` を実行します。
3. **API キープロバイダー** — その上流プロバイダーのキー、または `${ANTHROPIC_API_KEY}`
   のような環境変数参照を入力します。
4. **ローカルプロバイダー** — 通常はキーを空欄にします。
5. **プロキシと Codex 連携** — ポート、注入、自動起動 shim を選択します。

結果は `$OPENCODEX_HOME/config.json`（デフォルト `~/.opencodex/config.json`）に保存されます。

:::note[GPT-5.6 ロールアウト準備項目]
安定版 v2.7.1 は ChatGPT パススルー、OpenAI API キー、OpenRouter、実験段階の Cursor
アダプターに GPT-5.6 Sol/Terra/Luna 項目を提供します。実際に呼び出すには該当する上流
アカウントの利用権が必要です。
:::

特定のルーティングモデルは、Codex のモデルピッカーに表示される `provider/model` 形式で指定します:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

## サブエージェントモデルの選択（任意）

新規構成では `gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、
`gpt-5.4-mini` が Codex のサブエージェントピッカーに表示されます。`ocx gui` で最大 5 つの
ネイティブまたはルーティングモデルを変更・並び替えできます。

## 任意プロバイダーへのアカウントログイン

一部のプロバイダーは OAuth アカウントログインをサポートします:

```bash
ocx login xai          # または anthropic, kimi, kiro, google-antigravity, cursor
ocx logout xai
```

デフォルト OpenAI 経路は**プロバイダーキー不要**で、既存の `codex login` 認証情報を転送します。
詳しくは [プロバイダー](/ja/guides/providers/) を参照してください。

## 停止と復元

```bash
ocx stop          # プロキシを停止しネイティブ Codex を復元
ocx restore       # プロキシは残したままネイティブ Codex を復元（エイリアス: ocx eject）
ocx restore back  # 実行中のプロキシに Codex を再接続
```

## 次へ

- [仕組み](/ja/getting-started/how-it-works/) — 各リクエストで何が起きるか。
- [プロバイダー](/ja/guides/providers/) — 認証のすべての方法。
- [設定](/ja/reference/configuration/) — 完全な `config.json` リファレンス。
