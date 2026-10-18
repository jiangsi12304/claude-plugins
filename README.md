# claude-plugins

三个 Claude Code 插件，都从文件夹直接加载、零依赖、不改任何配置文件。

| 插件 | 一句话 |
| --- | --- |
| [model-compare](./model-compare/) | 提示框旁一颗绿点：两个网关模型并排回答同一个提示词，带盲测、模型裁判、评分与历史交锋 |
| [model-picker](./model-picker/) | 提示框上方一条模型栏：点一下就在网关的模型列表里切换 |
| [chat-history](./chat-history/) | 提示框旁一颗深红点：列出本项目的过去会话，点一条像 `claude -r` 一样恢复 |

## 安装（推荐：marketplace 一次装三个）

```sh
/plugin marketplace add jiangsi12304/claude-plugins
/plugin install model-compare@claude-plugins
/plugin install model-picker@claude-plugins
/plugin install chat-history@claude-plugins
```

## 安装（开发：从文件夹加载）

把仓库克隆到本地后：

```sh
claude --plugin-dir path/to/claude-plugins/model-compare
claude --plugin-dir path/to/claude-plugins/model-picker
claude --plugin-dir path/to/claude-plugins/chat-history
```

或在 `~/.claude/settings.json` 的 `env` 里加：

```json
{ "CLAUDE_CODE_PLUGIN_DIRS": "path/to/claude-plugins/model-compare;path/to/claude-plugins/model-picker;path/to/claude-plugins/chat-history" }
```

## 说明

- 三个插件都假设会话走一个 OpenAI 风格的网关（`ANTHROPIC_BASE_URL`）：model-compare 和 model-picker 会读网关的 `GET /v1/models` 列模型，凭据依次取 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY` 环境变量，令牌只留在进程内。没有网关也能用，模型 id 手打即可。
- 每个插件文件夹里有各自的 README（中文），写明功能、配置项和用法。
- 测试：`claude plugin test <插件文件夹>`；校验：`claude plugin validate <插件文件夹>`。

## License

MIT
