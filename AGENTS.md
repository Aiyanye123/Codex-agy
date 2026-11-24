# Agent guide

This project connects Antigravity CLI to Codex App on Windows. It opens desktop drafts for new chats, uses `codex queue` for bound chats, and tracks tasks in SQLite. It runs without a persistent background service.

## Repository map

- `core.cjs` owns SQLite schema and migration, bindings, task transitions, and Codex process helpers.
- `src/mcp-entry.mjs` defines the MCP tools. `mcp.cjs` is the tracked bundle used by the installer.
- `src/worktree.mjs` inspects linked Git worktrees and creates isolated checkouts for new chats.
- `src/task-state.mjs` reconciles tasks with Codex history. `src/receipt.mjs` extracts replies and formats receipts.
- `src/workspace-search.mjs` provides read-only search in the Antigravity workspace.
- `hook.cjs` records Codex hook events. `Install.ps1` configures the bridge and optional project hooks.
- `src/agent.md` guides the Antigravity coordinator. `README.md` and `README.zh-CN.md` document installation and usage.

## Build and verify

- Use PowerShell 7, Node.js 22.13 or later with `node:sqlite`, and a Windows `codex.exe` that supports `queue`. Git must be on PATH to create worktrees.
- Run `npm run build` after changing `src/mcp-entry.mjs` or any bundled `src/*.mjs` dependency. Include the regenerated `mcp.cjs`.
- Review the changed code first. Verify only the affected behavior, using an independent temporary state directory and a disposable Git repository for worktree checks.
- Update `src/agent.md`, `README.md`, and `README.zh-CN.md` when changing an MCP tool contract.

## Runtime and data boundaries

- Never read, write, or migrate the live `.state\bridge.sqlite` directly during development or verification. Use a separate Git worktree for schema and hook changes so installed MCP commands and project hooks can keep using the active checkout.
- Run `Install.ps1 -Global` only with explicit user authorization.
- Preserve user worktrees and uncommitted changes. Leave worktree cleanup to the user, and move individual files to the Recycle Bin when deletion is authorized.
- Cross-process history may report an active turn as `interrupted` with no valid `completedAt`. Keep the task open until history records a valid completion time or a matching Interrupt hook confirms the interruption.
