# chat-history

一个 Claude Code 命令行插件：在提示框下方画一个**深红色的圆点**，点它就能看到本项目的历史对话，再点一条即可像 `claude -r` 一样切换过去。

## 功能

- **深红圆点**：画在提示框下方的提示行里（`? for shortcuts` 那一行），点一下打开历史面板。
- **历史列表**：列出本项目（`~/.claude/projects/<项目目录>/`）的全部会话，按最后活动时间倒序，显示相对时间（`3m`、`2h`、`5d`）与标题。
- **标题**：优先用 Claude Code 自己写的会话标题（`aiTitle`），没有则用该会话的第一条用户消息。
- **点击恢复**：点一行就调用引擎自己的 `/resume <id>`，与在会话里敲 `/resume`、或退出后跑 `claude -r <id>` 等价——当前窗口直接切到那段对话，上下文一起载入。
- **Peek 预览**：每行右侧的 `Peek` 读出该会话开头几条消息（`you:` / `claude:`），先看内容再决定恢复哪一段。
- **过滤 / 翻页 / 刷新**：面板顶部输入框实时过滤，底部 `‹ Prev` / `Next ›` 翻页，`Refresh` 重读磁盘。
- **跨项目（可选）**：`showAllProjects` 打开后列出所有项目的会话；注意只有本项目的能在当前窗口里直接恢复。

## 安装

```sh
claude --plugin-dir path/to/chat-history
```

或让每个会话都加载：在 `~/.claude/settings.json` 的 `env` 里加

```json
{ "CLAUDE_CODE_PLUGIN_DIRS": "D:\\test\\fff\\chat-history" }
```

安装为正式插件：把本文件夹作为 marketplace 仓库，然后 `/plugin install chat-history --marketplace <owner>/<repo>`。

## 用法

- 点提示框下方的深红圆点，或敲 `/history`。
- 点一行恢复该对话；点 `Peek` 先看开头几条消息；`Esc` 关闭面板。

## 配置（`/config` 里的四行）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `showDot` | boolean | `true` | 是否在提示行画那个圆点 |
| `pageSize` | number | `10` | 面板每页列多少条会话 |
| `showAllProjects` | boolean | `false` | 列出所有项目，而不只是当前项目 |
| `previewLines` | number | `4` | `Peek` 显示多少条消息 |

## 它是怎么找到历史的

- 会话文件在 `~/.claude/projects/<目录名>/*.jsonl`，目录名是把当前工作目录里所有非字母数字字符替换成 `-`（例如 `C:\path\to\project` → `C--path-to-project`）。这与 Claude Code 自己的规则一致。
- 每个文件里，`{"type":"ai-title","aiTitle":"…"}` 是会话标题，`{"type":"user","message":{…}}` 是消息行；插件只读开头部分。
- 单个文件超过 4 MiB 时引擎的 `$.fs.read` 会拒绝，插件改为让宿主 shell 读前 400 行（PowerShell 的 `Get-Content -TotalCount`，非 Windows 用 `head`），因此大文件也有标题。
- 恢复走 `$.command.run({ command: 'resume', args: id })`，也就是引擎自己的 `/resume`。

## 限制

- 只有**交互式**会话里 `/resume` 才存在；`-p` / SDK 环境下插件仍会列出历史，但点击恢复会失败并提示。
- 跨项目的会话可以在列表里看到（打开 `showAllProjects` 时），但在当前窗口里恢复只对本项目生效；别的项目请用 `claude -r <id>` 在对应目录打开。
- `~/.claude/projects` 里只保留最近的一部分会话文件由引擎自行管理；插件不删除、不修改任何会话文件，只读。
- 组织托管 Claude Code 的环境里，个人安装的插件行为可能受限，但本插件不依赖任何被接管的 hook 事件。

## 开发

```sh
claude plugin validate .   # 读清单和模块源码，报告会被拒绝的东西
claude plugin test .       # 跑 tests/ 下的 *.test.tsx（terminal / desktop / mobile）
```

- `hooks/register.tsx`：全部逻辑（找文件、读标题、渲染圆点与面板、恢复）。
- `types/index.d.ts`：`$.state` 的值契约。
- `tests/history.test.tsx`：圆点、列表与恢复、Peek、过滤、移动端五组用例。
