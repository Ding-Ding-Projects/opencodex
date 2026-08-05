---
title: 快速开始
description: 使用现有 ChatGPT/Codex 登录启动 opencodex；本地使用不需要 provider API key。
---

全新的本地配置会使用内置 `openai` provider，转发你现有的 ChatGPT/Codex 登录。首次启动前
**无需**准备 provider API key，也无需运行 `ocx init`。

## 1. 启动代理

```bash
ocx start            # 默认端口 10100
ocx start --port 8080
```

请保持这个终端运行。启动时，opencodex 会：

- 在配置文件不存在时加载无需 key 的 ChatGPT 转发 provider；
- 把 PID 写入 `~/.opencodex/ocx.pid` 并拒绝重复启动；
- 将可用模型同步到 Codex 模型目录；
- 以可恢复的方式把本地代理写入 Codex 配置；
- 在 `http://localhost:<port>/v1` 上监听。

如果请求的端口已被占用，opencodex 会把空闲端口写入 `runtime-port.json` 并更新 Codex。
可在另一个终端检查状态或打开仪表盘：

```bash
ocx status
ocx gui
```

## 2. 使用 ChatGPT/Codex 登录

如果 Codex 已登录 ChatGPT，就无需再配置。尚未登录时，只需完成一次 Codex 的正常登录流程：

```bash
codex login
```

然后启动已连接到运行中代理的 Codex：

```bash
ocx codex
```

`gpt-5.6-sol` 等不带命名空间的模型 ID 会使用内置 ChatGPT 转发路径。目录条目本身不会
授予权限；账号仍需具备目标模型的访问权限。

## 它要求的是哪种凭据？

| 凭据 | 何时需要 | 含义 |
| --- | --- | --- |
| **ChatGPT/Codex 登录** | 默认本地 `openai` 路径 | 由 `codex login` 或 Codex App 创建的账号会话，不是 API key。 |
| **上游 provider 凭据** | 仅当你主动添加其他 provider | 该 provider 的 API key 或 OAuth/账号登录。本地 provider 通常两者都不需要。 |
| **OpenCodex 准入密钥** | 连接非回环/LAN 监听地址的数据平面客户端 | 由 `ocx host enable --new-key --yes` 生成，用于保护 `/v1/*`。它不是 provider 计费 key，在 `localhost` 上不需要。 |

如果客户端显示 **`opencodex API key required`**，说明它连接到了非回环监听地址，却没有
提供 OpenCodex 准入密钥。请改用 `localhost`，或在该客户端中配置已生成的准入密钥。
购买或粘贴 provider API key 不能解决这条消息。

## 3. 添加其他 provider（可选）

最简单的方式是在 `ocx gui` 中打开 **Add provider**，然后选择账号登录、API key、本地服务器
或自定义 endpoint。只有在需要从终端重新配置全新安装时才运行：

```bash
ocx init
```

在 **Select default provider** 提示中按 <kbd>Enter</kbd>，会选择 provider **1**：
**OpenAI — ChatGPT login (no key)**。向导只会询问所选路径真正需要的内容：

1. **ChatGPT 转发** —— 无需 API key，使用 Codex 登录。
2. **账号登录（OAuth）** —— 保存 provider 后，运行显示的 `ocx login <provider>`。
3. **API key provider** —— 输入该上游 provider 的 key，或 `${ANTHROPIC_API_KEY}` 这样的
   环境变量引用。
4. **本地 provider** —— 通常将 key 留空。
5. **代理与 Codex 集成** —— 选择端口、注入和可选的自动启动 shim。

结果会保存到 `$OPENCODEX_HOME/config.json`（默认 `~/.opencodex/config.json`）。

:::note[GPT-5.6 灰度发布条目]
稳定版 v2.7.1 会为 ChatGPT 直通、OpenAI API key、OpenRouter 和实验性 Cursor adapter
提供 GPT-5.6 Sol/Terra/Luna 条目。只有上游账号具备权限时才能实际调用。
:::

若要指定已路由模型，请使用 Codex 模型选择器显示的 `provider/model` 形式：

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

## 选择 sub-agent 模型（可选）

新配置会显示 `gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` 和
`gpt-5.4-mini`。可在 `ocx gui` 中更换或调整最多五个原生或已路由模型的顺序。

## 可选 provider 的账号登录

部分 provider 支持 OAuth 账号登录：

```bash
ocx login xai          # 也可使用 anthropic、kimi、kiro、google-antigravity、cursor
ocx logout xai
```

默认 OpenAI 路径**无需 provider key**，它会转发现有的 `codex login` 凭据。详见
[Provider](/zh-cn/guides/providers/)。

## 停止与恢复

```bash
ocx stop          # 停止代理并恢复原生 Codex
ocx restore       # 不停止代理，仅恢复原生 Codex（别名：ocx eject）
ocx restore back  # 让 Codex 再次使用仍在运行的代理
```

## 下一步

- [工作原理](/zh-cn/getting-started/how-it-works/) —— 每个请求都发生了什么。
- [Provider](/zh-cn/guides/providers/) —— 各种认证方式。
- [配置](/zh-cn/reference/configuration/) —— 完整的 `config.json` 参考。
