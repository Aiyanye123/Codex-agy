# antigravity-codex-bridge

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

antigravity-codex-bridge connects Antigravity CLI to Codex on Windows, macOS, and Linux so Gemini can coordinate and review work that Codex performs in your project.

- Gemini prepares and dispatches tasks, waits in the background, checks results, and follows up on gaps. It receives a short receipt by default to save context and can fetch the full reply on request.
- Open or bind Codex chats in a default session and any number of named sessions. Independent tasks can run in separate Git worktrees.
- Gemini can gather evidence and perform authorized routine Git operations with Antigravity's native terminal. Codex handles source edits, code review, builds, tests, and long materials.
- The bridge runs locally without a persistent background service. It keeps bindings and task records in SQLite and clears stored reply text from finished tasks after 30 days.

## Installation

Set up these tools on the same computer, then sign in to Antigravity and Codex.

| Requirement | Where to get it |
| --- | --- |
| Node.js 22.13 or newer, with 24 LTS recommended | [Node.js downloads](https://nodejs.org/en/download) |
| Antigravity CLI, preferably 1.5.13 or newer | [Google Antigravity installation guide](https://antigravity.google/docs/cli/tutorial) |
| Native Codex CLI with `app-server` and `queue` support | [OpenAI's Codex CLI installation guide](https://learn.chatgpt.com/docs/cli) |
| ChatGPT desktop app with Codex, for desktop mode. On Linux the desktop app is in Preview and the bridge uses `xdg-open`. | [Windows](https://learn.chatgpt.com/docs/windows/windows-app) · [macOS](https://learn.chatgpt.com/docs/app) · [Linux](https://learn.chatgpt.com/docs/linux/linux-app) |
| PowerShell 7, if using the Windows `Install.ps1` wrapper | [Microsoft installation guide](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows) |
| Git, for creating separate worktrees | [Git downloads](https://git-scm.com/downloads) |

In a new terminal, check the commands below. The `queue` help should list `--thread` and `--message`. The bridge uses the Codex CLI 0.171.0 direct-execution protocol. On Windows, `Get-Command codex.exe` should find a native executable.

```text
node --version
agy --version
codex queue --help
codex app-server --help
```

### Install manually

On GitHub, choose **Code → Download ZIP** and extract it to a folder you can keep. You can also clone the repository with Git.

```sh
git clone https://github.com/Aiyanye123/antigravity-codex-bridge.git
cd antigravity-codex-bridge
```

From the bridge directory, run the installer for the current user. The repository includes the runtime files.

```text
node install.mjs --global
```

The existing PowerShell 7 entry point on Windows accepts the same settings.

```powershell
.\Install.ps1 -Global
```

Start `agy --agent agydex` from the folder where Codex should work. To scope the bridge to one project, run `node install.mjs --workspace <path>` from the bridge directory. Keep the bridge's installation folder in place because Antigravity references files there.

### Use Codex CLI without the desktop app

Add `--default-mode direct` to the installation command for CLI-only execution. Use `node install.mjs --global --default-mode direct`, or `.\Install.ps1 -Global -DefaultMode direct` in PowerShell. This mode starts new turns through Codex CLI and can run over SSH or on a headless host. To restore desktop as the default, rerun the same installation scope with `--default-mode desktop` or `-DefaultMode desktop`. Restart Antigravity after changing the installation. The default applies to new chats and new bindings. To change an existing binding, tell Antigravity to use direct or desktop mode for its next task.

To upgrade, update the bridge files in the same folder and rerun the install command with the desired default mode, then restart Antigravity. Repeat for any workspace installs. The installer keeps the state directory recorded in a managed configuration unless you pass `--state-directory <path>`. It refreshes the managed agent and MCP settings, keeps other MCP servers, and stops on an edited agent or conflicting server.

When upgrading from `codex-agy`, the installer adds `agydex` alongside the old agent and keeps using the existing database when you install in place with the same settings.

### Ask an agent to install it

Copy this prompt into an agent that can use your local terminal.

```text
Install antigravity-codex-bridge for my current user on this computer.
Read and follow the README at https://github.com/Aiyanye123/antigravity-codex-bridge
If you are already in a local copy of the project, use it. Otherwise, clone it with Git or download the ZIP into a permanent folder my user can write to. Preserve any existing configuration and session database.
Check for Node.js 22.13+, Antigravity CLI, and the native Codex CLI. Check codex queue --help and codex app-server --help. For desktop mode, check the desktop app. Use the official guides linked in the README for missing prerequisites and tell me if sign-in or a system prompt needs my attention.
Run node install.mjs --global from the bridge folder. Add --default-mode direct if I asked for CLI-only operation. If there is a configuration conflict, preserve the existing files and tell me where it is.
Use agy agents and agy mcp list to verify that agydex and codex_bridge are available. Tell me where the bridge is installed, what you verified, and how to run agy --agent agydex from my work folder. Verify the installation without dispatching a real task.
```

## Quick start

### Start a new Codex chat in your working folder

Go to the folder where you want Codex to work and start Antigravity. Use your actual project path, for example `C:\Work\MyProject` on Windows or `~/Work/MyProject` on macOS or Linux.

```sh
cd ~/Work/MyProject
agy --agent agydex
```

Give Antigravity a task, such as “Ask Codex to inspect this folder and briefly explain the main files. Leave the files as they are.”

In desktop mode, the bridge opens a new chat with a prefilled draft. Review the text, keep the task marker, then click **Send**. In direct mode, Codex CLI starts the turn immediately.

### Bind an existing Codex chat

To copy the active chat's link in the desktop app, press `⌘` + `⌥` + `L` on macOS or `Ctrl` + `Alt` + `L` on Windows and Linux. In a CLI-only setup, give Antigravity the full UUID of the saved Codex session. [Codex desktop keyboard shortcuts](https://learn.chatgpt.com/docs/reference/commands#keyboard-shortcuts)

```text
Bind this Codex chat codex://threads/00000000-0000-4000-8000-000000000001
```

After Gemini confirms the binding and working folder, give Antigravity a task. In desktop mode, tasks go to that Codex chat's queue and use its working folder and model settings. If a task stays queued, open the target chat in Codex App.

### Direct execution and approvals

To switch to direct execution, ask Antigravity to use direct mode (`submit` with `execution_mode: "direct"`). It starts the task immediately in a new or existing chat. Later tasks on the same binding keep using direct mode. To switch back, ask Antigravity to use desktop mode (`execution_mode: "desktop"`).

Direct turns use Codex's local settings unless you explicitly request a different `sandbox` or `approval_policy`. Desktop submissions reject those overrides and use the desktop chat's settings. An explicit read-only or workspace-write sandbox uses MXC for the child process on Windows. Keep Antigravity open for approval requests and the final receipt. You can ask Gemini to steer or interrupt an active direct turn. When Codex asks for approval or an answer, Gemini shows the specific request, sends your decision through `approve`, and resumes waiting.

The bridge releases the write connection when a direct turn finishes. Opening the chat in Codex App can take that connection. If the next direct task encounters an active writer, the bridge can queue it once under the existing chat's permissions. With an explicit sandbox or approval override, it reports the conflict and waits for the user to decide whether to queue separately.

### Run tasks in parallel

Keep using the default session for everyday work. For parallel work, ask Antigravity to send each task to a different named session, such as `docs` and `feature-a`. Name the same session when checking progress, reopening its draft, or following up. Ask for all bindings to see each session's chat and working directory. Existing bindings and tasks are assigned to `default` when the database upgrades.

To isolate changes, ask for a new session in a Git worktree. Git must be on PATH and the current checkout must have a commit. The bridge creates a sibling of the main checkout named like `MyProject-agy-<task-id>`, on branch `agy/<task-id>` from the current checkout's HEAD. Uncommitted files stay in the current checkout. You can also bind a chat that already uses a worktree. Unbinding or dismissing a task leaves the worktree and branch on disk for you to merge or clean up.

Project hooks are optional. To record worktree activity through hooks, run the hooks-only installer for the worktree path with the same state directory, then review and enable the hooks in Codex App.

### Everyday commands

| What you want | What to do |
| --- | --- |
| Check which chat is bound | Ask “Which Codex chat is bound?” |
| Check progress or results | Say “Check progress” for status, “Check the result” for the receipt summary, or “Show the full receipt” for the original reply. You can specify a task ID. |
| Review a bound chat | Ask what you last discussed in the bound Codex chat. The bridge returns up to six completed replies, each with a short question excerpt and reply. |
| See recent tasks | Ask “List my tasks.” The list includes IDs, states, folders and UTC timestamps. Historical times that were never recorded appear as unknown. |
| Reopen an unsent first task | Say “Resume draft” with the task ID. The bridge keeps the draft text locally until it is accepted or dismissed. Click Send in only one window. Older drafts without saved text can be sent from the original window. |
| Abandon a draft or stop tracking | Give the task ID and say “Abandon this draft” or “Stop tracking.” Close any abandoned draft in the app. A task already sent to Codex can keep running. |
| Switch to another existing chat | Send the new Codex chat link and ask to bind it. |
| Remove the current binding | Say “Unbind.” Previously dispatched tasks remain available to check. |
| Switch to a new chat | Say “Start a new Codex chat for this task.” This opens a draft in Codex App. Ask for direct mode to send immediately. |
| Resume after exiting | Use `/resume` to select the original Antigravity conversation. In the same folder, `agy --agent agydex -c` resumes the most recent conversation. To pick a specific one by ID, use `--conversation` followed by the ID. |

### Terminal and bridge tools

The `agydex` agent enables Antigravity's terminal with `commandExecutionPolicy: sandbox`, subject to Antigravity's own sandbox and permissions. Its built-in tool list includes file viewing and search. Gemini limits commands to read-only checks in the Antigravity workspace and authorized routine Git operations. It skips credentials, lockfiles, and links, and limits output. For targeted checks, the terminal can use optional `rg` for text and `rga` for formats supported by its installed adapters. Check availability with `rg --version` and `rga --version`. Short Office documents can also be read with an available read-only parser. [ripgrep-all](https://github.com/phiresky/ripgrep-all)

Gemini delegates source edits, code review, builds, tests, work in other folders, and lengthy reviews to Codex. Before writing to Git, it checks whether a Codex task is active in the same worktree. Pulls and merges must be fast-forward, and pushes require explicit user authorization for the destination branch. Force pushes, `reset --hard`, `clean`, and history rewrites are prohibited.

The bridge's 12 MCP tools cover sessions and tasks through `bind`, `unbind`, `submit`, `status`, `list_tasks`, `recent_replies`, `dismiss`, `resume_draft`, `steer`, `interrupt`, `approve`, and `watch`.

## Completion, files, and local data

- **Waiting and reporting.** While the Antigravity conversation is open, Gemini can wait for a reply in the background for up to an hour at a time. Gemini checks the Codex reply against your request, follows up on gaps, and summarizes the outcome in Simplified Chinese. It can consult a document or a named result file when needed. It can follow up on routine work you already authorized. It will ask about scope changes, material decisions, or approvals in Codex App. If you exit Antigravity, resume the original conversation and say “Check the result.”
- **Images and files.** Save the material in a local folder Codex can access and include the full path in your request, such as `C:\Work\MyProject\reference.png` or `/home/you/Work/MyProject/reference.png`. The bridge carries text tasks and replies. Files stay on your computer, and Codex can read them by path. To attach an image directly to a chat, add it in Codex App.
- **Configuration and records.** Global configuration lives in `~/.gemini/config` (`%USERPROFILE%\.gemini\config` on Windows). Workspace configuration lives in `.agents` under the project. Bindings, task state, and replies are stored in `.state/bridge.sqlite` under the bridge installation folder by default. On startup, the bridge clears local reply text from finished tasks last updated over 30 days ago. Task records and bindings are kept. The bridge starts with Antigravity. Each tool uses its own model service to process tasks.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `Agent Not Found` | From your working folder, run `agy agents` and `agy mcp list` and look for `agydex` and `codex_bridge`. Run the installer for the intended scope, then start a fresh Antigravity process from that folder. |
| PowerShell blocks `Install.ps1` from a ZIP | Use the Node install command for your scope, such as `node install.mjs --global`. You can also review the script and use `Unblock-File -LiteralPath .\Install.ps1` before rerunning the wrapper. |
| Codex CLI probes fail | Install or update the native Codex CLI using the official guide above. On Windows, verify `Get-Command codex.exe`. On macOS or Linux, use `command -v codex`. |
| Linux cannot open a desktop draft | In a desktop session, check `xdg-open` and the `codex://` association. Over SSH or on a headless host, ask for direct execution or set `--default-mode direct`. If the opener timed out, check for the original draft before resending. |
| `thread/read: thread not loaded` | For desktop mode, open the bound chat in Codex App and retry. For CLI-only use, try direct mode or bind a session the local CLI can read. |
| Codex finished but Antigravity is quiet | Say “Check the result” in the original conversation. For a desktop draft, send it in Codex App. Approvals for direct turns appear in Antigravity. Approvals for desktop turns appear in Codex App. |
| You're wondering whether to enable Codex hooks | Antigravity's background wait handles normal completion reports. Project hooks can record acceptance and completion earlier, and record manual interruptions. From the bridge directory, run `node install.mjs --workspace <path> --hooks-only` and give it the same `--state-directory` if you customized it. Review and enable the hooks in Codex Settings or with `/hooks`. |

## License

antigravity-codex-bridge is released under the [MIT License](LICENSE). See [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) for third-party notices.
