# model-picker

一个 Claude Code 命令行插件：在对话页面上**直接点击**切换 `ANTHROPIC_BASE_URL` 指向的网关所提供的模型。

插件会从网关的 `GET /v1/models` 读取模型列表，在提示框上方画一条模型栏，点「Switch」打开可点击的模型面板，点某一行即切换当前会话的模型（走引擎自己的 `/model`，会话级生效，不影响全局配置）。

## 功能

- **提示框上方的模型栏**：显示当前模型，点模型名或 `Switch` 打开面板。
- **模型面板**：列出网关返回的全部模型（名称 / id / 上下文长度），当前模型以 `●` 标记。
- **点击切换**：点一行即切换；面板获得焦点时也可按行首数字键（1–9）。
- **模型强度（effort）**：面板底部一排 `auto / low / medium / high / xhigh / max`，**只列出当前模型在网关元数据里声明的级别**；点一下即切换。提示框上方的模型栏也显示当前级别，`Effort` 按钮可在可选级别间循环。网关没给某个模型声明级别时，该模型只有 `auto`，面板会写明「this model declares none」——插件不会凭空给出一个网关没声明的档位。每行的行尾也列出该模型声明的级别，方便切换前就知道它支持什么。
- **过滤**：面板顶部输入框按 id / 名称 / 描述实时过滤（移动端不画输入框）。
- **分页**：一页放不下时用 `‹ Prev` / `Next ›` 翻页。
- **最近使用**：切换过的模型记在面板顶部，跨会话保留。
- **自动刷新**：会话启动时后台拉取一次；面板打开时若列表过期（默认 10 分钟）会重新拉取；`Refresh` 手动刷新。
- **跟随外部切换**：用 `/model`、`/config` 或面板以外的方式切换时，模型栏同步更新。

## 安装

开发时直接从文件夹加载（仅该会话）：

```sh
claude --plugin-dir path/to/model-picker
```

或让每个会话都加载：在 `~/.claude/settings.json` 的 `env` 里加

```json
{ "CLAUDE_CODE_PLUGIN_DIRS": "D:\\test\\fff\\model-picker" }
```

安装为正式插件则把本文件夹作为 marketplace 仓库，然后 `/plugin install model-picker --marketplace <owner>/<repo>`。

## 用法

- `/models` 或 `/model-picker` 打开面板。
- 提示框上方的 `Switch` 按钮打开面板；`Effort` 按钮在可选强度间循环。
- 面板里点一行切换模型，点底部的 `auto / low / … / max` 设置强度；`Esc` 关闭；`Refresh` 重新读取网关。

## 模型强度怎么来的

- 每个模型的可用级别取自网关 `GET /v1/models` 的 `reasoning_supported_efforts`（缺省时回退到 `reasoning_effort`），**面板只列这些**；行尾也会列出该模型声明的级别。
- 网关没声明级别的模型，面板只给 `auto`（即不指定，让网关按自己的默认值跑）。插件不会替你猜档位。
- 设置强度走引擎自己的 `/effort <level>`，与会话里手敲 `/effort` 等价，只影响当前会话；选择会记住，下次打开面板时恢复。
- 模型栏显示的档位是从引擎读的（每轮 `turn.step` 的 `e.effort` 是真正发出去的值），所以你在别处敲 `/effort`、或用 `--effort` / `settings.modelSettings` 设过的档位，模型栏会跟着变。
- 强度真正生效的地方是请求体的 `output_config.effort`——和状态行里的 `max effort` 是同一条路径。
- 注意：`/config` 里那一行 `Thinking mode` 是**反的**（`true` 表示关闭思考），和强度是两回事。

## 配置（`/config` 里的四行）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `showBand` | boolean | `true` | 是否在提示框上方显示模型栏 |
| `baseUrl` | string | `""` | 读取模型的地址；留空则用 `ANTHROPIC_BASE_URL` |
| `paneRows` | number | `20` | 面板在内联时请求的高度（行） |
| `refreshMinutes` | number | `10` | 列表的保鲜时间；`0` 表示每次打开都重取 |

## 凭据

读取 `/v1/models` 时依次尝试 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`，以 `Authorization: Bearer …` 发送（同时附 `x-api-key`，兼容两种网关写法）。请求走宿主机的 `$.http.fetch`，不经过插件自己的网络栈；令牌只留在进程内，不写入任何文件。

切换模型本身不需要令牌——它调用的是引擎自己的 `/model <id>`。

## 说明与限制

- 模型 id 原样传给 `/model`，所以网关的 `global:…`、`cn:…` 之类 id 都能用。若网关不接受 `[1M]` 这类上下文后缀，列表里展示的是网关给出的 id，不会自动加后缀。
- 面板宽度不足（未全屏且窄于 110 列）时仍会以「提示框上方」的方式显示；更窄时引擎会让它等待，插件会在调试日志里写明原因。
- `classic.PostModelSwitch` 在组织托管 Claude Code 的环境中不会送达个人安装的插件；此时模型栏要等下一次打开面板或会话重载才会更新，切换本身仍然生效。

## 开发

```sh
claude plugin validate .   # 读清单和模块源码，报告会被拒绝的东西
claude plugin test .       # 跑 tests/ 下的 *.test.tsx（terminal / desktop / mobile 三个 surface）
```

- `hooks/register.tsx`：全部逻辑（拉取、切换、两处绘制）。
- `types/index.d.ts`：`$.state` 的值契约（插件声明的每个值都在这里）。
- `tests/picker.test.tsx`：模型栏、面板、过滤、强度、无声明级别模型、移动端六组用例。
