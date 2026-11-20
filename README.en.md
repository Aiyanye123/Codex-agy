# Codex-agy

[简体中文](README.md) · **English**

Codex-agy connects Antigravity CLI to Codex App on Windows. Describe what you need in Antigravity. Gemini turns your request into a task with clear acceptance criteria, and Codex works in your project. Gemini can check what Codex delivered, follow up on missing work, and report back in the original Antigravity conversation. The bundled agent is configured to report in Simplified Chinese.

## Installation

Set up these tools on the same Windows computer, then sign in to Antigravity and Codex.

| Requirement | Where to get it |
| --- | --- |
| PowerShell 7 | [Microsoft installation guide](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows) |
| Node.js 22.13 or newer, with 24 LTS recommended | [Node.js downloads](https://nodejs.org/en/download) |
| Antigravity CLI, preferably 1.5.13 or newer | [Google Antigravity installation guide](https://antigravity.google/docs/cli/tutorial) |
| Codex App, or Codex in the ChatGPT desktop app | [OpenAI's Windows desktop installation guide](https://learn.chatgpt.com/docs/windows/windows-app) |
| Codex CLI with `queue` support, preferably from the standalone Windows installer | [OpenAI's Codex CLI installation guide](https://learn.chatgpt.com/docs/cli) |

Open a new **PowerShell 7** window and check the commands below. `Get-Command` should find `codex.exe`, and `codex.exe queue --help` should show `--thread` and `--message`. The verified combination uses Antigravity CLI 1.5.13, Codex CLI 0.166.0, and Node.js 24.18.0.

```powershell
node --version
agy --version
Get-Command codex.exe
codex.exe queue --help
```

### Install manually

On GitHub, choose **Code → Download ZIP** and extract it to a folder you can keep. Open that folder in PowerShell 7. If you have Git, you can also run these commands from the folder where you want to keep the bridge.

```powershell
git clone https://github.com/Aiyanye123/Codex-agy.git
Set-Location .\Codex-agy
```

Run the installer once from the folder containing `Install.ps1`. The repository includes the files the bridge needs at runtime.

```powershell
.\Install.ps1 -Global
```

Global installation applies to the current Windows user. You can then start `codex-agy` from any working folder. Keep the bridge's installation folder in place because Antigravity references files there.

### Ask an agent to install it

Copy this prompt into an agent that can use your Windows terminal, such as Codex App.

```text
Install Codex-agy for my current user on this Windows computer.
The repository is https://github.com/Aiyanye123/Codex-agy . Read its README and follow the installation instructions.
If you are already in a local copy of the project, use it. Otherwise, clone it with Git or download the ZIP into a permanent folder my user can write to. Preserve any existing configuration and session database.
Check for PowerShell 7, Node.js 22.13+, Antigravity CLI, Codex App, and an executable codex.exe. Run codex.exe queue --help to check queue support. Use the official Windows guides linked in the README to install missing prerequisites. If I need to sign in or respond to a system prompt, tell me exactly what to do.
Run .\Install.ps1 -Global in PowerShell 7 from the project folder. If the installer detects a configuration conflict, preserve the existing configuration and tell me where it is.
Use agy agents and agy mcp list to verify that codex-agy and codex_bridge are available. Tell me where the bridge is installed, what you verified, and how to run agy --agent codex-agy from my work folder. Verify the installation without dispatching a real task.
```

## Quick start

### Start a new Codex chat in your working folder

In PowerShell 7, go to the folder where you want Codex to work and start Antigravity. Replace the example path with yours.

```powershell
Set-Location 'C:\Work\MyProject'
agy --agent codex-agy
```

Give Antigravity a task, such as “Ask Codex to inspect this folder and briefly explain the main files. Leave the files as they are.”

1. The bridge opens a new chat for the current folder in Codex App and fills in the task Gemini prepared.
2. Review the text, keep the `[AGY Codex task: …]` marker at the top, and click **Send**. You can select a model in Codex App first.
3. Leave the Antigravity conversation open. The bridge saves the binding when it finds the new Codex chat and returns the reply to Gemini for review.

### Bind an existing Codex chat

Open the target chat in Codex App. Press `Ctrl` + `Alt` + `L` to copy its link and paste it into Antigravity. You can also explicitly ask to bind a full chat UUID. Replace the sample UUID with your own. [Codex desktop keyboard shortcuts](https://learn.chatgpt.com/docs/app/commands#keyboard-shortcuts)

```text
Bind this Codex chat codex://threads/00000000-0000-4000-8000-000000000001
```

After Gemini confirms the binding and working folder, give Antigravity a task. Subsequent tasks go to that Codex chat's queue and use its working folder and model settings. If a task stays queued, open the target chat in Codex App.

### Everyday commands

| What you want | What to do |
| --- | --- |
| Check which chat is bound | Ask “Which Codex chat is bound?” |
| Check the latest task | Say “Check the result” or “Continue.” You can also specify a task ID. |
| Switch to another existing chat | Send the new Codex chat link and ask to bind it. |
| Remove the current binding | Say “Unbind.” Previously dispatched tasks remain available to check. |
| Switch to a new chat | Say “Start a new Codex chat for this task,” then send the prepared first message in the app. |
| Resume after exiting | Use `/resume` to select the original Antigravity conversation. In the same folder, `agy --agent codex-agy -c` resumes the most recent conversation. To pick a specific one by ID, use `--conversation` followed by the ID. |

Bindings are saved per Antigravity conversation. Conversations started from the same folder can target different Codex chats.

## Completion, files, and local data

- **Waiting and reporting.** While the Antigravity conversation is open, Gemini can wait for a reply in the background for up to an hour at a time. Gemini reviews the original task, the Codex reply, and any deliverables it can access. It can follow up on routine work you already authorized. It will ask about scope changes, material decisions, or approvals in Codex App. If you exit Antigravity, resume the original conversation and say “Check the result.”
- **Images and files.** Save the material in a local folder Codex can access and include the full path in your request, such as `C:\Work\MyProject\reference.png`. The bridge carries text tasks and replies. Files stay on your computer, and Codex can read them by path. To attach an image directly to a chat, add it in Codex App.
- **Configuration and records.** Global configuration lives under `%USERPROFILE%\.gemini\config\`. Bindings, task state, and text replies are stored in `.state\bridge.sqlite` under the installation folder by default. The bridge starts with Antigravity and requires no separate startup service. Antigravity and Codex still use their respective model services to process tasks.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `Agent Not Found` | From your working folder, run `agy agents` and `agy mcp list` and look for `codex-agy` and `codex_bridge`. If you have yet to install globally, run `.\Install.ps1 -Global` from the bridge folder and start a fresh Antigravity process. |
| PowerShell blocks the script from a ZIP | Confirm the ZIP came from this repository and review `Install.ps1`. In the bridge folder, run `Unblock-File -LiteralPath .\Install.ps1`, then run the installer. |
| `Get-Command codex.exe` finds nothing, or `queue` is unavailable | Install or update the Windows Codex CLI using the official guide above, then check again in a new terminal. |
| Codex finished but Antigravity is quiet | Say “Check the result” in the original conversation. If a new chat is waiting for the draft to be sent, send it in Codex App. If the task still appears to be running, check the app for a pending approval. |
| You're wondering whether to enable Codex hooks | The global install is enough for regular bridging and background replies. To also record accept, finish, or interrupt events in a particular project, run `.\Install.ps1 -Workspace <project-folder>` from the bridge folder, then review and enable the relevant entries in Codex App's hook settings. |

See [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) for third-party notices.
