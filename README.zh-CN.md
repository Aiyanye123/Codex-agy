# antigravity-codex-bridge

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

antigravity-codex-bridge 在 Windows 本机连接 Antigravity CLI 和 Codex App，由 Gemini 协调并验收，Codex 在你的项目里执行任务。

- Gemini 整理需求、派单、后台等回执，并按验收条件追补遗漏。默认只收摘要，节省对话上下文，需要时再取全文。
- 可以在默认会话或多个命名子会话中新建、绑定 Codex 会话，独立任务可放在各自的 Git 工作树中并行推进。
- 可选用 `rg` 在 Antigravity 当前工作区内做只读检索，跳过常见敏感文件。代码审阅和长材料交给 Codex。
- 桥接在本机运行，无需常驻服务。绑定和工单记录保存在本地 SQLite，已完结工单的回执原文保留 30 天后自动清理。

## 安装

先在同一台 Windows 电脑上准备以下工具，并在 Antigravity 和 Codex 中分别完成登录。

| 需要什么 | 如何获取 |
| --- | --- |
| PowerShell 7 | [Microsoft 安装指南](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows) |
| Node.js 22.13 或更新版本，推荐 24 LTS | [Node.js 下载](https://nodejs.org/en/download) |
| Antigravity CLI，推荐 1.5.13 或更新版本 | [Google Antigravity 安装指南](https://antigravity.google/docs/cli/tutorial) |
| Codex App，或 ChatGPT 桌面应用中的 Codex | [OpenAI 的 Windows 桌面安装指南](https://learn.chatgpt.com/docs/windows/windows-app) |
| 支持 `app-server` 和 `queue` 的 Codex CLI，推荐用 Windows 独立安装程序 | [OpenAI 的 Codex CLI 安装指南](https://learn.chatgpt.com/docs/cli) |

装好依赖后，在新的 **PowerShell 7** 窗口确认这些命令可用。`Get-Command` 应能找到 `codex.exe`，`codex.exe queue --help` 应显示 `--thread` 和 `--message`。直连使用 Codex CLI 0.171.0 的协议。

```powershell
node --version
agy --version
Get-Command codex.exe
codex.exe queue --help
codex.exe app-server --help
```

### 手动安装

在 GitHub 点 **Code → Download ZIP**，解压到一个会长期保留的目录，再用 PowerShell 7 打开解压后的目录。如果已安装 Git，也可以从你想存放桥接程序的父目录运行下列命令。

```powershell
git clone https://github.com/Aiyanye123/antigravity-codex-bridge.git
Set-Location .\antigravity-codex-bridge
```

在能看到 `Install.ps1` 的目录执行一次全局安装。仓库已经包含运行文件，安装时直接使用即可。

```powershell
.\Install.ps1 -Global
```

全局安装只对当前 Windows 用户生效。之后可以在任意工作目录运行 `agy --agent agydex`，无需在每个项目重新安装。请保留桥接程序的安装目录，Antigravity 配置会引用其中的文件。

升级时，在原目录更新桥接文件，重新执行原来的安装命令，然后重启 Antigravity。如果还做过工作区安装，也在对应工作区重新执行安装命令。安装器会更新托管的角色和 MCP 设置，保留其他 MCP 服务。遇到手动修改的角色或同名服务冲突，会停下并提示需要核对的文件。

从 `codex-agy` 升级时，安装器会新增 `agydex` 并保留旧角色。沿用原安装目录和设置即可继续使用现有数据库。

### 让 Agent 帮你安装

把下面整段发给能操作 Windows 终端的 Agent，例如 Codex App。

```text
请在这台 Windows 电脑上为当前用户安装 antigravity-codex-bridge。
请先阅读并遵循仓库的 README，地址为 https://github.com/Aiyanye123/antigravity-codex-bridge
如果已经在项目目录，优先使用现有副本。否则用 Git 克隆或下载 ZIP，放在当前用户可写、以后会保留的目录。保留现有配置和会话数据库。
检查 PowerShell 7、Node.js 22.13+、Antigravity CLI、Codex App 和可执行 codex.exe。用 codex.exe queue --help 确认支持队列功能。缺失的依赖按 README 链接的官方 Windows 指南安装。需要我完成登录或系统弹窗时，告诉我具体要做什么。
在项目目录用 PowerShell 7 执行 .\Install.ps1 -Global。若安装器发现已有冲突，保留原配置并告诉我冲突的位置。
用 agy agents 和 agy mcp list 确认能找到 agydex 和 codex_bridge。最后告诉我安装位置和验证结果，以及如何在我的工作目录运行 agy --agent agydex。验证安装时无需派发真实工单。
```

## 快速开始

### 在当前目录创建 Codex 会话

在 PowerShell 7 进入你真正想让 Codex 工作的目录，然后启动 Antigravity。下面的路径只是示例。

```powershell
Set-Location 'C:\Work\MyProject'
agy --agent agydex
```

在 Antigravity 里发一个任务，例如「让 Codex 看一下这个目录，简单说明主要文件的用途，先保持文件原样。」

桥接默认直连新建 Codex 会话并发送首单。保持 Antigravity 对话打开，以便收到审批请求和最终回执。如果想先在 App 审查工单或选择模型，可以要求用桌面草稿。确认内容后保留工单标记，再点**发送**。

### 绑定已有 Codex 会话

在 Codex App 打开目标会话，按 `Ctrl` + `Alt` + `L` 复制会话链接，再粘贴到 Antigravity。也可以用手头的完整会话 UUID。示例中的 UUID 请换成你自己的。[Codex 桌面快捷键](https://learn.chatgpt.com/docs/app/commands#keyboard-shortcuts)

```text
绑定这个 Codex 会话 codex://threads/00000000-0000-4000-8000-000000000001
```

Gemini 确认绑定和工作目录后，你就可以在 Antigravity 提任务。后续任务会进入该 Codex 会话的队列，使用其工作目录和模型设置。任务一直显示已入队时，打开对应的 Codex 会话查看。

### 直连执行与审批

直连默认沿用本机 Codex 设置，可以按工单指定 `sandbox` 或 `approval_policy`。Windows 上显式指定只读或工作区可写时，该执行进程使用 MXC。你可以要求 Gemini 纠偏或中断进行中的直连回合。Codex 请求审批或输入时，Gemini 会展示具体请求，取得你的决定后用 `approve` 回传，再继续等待。

直连回合结束后会释放写入连接。下一单到达时，如果 Codex App 已接手该会话，桥接会自动入队一次并告知你已切到桌面模式。本单沿用桌面会话的沙箱和审批设置。

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
| 改用一个新会话 | 说「新开一个 Codex 会话处理」。需要先审查时，可以要求用桌面草稿。 |
| 退出后恢复绑定 | 用 `/resume` 选回原来的 Antigravity 对话。也可以在同一目录运行 `agy --agent agydex -c` 恢复最近的对话，或用 `--conversation` 加对话 ID 精确恢复。 |

如果 `rg.exe` 已加入 PATH，Gemini 可以只读查找文件、检索文档、代码与配置，或搜全部文本。例如「在 `src/` 的 `*.mjs` 文件里定位 `queueTask`」。检索支持相对路径、通配符、大小写、全词、正则和最多两行上下文。工具跳过 Git 忽略项、符号链接、常见凭据和锁文件，允许检索 `.github/` 等项目配置。绑定的 Codex 会话在另一个目录时，那个目录的核对及长材料审阅交给 Codex。

## 完成通知、文件和本地数据

- **等待与汇报。** 保持 Antigravity 对话打开，Gemini 会后台等待回执，每次最多一小时。收到回执后，Gemini 会对照原需求核对 Codex 的回执、追问遗漏，再用简体中文汇报。需要核对文档或明确提及的结果文件时，才按路径读取。常规且已授权的细节可以直接跟进。涉及范围变更、重要取舍或 Codex App 审批时，Gemini 会请你处理。退出 Antigravity 后，可恢复原对话并说「查结果」。
- **图片和文件。** 把材料保存到 Codex 能访问的本机目录，在请求中写清完整路径，例如 `C:\Work\MyProject\reference.png`。桥接当前传递文本工单和回执，文件留在本机，Codex 按路径读取。需要把图片作为原生附件时，可以在 Codex App 手动添加。
- **配置和记录。** 全局配置位于 `%USERPROFILE%\.gemini\config\`，绑定、任务状态和文字回执默认保存在安装目录的 `.state\bridge.sqlite`。桥接启动时会清理距最后更新超过 30 天的已完结工单回执原文，工单记录和绑定仍可查询。桥接随 Antigravity 启动，无需单独设置开机自启。任务内容仍由 Antigravity 和 Codex 各自的模型服务处理。

## 常见问题

| 遇到的情况 | 可以怎么处理 |
| --- | --- |
| `Agent Not Found` | 在工作目录运行 `agy agents` 和 `agy mcp list`，检查是否有 `agydex` 和 `codex_bridge`。如果还没全局安装，回到桥接安装目录运行 `.\Install.ps1 -Global`，再打开一个新的 Antigravity 进程。 |
| 执行策略阻止 ZIP 中的脚本 | 确认 ZIP 来自本仓库并审阅 `Install.ps1` 后，在桥接目录运行 `Unblock-File -LiteralPath .\Install.ps1`，再执行安装。 |
| `Get-Command codex.exe` 找不到命令，或 `queue` 不可用 | 按上面的官方指南安装或更新 Windows 版 Codex CLI，再打开新终端确认。 |
| Codex 做完了，Antigravity 还没汇报 | 在原对话说「查结果」。等待发送的桌面草稿需在 Codex App 发送。直连工单的审批出现在 Antigravity，桌面工单的审批出现在 Codex App。 |
| 是否需要启用 Codex 钩子 | 日常完成汇报由 Antigravity 后台等待提供，已配置的 `AGY Codex Bridge` 钩子可以在 Codex App 中关闭。项目钩子可更早记录接单和完成。当前版本还通过钩子记录手动中断。全局安装后，可在桥接安装目录运行 `.\Install.ps1 -Workspace 'C:\Work\MyProject' -HooksOnly`，把路径换成你的项目，再到 Codex App 审查并启用。此模式只安装项目钩子。如果全局安装用了自定义 `-StateDirectory`，这里也要指定同一路径。 |

## 开源协议

antigravity-codex-bridge 使用 [MIT 开源协议](LICENSE)。第三方依赖的许可声明见 [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)。
