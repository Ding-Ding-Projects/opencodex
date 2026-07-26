---
title: 安装
description: 安装 opencodex(ocx)代理及其前置条件,并验证它能够运行。
---

安装 opencodex 后会得到 `ocx` 和 `opencodex` 两个等价命令。在受支持的 npm 环境中，它们会用
包内的 Go 运行时启动同一个小型本地 HTTP 服务器。模型请求会发往路由所选的 provider；当已路由模型需要时，可选的
vision 和网络搜索 sidecar 也可以使用你的 ChatGPT 登录凭据。

## 前置条件

| 要求 | 原因 |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | 小型 launcher 会校验并启动 macOS、Linux 或 Windows 的 amd64/x64 与 arm64 对应 Go 二进制文件。你**无需**自行安装 Bun。 |
| **[OpenAI Codex](https://openai.com/codex)**(CLI、App 或 SDK) | opencodex 所代理的客户端。opencodex 会写入 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）。 |
| 一个 provider 账号或 API key | Anthropic、xAI、Kimi、Ollama Cloud、OpenRouter、OpenAI API key、一个 OpenAI 兼容端点,或你的 ChatGPT 登录凭据。 |

## 安装

```bash
npm install -g @bitkyc08/opencodex
```

:::note[为什么仍会安装 Bun？]
Bun 依赖会暂时保留，用于旧版 updater、一次性的旧 Codex shim 更新，以及明确调用 Bun
包 API 的使用方。在六个受支持目标上，普通命令运行 Go，不会启动 Bun。未支持的平台仍可能
使用兼容 bridge；删除 Bun 依赖要等这些迁移路径退役后再进行。
:::

确认两个命令都已加入 `PATH`：

```bash
ocx --version
opencodex --version
```

### 发布渠道

稳定的 `latest` 渠道已经包含 ChatGPT、OpenAI API key、OpenRouter 以及实验性 Cursor 路由所需的
GPT-5.6 Sol/Terra/Luna 目录信息，但这些条目本身不会授予上游模型权限。只有在测试尚未正式发布的
opencodex 构建时，才需要使用 preview 渠道：

```bash
npm install -g @bitkyc08/opencodex@preview
ocx update --tag preview
```

## 从源码运行

若要开发 opencodex 本身，请在本机安装 `bun` CLI 并将其加入 `PATH`：

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # 以开发模式启动代理 API (src/cli/index.ts start)
bun run dev:gui     # 启动仪表盘 dev 服务器 (另一个终端)
```

`bun run dev` 作为 `bun run dev:proxy` 的别名保留。代理 API 暴露 `/healthz`、`/v1/responses`、
`/api/*`;只有在 `bun run build:gui` 生成 `gui/dist` 之后,`GET /` 才会提供打包后的仪表盘。
开发仪表盘时,请用 `bun run dev:gui` 单独运行前端。

## 会创建哪些内容

opencodex 状态文件位于 `$OPENCODEX_HOME`（默认 `~/.opencodex`），Codex 集成文件位于
`$CODEX_HOME`（默认 `~/.codex`）。

| 路径 | 用途 |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | 你的 provider、默认 provider、端口及选项。 |
| `$OPENCODEX_HOME/ocx.pid` | 正在运行的代理的 PID（单实例保护）。 |
| `$OPENCODEX_HOME/runtime-port.json` | 当前 PID、主机名和端口，包括自动选择的备用端口。 |
| `$OPENCODEX_HOME/auth.json` | 执行 `ocx login` 后保存的 OAuth 凭据。 |
| `$OPENCODEX_HOME/catalog-backup*.json` | opencodex 修改 Codex 模型目录前创建的备份。 |
| `$CODEX_HOME/config.toml` | 仅监听回环地址时，opencodex 会添加由自身标记管理的根级 `openai_base_url`；监听非回环地址时，则使用 `model_provider = "opencodex"` 和 `[model_providers.opencodex]`，以便 Codex 发送 API 认证 header。 |
| `$CODEX_HOME/opencodex.config.toml` | 与 Codex 主配置一同写入的备用/参考 profile。 |
| `$CODEX_HOME/opencodex-catalog.json` | 供 Codex 使用的原生与已路由模型目录。 |

:::note
opencodex 绝不会删除你的 Codex 配置。每次注入都是可逆的 —— `ocx stop`、`ocx restore`
或 `ocx eject` 会精确剥离 opencodex 所添加的那些行,并恢复原生 Codex。
:::

## 下一步

继续阅读 [快速开始](/zh-cn/getting-started/quickstart/) 以配置你的第一个 provider,
或阅读 [工作原理](/zh-cn/getting-started/how-it-works/) 了解其架构。
