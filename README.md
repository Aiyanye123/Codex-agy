# antigravity-codex-bridge

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

antigravity-codex-bridge connects Antigravity CLI and Codex App on your Windows PC so Gemini can coordinate and review work that Codex performs in your project.

- Gemini prepares and dispatches tasks, waits in the background, checks results, and follows up on gaps. It receives a short receipt by default to save context and can fetch the full reply on request.
- Open or bind Codex chats in a default session and any number of named sessions. Independent tasks can run in separate Git worktrees.
- Optional read-only `rg` search stays within the current Antigravity workspace and skips common sensitive files. Codex handles code review and long materials.
- The bridge runs locally without a persistent background service. It keeps bindings and task records in SQLite and clears stored reply text from finished tasks after 30 days.

## Installation

Set up these tools on the same Windows computer, then sign in to Antigravity and Codex.

| Requirement | Where to get it |
| --- | --- |
| PowerShell 7 | [Microsoft installation guide](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows) |
| Node.js 22.13 or newer, with 24 LTS recommended | [Node.js downloads](https://nodejs.org/en/download) |
| Antigravity CLI, preferably 1.5.13 or newer | [Google Antigravity installation guide](https://antigravity.google/docs/cli/tutorial) |
| Codex App, or Codex in the ChatGPT desktop app | [OpenAI's Windows desktop installation guide](https://learn.chatgpt.com/docs/windows/windows-app) |
| Codex CLI with `app-server` and `queue` support, preferably from the standalone Windows installer | [OpenAI's Codex CLI installation guide](https://learn.chatgpt.com/docs/cli) |

Open a new **PowerShell 7** window and check the commands below. `Get-Command` should find `codex.exe`, and `codex.exe queue --help` should show `--thread` and `--message`. The direct execution protocol uses Codex CLI 0.171.0.

```powershell
node --version
agy --version
Get-Command codex.exe
codex.exe queue --help
codex.exe app-server --help
```

### Install manually

On GitHub, choose **Code → Download ZIP** and extract it to a folder you can keep. Open that folder in PowerShell 7. If you have Git, you can also run these commands from the folder where you want to keep the bridge.

```powershell
git clone https://github.com/Aiyanye123/antigravity-codex-bridge.git
Set-Location .\antigravity-codex-bridge
```

Run the installer once from the folder containing `Install.ps1`. The repository includes the files the bridge needs at runtime.

```powershell
.\Install.ps1 -Global
```

Global installation applies to the current Windows user. You can then start `agy --agent agydex` from any working folder. Keep the bridge's installation folder in place because Antigravity references files there.

To upgrade, update the bridge files in the same folder and rerun the original install command, then restart Antigravity. If you also installed the bridge in a workspace, rerun its workspace install command too. The installer refreshes its own agent and MCP settings and keeps other MCP servers. If it detects an edited agent or a conflicting server, it stops and shows the file to review.

When upgrading from `codex-agy`, the installer adds `agydex` alongside the old agent and keeps using the existing database when you install in place with the same settings.

### Ask an agent to install it

Copy this prompt into an agent that can use your Windows terminal, such as Codex App.

```text
Install antigravity-codex-bridge for my current user on this Windows computer.
Read and follow the README at https://github.com/Aiyanye123/antigravity-codex-bridge
If you are already in a local copy of the project, use it. Otherwise, clone it with Git or download the ZIP into a permanent folder my user can write to. Preserve any existing configuration and session database.
Check for PowerShell 7, Node.js 22.13+, Antigravity CLI, Codex App, and an executable codex.exe. Run codex.exe queue --help to check queue support. Use the official Windows guides linked in the README to install missing prerequisites. If I need to sign in or respond to a system prompt, tell me exactly what to do.
Run .\Install.ps1 -Global in PowerShell 7 from the project folder. If the installer detects a configuration conflict, preserve the existing configuration and tell me where it is.
Use agy agents and agy mcp list to verify that agydex and codex_bridge are available. Tell me where the bridge is installed, what you verified, and how to run agy --agent agydex from my work folder. Verify the installation without dispatching a real task.
```

## Quick start

### Start a new Codex chat in your working folder

In PowerShell 7, go to the folder where you want Codex to work and start Antigravity. Replace the example path with yours.

```powershell
Set-Location 'C:\Work\MyProject'
agy --agent agydex
```

Give Antigravity a task, such as “Ask Codex to inspect this folder and briefly explain the main files. Leave the files as they are.”

By default, the bridge opens a new chat with a prefilled draft in Codex App. Review the text, keep the task marker, then click **Send**.

### Bind an existing Codex chat

Open the target chat in Codex App. Press `Ctrl` + `Alt` + `L` to copy its link and paste it into Antigravity. You can also explicitly ask to bind a full chat UUID. Replace the sample UUID with your own. [Codex desktop keyboard shortcuts](https://learn.chatgpt.com/docs/app/commands#keyboard-shortcuts)

```text
Bind this Codex chat codex://threads/00000000-0000-4000-8000-000000000001
```

After Gemini confirms the binding and working folder, give Antigravity a task. In desktop mode, tasks go to that Codex chat's queue and use its working folder and model settings. If a task stays queued, open the target chat in Codex App.

### Direct execution and approvals

To switch to direct execution, ask Antigravity to use direct mode (`submit` with `execution_mode: "direct"`). It starts the task immediately in a new or existing chat. Later tasks on the same binding keep using direct mode. To switch back, ask Antigravity to use desktop mode (`execution_mode: "desktop"`).

Direct turns use Codex's local settings unless you explicitly request a different `sandbox` or `approval_policy`. Desktop submissions reject those overrides and use the desktop chat's settings. An explicit read-only or workspace-write sandbox uses MXC for the child process on Windows. Keep Antigravity open for approval requests and the final receipt. You can ask Gemini to steer or interrupt an active direct turn. When Codex asks for approval or an answer, Gemini shows the specific request, sends your decision through `approve`, and resumes waiting.

The bridge releases the write connection when a direct turn finishes. Opening the chat in Codex App can take that connection. If the app holds it when the next direct task arrives, the bridge queues the task once and switches the binding to desktop mode. The desktop chat's sandbox and approval settings apply to that task.

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

With `rg.exe` on PATH, Gemini can search files, documents, code and configuration, or all text in the current Antigravity workspace. Try “Find references to `queueTask` under `src/` in `*.mjs` files.” Search supports a relative path, glob, case and whole-word matching, optional regular expressions, and up to two lines of context. Git-ignored files, symbolic links, common credentials, and lockfiles are skipped. Hidden project configuration such as `.github/` is searchable. A bound Codex chat in a different folder retains its own working directory. Ask Codex to inspect that folder or review lengthy material.

Use `search_workspace` with `mode: "rich"` and a literal `query` for `.docx`, `.xlsx`, and `.pptx` files. Use `path` or `glob` to narrow the search. To search PDF, EPUB, or ODT as well, optionally install ripgrep-all with its document adapters and confirm it is on PATH with `Get-Command rga.exe`. The bridge can search modern Office files with its built-in reader when `rga` is unavailable. Rich search honors ignore files when `rg` is on PATH and reports when it uses a directory scan. [ripgrep-all](https://github.com/phiresky/ripgrep-all)

Use `read_document` with a workspace-relative `path` to read Word headings, paragraphs and tables, Excel sheets, or PowerPoint slides and notes as compact Markdown. Excel first shows the sheet list and header previews. Pass `sheet` to read rows from one sheet, or `query` to search within that sheet or across the workbook. Use `start` and `limit` to page through items or matches, and use `next_start` to continue. Rich search and document reading skip sensitive paths, lockfiles and links and accept source files up to 20 MB. Use `view_file` for PDFs, or ask Codex to read older `.doc`, `.xls`, and `.ppt` files.

Use `git_inspect` to check status, diffs, history, a single commit, branches, worktrees, or stashes. File filters use literal paths relative to the Antigravity workspace. Operations that traverse working files reject Windows links and junctions in their scope. Inspection output is capped at 16 KiB and 240 lines, with a `truncated` flag.

Use `git_action` for authorized staging, unstaging, commits, branch creation and switching, fetches, fast-forward pulls and merges, stash and pop, and ordinary pushes. Staging and unstaging require `paths` or `all: true`. Worktree operations such as switching branches and committing use the whole worktree and its index. Writes pause while an unfinished bridge task is using the same Git worktree. Pushes require explicit user authorization for the destination branch and can update only that branch. The tools exclude history rewrites, forced pushes, and remote branch deletion.

## Completion, files, and local data

- **Waiting and reporting.** While the Antigravity conversation is open, Gemini can wait for a reply in the background for up to an hour at a time. Gemini checks the Codex reply against your request, follows up on gaps, and summarizes the outcome in Simplified Chinese. It can consult a document or a named result file when needed. It can follow up on routine work you already authorized. It will ask about scope changes, material decisions, or approvals in Codex App. If you exit Antigravity, resume the original conversation and say “Check the result.”
- **Images and files.** Save the material in a local folder Codex can access and include the full path in your request, such as `C:\Work\MyProject\reference.png`. The bridge carries text tasks and replies. Files stay on your computer, and Codex can read them by path. To attach an image directly to a chat, add it in Codex App.
- **Configuration and records.** Global configuration lives under `%USERPROFILE%\.gemini\config\`. Bindings, task state, and text replies are stored in `.state\bridge.sqlite` under the installation folder by default. On startup, the bridge clears local reply text from finished tasks last updated over 30 days ago. Task records and bindings are kept. The bridge starts with Antigravity and requires no separate startup service. Antigravity and Codex still use their respective model services to process tasks.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `Agent Not Found` | From your working folder, run `agy agents` and `agy mcp list` and look for `agydex` and `codex_bridge`. If you have yet to install globally, run `.\Install.ps1 -Global` from the bridge folder and start a fresh Antigravity process. |
| PowerShell blocks the script from a ZIP | Confirm the ZIP came from this repository and review `Install.ps1`. In the bridge folder, run `Unblock-File -LiteralPath .\Install.ps1`, then run the installer. |
| `Get-Command codex.exe` finds nothing, or `queue` is unavailable | Install or update the Windows Codex CLI using the official guide above, then check again in a new terminal. |
| `thread/read: thread not loaded` | Open the bound chat in Codex App and retry. If the chat is unavailable, bind a working chat or start a new one. |
| Codex finished but Antigravity is quiet | Say “Check the result” in the original conversation. For a desktop draft, send it in Codex App. Approvals for direct turns appear in Antigravity. Approvals for desktop turns appear in Codex App. |
| You're wondering whether to enable Codex hooks | Antigravity's background wait handles normal completion reports. You can disable existing `AGY Codex Bridge` hooks in Codex App. Project hooks can record acceptance and completion earlier, and the current version uses them to record manual interruptions. After a global install, run `.\Install.ps1 -Workspace 'C:\Work\MyProject' -HooksOnly` from the bridge folder, substituting your project path. This installs only the project hooks. Review and enable them in Codex App. If you set a custom `-StateDirectory`, use it here too. |

## License

antigravity-codex-bridge is released under the [MIT License](LICENSE). See [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) for third-party notices.
