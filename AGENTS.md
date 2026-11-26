# Agent guide

This project connects Antigravity CLI to Codex on Windows, macOS, and Linux. Desktop mode opens new chats as drafts for manual sending and uses `codex queue` for existing chats. Direct mode runs a per-turn `codex app-server` process. The bridge uses SQLite to track tasks and runs without a persistent background service.

## Repository map

- `core.cjs` owns SQLite schema and migration, bindings, task transitions, and Codex process helpers.
- `src/mcp-entry.mjs` defines `bind`, `unbind`, `submit`, `status`, `list_tasks`, `recent_replies`, `dismiss`, `resume_draft`, `steer`, `interrupt`, `approve`, and `watch`. `mcp.cjs` is the tracked bundle used by the installer.
- `src/direct-run.mjs` owns the write connection for a direct turn, including approvals, steering, interruption, and shutdown.
- `src/worktree.mjs` inspects linked Git worktrees and creates isolated checkouts for new chats.
- `src/task-state.mjs` reconciles tasks with Codex history. `src/receipt.mjs` extracts replies and formats receipts.
- `install.mjs` configures the bridge on all three platforms. `Install.ps1` forwards the Windows PowerShell arguments.
- `src/agent.md` guides the Antigravity coordinator. `README.md` and `README.zh-CN.md` document installation and usage.

## Build and verify

- Use Node.js 22.13 or later with `node:sqlite` and a native Codex CLI that supports `app-server` and `queue`. The Windows wrapper requires PowerShell 7. Git must be on PATH to create worktrees.
- Run `npm run build` after changing `src/mcp-entry.mjs` or any bundled `src/*.mjs` dependency. Include the regenerated `mcp.cjs`.
- Review the changed code first. Verify only the affected behavior, using an independent temporary state directory and a disposable Git repository for worktree checks.
- Update `src/agent.md`, `README.md`, and `README.zh-CN.md` when changing an MCP tool contract.

## Runtime and data boundaries

- Never read, write, or migrate the live `.state\bridge.sqlite` directly during development or verification. Use a separate Git worktree for schema changes so installed MCP commands can keep using the active checkout.
- Run a global install in the user's real configuration only with explicit authorization. Use an isolated home and state directory for installer tests.
- Preserve user worktrees and uncommitted changes. Leave worktree cleanup to the user, and move individual files to the Recycle Bin when deletion is authorized.
- The Antigravity coordinator uses its native terminal with `commandExecutionPolicy: sandbox`. Its tool list includes file viewers and search tools. Keep terminal commands scoped to read-only evidence gathering and authorized routine Git operations. Check for active Codex tasks in the same worktree before writing to Git and obtain explicit authorization for the destination branch before pushing. Keep commands away from sensitive files, cap their output, and delegate source edits, builds, and tests to Codex. `rg` and [ripgrep-all](https://github.com/phiresky/ripgrep-all) are optional.
- The runtime takes `<workspace> <state-db> <codex> [desktop|direct]`. The installer appends `direct` for `--default-mode direct`. The default applies to new chats and new bindings. Existing bindings keep their saved mode until an explicit switch or an automatic downgrade.
- Keep execution and history reads on separate connections. A direct turn keeps its slot and thread reserved until the writer exits. Queue once when resume returns an active-writer conflict before turn submission and the task has no explicit sandbox or approval-policy override. Report that the queued turn uses the desktop chat's policy. With an explicit override, report the conflict and let the user decide whether to queue separately.
- Keep approvals tied to the originating RPC connection and require the user's decision. Direct execution inherits Codex settings. For an explicitly requested restricted sandbox on Windows, pass MXC to the child process only.
- Cross-process history may report an active turn as `interrupted`. Treat that history state as terminal only when it includes a valid `completedAt`.
