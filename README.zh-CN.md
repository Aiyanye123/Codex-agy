# antigravity-codex-bridge

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

antigravity-codex-bridge 在 Windows、macOS 和 Linux 本机连接 Antigravity CLI 与 Codex，由 Gemini 协调并验收，Codex 在你的项目里执行任务。

- Gemini 整理需求、派单、后台等回执，并按验收条件追补遗漏。默认只收摘要，节省对话上下文，需要时再取全文。
- 可以在默认会话或多个命名子会话中新建、绑定 Codex 会话，独立任务可放在各自的 Git 工作树中并行推进。
- Gemini 可用 Antigravity 原生终端查找证据、执行已获授权的日常 Git 操作。源码修改、代码审阅、构建测试和长材料交给 Codex。
- 桥接在本机运行，无需常驻服务。绑定和工单记录保存在本地 SQLite，已完结工单的回执原文保留 30 天后自动清理。

## 安装

先在同一台电脑上准备以下工具，并在 Antigravity 和 Codex 中分别完成登录。

| 需要什么 | 如何获取 |
| --- | --- |
| Node.js 22.13 或更新版本，推荐 24 LTS | [Node.js 下载](https://nodejs.org/en/download) |
| Antigravity CLI，推荐 1.5.13 或更新版本 | [Google Antigravity 安装指南](https://antigravity.google/docs/cli/tutorial) |
| 支持 `app-server` 和 `queue` 的原生 Codex CLI | [OpenAI 的 Codex CLI 安装指南](https://learn.chatgpt.com/docs/cli) |
| 桌面模式需安装带 Codex 的 ChatGPT 桌面应用。Linux 桌面应用处于预览阶段，桥接使用 `xdg-open` 打开链接。 | [Windows](https://learn.chatgpt.com/docs/windows/windows-app) · [macOS](https://learn.chatgpt.com/docs/app) · [Linux](https://learn.chatgpt.com/docs/linux/linux-app) |
| PowerShell 7，仅在 Windows 使用 `Install.ps1` 入口时需要 | [Microsoft 安装指南](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows) |
| Git，用于创建独立工作树 | [Git 下载](https://git-scm.com/downloads) |

在新终端确认以下命令可用。`queue` 帮助应显示 `--thread` 和 `--message`，直连使用 Codex CLI 0.171.0 的协议。Windows 上用 `Get-Command codex.exe` 确认可找到原生可执行文件。

```text
node --version
agy --version
codex queue --help
codex app-server --help
```

### 手动安装

在 GitHub 点 **Code → Download ZIP**，解压到一个会长期保留的目录。也可以用 Git 克隆仓库。

```sh
git clone https://github.com/Aiyanye123/antigravity-codex-bridge.git
cd antigravity-codex-bridge
```

从桥接目录为当前用户执行安装。仓库已包含运行文件。

```text
node install.mjs --global
```

Windows 上也可以继续使用 PowerShell 7 入口。

```powershell
.\Install.ps1 -Global
```

之后在目标项目目录运行 `agy --agent agydex`。如果只想在一个项目配置桥接，从桥接目录运行 `node install.mjs --workspace <路径>`。Antigravity 配置引用安装目录中的文件，请保留该目录。

### 仅用 Codex CLI 直连

想通过 SSH 或在没有图形界面的主机上使用，安装 Codex CLI 后执行 `node install.mjs --global --default-mode direct` 即可。Windows PowerShell 入口是 `.\Install.ps1 -Global -DefaultMode direct`。此模式会用 CLI 启动新回合，无需安装桌面应用。要恢复桌面默认模式，在相同安装范围重新运行安装器并指定 `--default-mode desktop` 或 `-DefaultMode desktop`，再重启 Antigravity。默认模式适用于新会话和新绑定。要切换已有绑定，告诉 Antigravity 下一单使用直连或桌面模式。

升级时，在原目录更新桥接文件，按需要的默认模式重跑安装命令，然后重启 Antigravity。做过工作区安装的项目也要各更新一次。安装器沿用已托管配置中的状态目录，显式传 `--state-directory <路径>` 时切换目录。安装器更新托管的角色和 MCP 设置，保留其他 MCP 服务。遇到手动修改的角色或同名服务冲突时，提示需要核对的文件。

从 `codex-agy` 升级时，安装器会新增 `agydex` 并保留旧角色。沿用原安装目录和设置即可继续使用现有数据库。

### 让 Agent 帮你安装

把下面整段发给能操作本机终端的 Agent。

```text
请在这台电脑上为当前用户安装 antigravity-codex-bridge。
请先阅读并遵循仓库的 README，地址为 https://github.com/Aiyanye123/antigravity-codex-bridge
如果已经在项目目录，优先使用现有副本。否则用 Git 克隆或下载 ZIP，放在当前用户可写、以后会保留的目录。保留现有配置和会话数据库。
检查 Node.js 22.13+、Antigravity CLI 和原生 Codex CLI。检查 codex queue --help 和 codex app-server --help。桌面模式还需检查桌面应用。缺失的依赖按 README 链接的官方指南安装。需要我完成登录或系统弹窗时，告诉我具体要做什么。
从桥接目录运行 node install.mjs --global。如果我要求只用 CLI，加 --default-mode direct。安装器发现配置冲突时，保留原配置并告诉我冲突的位置。
用 agy agents 和 agy mcp list 确认能找到 agydex 和 codex_bridge。最后告诉我安装位置和验证结果，以及如何在我的工作目录运行 agy --agent agydex。验证安装时无需派发真实工单。
```

## 快速开始

### 在当前目录创建 Codex 会话

进入你想让 Codex 工作的目录，再启动 Antigravity。Windows 路径例如 `C:\Work\MyProject`，macOS 或 Linux 路径例如 `~/Work/MyProject`。请换成实际项目路径。

```sh
cd ~/Work/MyProject
agy --agent agydex
```

在 Antigravity 里发一个任务，例如「让 Codex 看一下这个目录，简单说明主要文件的用途，先保持文件原样。」

桌面模式会打开预填的草稿。确认内容后保留工单标记，再点**发送**。直连模式由 Codex CLI 直接启动回合。

### 绑定已有 Codex 会话

在桌面应用打开目标会话，macOS 按 `⌘` + `⌥` + `L`，Windows 和 Linux 按 `Ctrl` + `Alt` + `L` 复制会话链接，再贴到 Antigravity。仅用 CLI 时，可以直接提供已保存会话的完整 UUID。 [Codex 桌面快捷键](https://learn.chatgpt.com/docs/reference/commands#keyboard-shortcuts)

```text
绑定这个 Codex 会话 codex://threads/00000000-0000-4000-8000-000000000001
```

Gemini 确认绑定和工作目录后，你就可以在 Antigravity 提任务。桌面模式下，任务会进入该 Codex 会话的队列，使用其工作目录和模型设置。任务一直显示已入队时，打开对应的 Codex 会话查看。

### 直连执行与审批

要切到直连，可以让 Antigravity「用直连模式执行」。`submit` 会传入 `execution_mode: "direct"`，立即向新会话或已绑定会话派单。同一绑定后续沿用直连。要切回桌面，要求使用桌面模式，派单时传 `execution_mode: "desktop"`。

直连默认沿用本机 Codex 设置，可以按工单指定 `sandbox` 或 `approval_policy`。桌面派单会拒绝这两个覆盖参数，沿用 App 会话设置。Windows 上显式指定只读或工作区可写时，该执行进程使用 MXC。保持 Antigravity 对话打开，以便收到审批请求和最终回执。你可以要求 Gemini 纠偏或中断进行中的直连回合。Codex 请求审批或输入时，Gemini 会展示具体请求，取得你的决定后用 `approve` 回传，再继续等待。

直连回合结束后会释放写入连接。在 Codex App 点开该会话时，桌面端可能占用写入锁。下一张普通直连工单遇到占锁时会自动入队一次并切换绑定模式，沿用已有会话的权限。显式指定沙箱或审批策略的工单会返回冲突，由你决定是否另行排队。

### 并行安排任务

日常工作沿用默认会话。要并行时，让 Antigravity 分别派往 `docs`、`feature-a` 等命名子会话。查进度、恢复草稿或追单时沿用原名称。想核对目标时，可以要求列出全部子会话绑定和目录。升级数据库时，已有绑定和工单会归入 `default`。

需要隔离改动时，可以要求「用独立 Git 工作树新开一个子会话」。Git 需在 PATH 中，当前检出需已有提交。桥接从当前检出的 HEAD 创建 `agy/<工单 ID>` 分支，把工作树放在主检出的同级目录，名称类似 `MyProject-agy-<工单 ID>`。未提交的改动留在原检出。也可以绑定已有工作树中的 Codex 会话。解绑或放弃工单后，工作树与分支保留，由你自行合并或清理。

项目钩子可选。若要通过钩子记录工作树中的接单、回执和中断，可对该工作树路径运行仅安装钩子的命令，使用同一个状态目录，并在 Codex App 审查启用。

### 日常操作

| 你想做什么 | 怎么操作 |
| --- | --- |
| 看当前绑在哪个会话 | 在 Antigravity 说「现在绑定的是哪个 Codex 会话？」 |
| 查进度或结果 | 说「查进度」看状态，「查结果」看摘要，「看完整回执」取原文。有工单 ID 时也可以指定该工单。 |
| 回看已绑定的会话 | 说「看看绑定的 Codex 会话最近聊了什么」。最多返回六条已完成回复，每条附上问题和回复的短摘录。 |
| 查看近期工单 | 说「列出我的任务」，可看到工单 ID、状态、目录和 UTC 时间。旧记录未保存的时间显示为未知。 |
| 恢复未发送的首单 | 说「恢复草稿」并给出工单 ID。桥接在本地暂存草稿正文，接单或放弃时清除。只在一个窗口点发送。没有保存正文的旧草稿仍可从原窗口发送。 |
| 放弃草稿或停止跟踪 | 指定工单说「放弃草稿」或「停止跟踪」。请关闭 App 中已放弃的草稿；已发送的任务仍可能继续执行。 |
| 换成另一个已有会话 | 发送新的 Codex 会话链接并要求绑定。 |
| 解除当前绑定 | 说「取消绑定」或「解绑」。已派发的工单仍可查询。 |
| 改用一个新会话 | 说「新开一个 Codex 会话处理」。Codex App 会先打开草稿，想立即派单时可要求使用直连。 |
| 退出后恢复绑定 | 用 `/resume` 选回原来的 Antigravity 对话。也可以在同一目录运行 `agy --agent agydex -c` 恢复最近的对话，或用 `--conversation` 加对话 ID 精确恢复。 |

### 终端与桥接工具

`agydex` 通过 `commandExecutionPolicy: sandbox` 启用原生终端，实际运行遵循 Antigravity 的沙箱和权限设置。Gemini 可用内置查看和检索工具，也可在当前工作区通过终端做定向只读核查或已获授权的日常 Git 操作。命令需控制输出，跳过凭据、锁文件和符号链接。文本检索可选装 `rg`，文档检索可选装 `rga` 及所需适配器。用 `rg --version` 和 `rga --version` 确认命令可用。短篇 Office 文档也可用现成的只读解析工具查阅。 [ripgrep-all](https://github.com/phiresky/ripgrep-all)

源码修改、代码审阅、构建测试、其他目录的核查和长材料处理均交给 Codex。Git 写入前，Gemini 必须确认同一工作树没有进行中的 Codex 工单。拉取和合并只允许快进，推送须获用户对目标分支的明确授权。禁止强推、`reset --hard`、`clean` 和改写历史。

桥接的 12 个 MCP 工具负责会话和工单操作，包括 `bind`、`unbind`、`submit`、`status`、`list_tasks`、`recent_replies`、`dismiss`、`resume_draft`、`steer`、`interrupt`、`approve` 和 `watch`。

## 完成通知、文件和本地数据

- **等待与汇报。** 保持 Antigravity 对话打开，Gemini 会后台等待回执，每次最多一小时。收到回执后，Gemini 会对照原需求核对 Codex 的回执、追问遗漏，再用简体中文汇报。需要核对文档或明确提及的结果文件时，才按路径读取。常规且已授权的细节可以直接跟进。涉及范围变更、重要取舍或 Codex App 审批时，Gemini 会请你处理。退出 Antigravity 后，可恢复原对话并说「查结果」。
- **图片和文件。** 把材料保存到 Codex 能访问的本机目录，在请求中写清完整路径，例如 `C:\Work\MyProject\reference.png` 或 `/home/you/Work/MyProject/reference.png`。桥接传递文本工单和回执，文件留在本机，Codex 按路径读取。需要把图片作为原生附件时，可以在 Codex App 手动添加。
- **配置和记录。** 全局配置位于 `~/.gemini/config`，Windows 对应 `%USERPROFILE%\.gemini\config`。项目配置位于工作区的 `.agents`。绑定、任务状态和回执默认保存在桥接安装目录的 `.state/bridge.sqlite`。桥接启动时会清理距最后更新超过 30 天的已完结工单回执原文，工单记录和绑定仍可查询。桥接随 Antigravity 启动，任务内容由 Antigravity 和 Codex 各自的模型服务处理。

## 常见问题

| 遇到的情况 | 可以怎么处理 |
| --- | --- |
| `Agent Not Found` | 在工作目录运行 `agy agents` 和 `agy mcp list`，检查 `agydex` 和 `codex_bridge`。确认安装范围正确，从该目录重新启动 Antigravity。 |
| PowerShell 执行策略阻止 ZIP 中的 `Install.ps1` | 用对应安装范围的 Node 命令，例如 `node install.mjs --global`。也可以审阅脚本后执行 `Unblock-File -LiteralPath .\Install.ps1`，再运行包装脚本。 |
| Codex CLI 探测失败 | 按上面的官方指南安装或更新原生 Codex CLI。Windows 用 `Get-Command codex.exe`，macOS 和 Linux 用 `command -v codex` 检查路径。 |
| Linux 打不开桌面草稿 | 有图形会话时检查 `xdg-open` 与 `codex://` 协议关联。用 SSH 或没有图形界面时，可以请求直连或安装时设置 `--default-mode direct`。打开器超时后先检查原草稿，避免重复发送。 |
| `thread/read: thread not loaded` | 桌面模式可在 App 打开会话后重试。仅用 CLI 时，可改用直连或绑定当前 CLI 能读取的会话。 |
| Codex 做完了，Antigravity 还没汇报 | 在原对话说「查结果」。等待发送的桌面草稿需在 Codex App 发送。直连工单的审批出现在 Antigravity，桌面工单的审批出现在 Codex App。 |
| 是否需要启用 Codex 钩子 | Antigravity 的后台等待可提供日常完成汇报。项目钩子可更早记录接单和完成，也可记录手动中断。在桥接目录运行 `node install.mjs --workspace <路径> --hooks-only`，使用自定义状态目录时也传同一个 `--state-directory`，然后在 Codex 设置或 `/hooks` 中审查并启用。 |

## 开源协议

antigravity-codex-bridge 使用 [MIT 开源协议](LICENSE)。第三方依赖的许可声明见 [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)。
