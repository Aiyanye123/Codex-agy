# Codex-agy

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

Codex-agy 是一个 Windows 本地桥接工具。你在 Antigravity CLI 里提需求，Gemini 整理任务和验收条件，Codex App 在你的项目里执行。Gemini 收到 Codex 的回执后，可以核对实际产出，发现漏项时继续跟进，最后在原来的 Antigravity 对话里向你汇报。

## 安装

先在同一台 Windows 电脑上准备以下工具，并在 Antigravity 和 Codex 中分别完成登录。

| 需要什么 | 如何获取 |
| --- | --- |
| PowerShell 7 | [Microsoft 安装指南](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows) |
| Node.js 22.13 或更新版本，推荐 24 LTS | [Node.js 下载](https://nodejs.org/en/download) |
| Antigravity CLI，推荐 1.5.13 或更新版本 | [Google Antigravity 安装指南](https://antigravity.google/docs/cli/tutorial) |
| Codex App，或 ChatGPT 桌面应用中的 Codex | [OpenAI 的 Windows 桌面安装指南](https://learn.chatgpt.com/docs/windows/windows-app) |
| 支持 `queue` 的 Codex CLI，推荐用 Windows 独立安装程序 | [OpenAI 的 Codex CLI 安装指南](https://learn.chatgpt.com/docs/cli) |

装好依赖后，在新的 **PowerShell 7** 窗口确认这些命令可用。`Get-Command` 应能找到 `codex.exe`，`codex.exe queue --help` 应显示 `--thread` 和 `--message`。已验证的组合为 Antigravity CLI 1.5.13、Codex CLI 0.166.0 和 Node.js 24.18.0。

```powershell
node --version
agy --version
Get-Command codex.exe
codex.exe queue --help
```

### 手动安装

在 GitHub 点 **Code → Download ZIP**，解压到一个会长期保留的目录，再用 PowerShell 7 打开解压后的目录。如果已安装 Git，也可以从你想存放桥接程序的父目录运行下列命令。

```powershell
git clone https://github.com/Aiyanye123/Codex-agy.git
Set-Location .\Codex-agy
```

在能看到 `Install.ps1` 的目录执行一次全局安装。仓库已经包含运行文件，安装时直接使用即可。

```powershell
.\Install.ps1 -Global
```

全局安装只对当前 Windows 用户生效。之后可以在任意工作目录启动 `codex-agy`，无需在每个项目重新安装。请保留桥接程序的安装目录，Antigravity 配置会引用其中的文件。

### 让 Agent 帮你安装

把下面整段发给能操作 Windows 终端的 Agent，例如 Codex App。

```text
请在这台 Windows 电脑上为当前用户安装 Codex-agy。
项目地址是 https://github.com/Aiyanye123/Codex-agy 。请先读仓库 README，再按安装说明操作。
如果已经在项目目录，优先使用现有副本。否则用 Git 克隆或下载 ZIP，放在当前用户可写、以后会保留的目录。保留现有配置和会话数据库。
检查 PowerShell 7、Node.js 22.13+、Antigravity CLI、Codex App 和可执行 codex.exe。用 codex.exe queue --help 确认支持队列功能。缺失的依赖按 README 链接的官方 Windows 指南安装。需要我完成登录或系统弹窗时，告诉我具体要做什么。
在项目目录用 PowerShell 7 执行 .\Install.ps1 -Global。若安装器发现已有冲突，保留原配置并告诉我冲突的位置。
用 agy agents 和 agy mcp list 确认能找到 codex-agy 和 codex_bridge。最后告诉我安装位置和验证结果，以及如何在我的工作目录运行 agy --agent codex-agy。验证安装时无需派发真实工单。
```

## 快速开始

### 在当前目录创建 Codex 会话

在 PowerShell 7 进入你真正想让 Codex 工作的目录，然后启动 Antigravity。下面的路径只是示例。

```powershell
Set-Location 'C:\Work\MyProject'
agy --agent codex-agy
```

在 Antigravity 里发一个任务，例如「让 Codex 看一下这个目录，简单说明主要文件的用途，先保持文件原样。」

1. 桥接会在 Codex App 中打开当前目录的新会话，预填 Gemini 整理的任务。
2. 检查内容，保留开头的 `[AGY Codex task: …]` 标记，再点击**发送**。如果要选模型，可以在发送前在 Codex App 里选择。
3. 保持 Antigravity 对话打开。桥接找到这条 Codex 会话后会自动保存绑定，收到回执后交给 Gemini 验收和汇报。

### 绑定已有 Codex 会话

在 Codex App 打开目标会话，按 `Ctrl` + `Alt` + `L` 复制会话链接，再粘贴到 Antigravity。也可以用手头的完整会话 UUID。示例中的 UUID 请换成你自己的。[Codex 桌面快捷键](https://learn.chatgpt.com/docs/app/commands#keyboard-shortcuts)

```text
绑定这个 Codex 会话 codex://threads/00000000-0000-4000-8000-000000000001
```

Gemini 确认绑定和工作目录后，你就可以在 Antigravity 提任务。后续任务会进入该 Codex 会话的队列，使用其工作目录和模型设置。任务一直显示已入队时，打开对应的 Codex 会话查看。

### 日常操作

| 你想做什么 | 怎么操作 |
| --- | --- |
| 看当前绑在哪个会话 | 在 Antigravity 说「现在绑定的是哪个 Codex 会话？」 |
| 查最近的任务 | 说「查结果」或「继续」。有工单 ID 时也可以指定该工单。 |
| 换成另一个已有会话 | 发送新的 Codex 会话链接并要求绑定。 |
| 解除当前绑定 | 说「取消绑定」或「解绑」。已派发的工单仍可查询。 |
| 改用一个新会话 | 说「新开一个 Codex 会话处理」，到 App 发送预填的首条任务。 |
| 退出后恢复绑定 | 用 `/resume` 选回原来的 Antigravity 对话。也可以在同一目录运行 `agy --agent codex-agy -c` 恢复最近的对话，或用 `--conversation` 加对话 ID 精确恢复。 |

绑定按 Antigravity 对话保存。同一目录可以有多条对话，各自绑定不同的 Codex 会话。

## 完成通知、文件和本地数据

- **等待与汇报。** 保持 Antigravity 对话打开，Gemini 会后台等待回执，每次最多一小时。收到回执后，Gemini 会结合原任务、Codex 的回复及有权限读取的产物验收。常规且已授权的细节可以直接跟进。涉及范围变更、重要取舍或 Codex App 审批时，Gemini 会请你处理。退出 Antigravity 后，可恢复原对话并说「查结果」。
- **图片和文件。** 把材料保存到 Codex 能访问的本机目录，在请求中写清完整路径，例如 `C:\Work\MyProject\reference.png`。桥接当前传递文本工单和回执，文件留在本机，Codex 按路径读取。需要把图片作为原生附件时，可以在 Codex App 手动添加。
- **配置和记录。** 全局配置位于 `%USERPROFILE%\.gemini\config\`，绑定、任务状态和文字回执默认保存在安装目录的 `.state\bridge.sqlite`。桥接随 Antigravity 启动，无需单独设置开机自启。任务内容仍由 Antigravity 和 Codex 各自的模型服务处理。

## 常见问题

| 遇到的情况 | 可以怎么处理 |
| --- | --- |
| `Agent Not Found` | 在工作目录运行 `agy agents` 和 `agy mcp list`，检查是否有 `codex-agy` 和 `codex_bridge`。如果还没全局安装，回到桥接安装目录运行 `.\Install.ps1 -Global`，再打开一个新的 Antigravity 进程。 |
| 执行策略阻止 ZIP 中的脚本 | 确认 ZIP 来自本仓库并审阅 `Install.ps1` 后，在桥接目录运行 `Unblock-File -LiteralPath .\Install.ps1`，再执行安装。 |
| `Get-Command codex.exe` 找不到命令，或 `queue` 不可用 | 按上面的官方指南安装或更新 Windows 版 Codex CLI，再打开新终端确认。 |
| Codex 做完了，Antigravity 还没汇报 | 在原对话说「查结果」。如果刚创建的会话仍在等待发送，到 Codex App 发送预填任务。如果仍显示运行中，查看 Codex App 是否在等审批。 |
| 是否需要启用 Codex 钩子 | 日常完成汇报由 Antigravity 后台等待提供，已配置的 `AGY Codex Bridge` 钩子可以在 Codex App 中关闭。项目钩子可更早记录接单和完成。当前版本还通过钩子记录手动中断。如果需要这些事件，可运行 `.\Install.ps1 -Workspace <项目目录>` 配置，再在 Codex App 中启用。 |

第三方依赖的许可声明见 [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)。
