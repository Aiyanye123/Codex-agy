const { execFile, spawn } = require("node:child_process");
const { realpathSync, statSync } = require("node:fs");
const { createInterface } = require("node:readline");
const { DatabaseSync } = require("node:sqlite");
const { promisify } = require("node:util");

const run = promisify(execFile);
const defaultSession = "default";
const bindingsSchema = `CREATE TABLE IF NOT EXISTS bindings (
  owner TEXT NOT NULL,
  session_name TEXT NOT NULL DEFAULT '${defaultSession}',
  thread_id TEXT,
  pending_task_id TEXT,
  workspace TEXT,
  repo_root TEXT,
  worktree_path TEXT,
  worktree_branch TEXT,
  worktree_base_commit TEXT,
  execution_mode TEXT NOT NULL DEFAULT 'desktop',
  PRIMARY KEY (owner, session_name)
)`;
const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const taskMarker = new RegExp(`^\\[AGY Codex task: (${uuid})\\]\\r?\\n`, "i");
// Clearing only a stored receipt is retention housekeeping, not a task update.
const taskChangedTrigger = `CREATE TRIGGER task_changed AFTER UPDATE OF state, detail, turn_id, thread_id, report ON tasks
    WHEN NEW.state IS NOT OLD.state OR NEW.detail IS NOT OLD.detail OR NEW.turn_id IS NOT OLD.turn_id
      OR NEW.thread_id IS NOT OLD.thread_id OR (NEW.report IS NOT OLD.report AND NEW.report IS NOT NULL) BEGIN
      UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
    END`;

function threadIdFrom(value) {
  const match = new RegExp(`^(?:codex://threads/)?(${uuid})/?$`, "i").exec(value.trim());
  if (!match) throw new Error("请提供 Codex 会话的深链接或完整 UUID。");
  return match[1].toLowerCase();
}

function workspacePath(value) {
  const path = realpathSync.native(value);
  if (!statSync(path).isDirectory()) throw new Error("工作路径必须是本机目录。");
  return path;
}

function sameWorkspace(first, second) {
  try {
    const left = workspacePath(first);
    const right = workspacePath(second);
    if (left === right) return true;
    const a = statSync(left, { bigint: true });
    const b = statSync(right, { bigint: true });
    return a.isDirectory() && b.isDirectory() && a.ino > 0n && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function openDatabase(path) {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    ${bindingsSchema};
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      session_name TEXT NOT NULL DEFAULT '${defaultSession}',
      workspace TEXT NOT NULL,
      thread_id TEXT,
      turn_id TEXT,
      state TEXT NOT NULL,
      report TEXT,
      detail TEXT,
      dispatch_deadline INTEGER,
      draft_prompt TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'desktop',
      desktop_fallback INTEGER NOT NULL DEFAULT 0,
      writer_pid INTEGER,
      approvals_json TEXT,
      tool_results_json TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  const columns = {
    dispatch_deadline: "INTEGER", draft_prompt: "TEXT", created_at: "TEXT", updated_at: "TEXT",
    session_name: `TEXT NOT NULL DEFAULT '${defaultSession}'`,
    execution_mode: "TEXT NOT NULL DEFAULT 'desktop'",
    desktop_fallback: "INTEGER NOT NULL DEFAULT 0",
    writer_pid: "INTEGER",
    approvals_json: "TEXT",
    tool_results_json: "TEXT",
  };
  const tableColumns = () => new Set(database.prepare("PRAGMA table_info(tasks)").all().map((col) => col.name));
  const bindingColumns = () => new Set(database.prepare("PRAGMA table_info(bindings)").all().map((col) => col.name));
  const existing = tableColumns();
  if (!bindingColumns().has("execution_mode") || Object.keys(columns).some((name) => !existing.has(name))) {
    transaction(database, () => {
      const currentBindings = bindingColumns();
      if (!currentBindings.has("session_name")) {
        database.exec(`
          ALTER TABLE bindings RENAME TO legacy_bindings;
          ${bindingsSchema};
          INSERT INTO bindings (owner, thread_id, pending_task_id)
            SELECT owner, thread_id, pending_task_id FROM legacy_bindings;
          DROP TABLE legacy_bindings;
        `);
      } else if (!currentBindings.has("execution_mode")) {
        database.exec("ALTER TABLE bindings ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'desktop'");
      }
      const current = tableColumns();
      for (const [name, type] of Object.entries(columns)) {
        if (!current.has(name)) database.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
      }
    });
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS direct_writer_slot ON tasks(owner, session_name) WHERE writer_pid IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS direct_writer_thread ON tasks(thread_id) WHERE writer_pid IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS task_created AFTER INSERT ON tasks BEGIN
      UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS preserve_dismissed BEFORE UPDATE OF state ON tasks
    WHEN OLD.state IN ('cancelled','dismissed') AND NEW.state <> OLD.state BEGIN
      SELECT RAISE(IGNORE);
    END;
  `);
  const readTaskChanged = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'task_changed'");
  if (readTaskChanged.get()?.sql !== taskChangedTrigger) {
    transaction(database, () => {
      if (readTaskChanged.get()?.sql === taskChangedTrigger) return;
      database.exec(`DROP TRIGGER IF EXISTS task_changed;\n${taskChangedTrigger}`);
    });
  }
  return database;
}

function transaction(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function getBinding(database, owner, sessionName = defaultSession) {
  return database.prepare("SELECT * FROM bindings WHERE owner = ? AND session_name = ?").get(owner, sessionName);
}

function saveBinding(database, owner, sessionName, threadId, pendingTaskId, workspace, worktree, executionMode = "desktop") {
  database.prepare(`
    INSERT INTO bindings (owner, session_name, thread_id, pending_task_id, workspace,
      repo_root, worktree_path, worktree_branch, worktree_base_commit, execution_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner, session_name) DO UPDATE SET thread_id = excluded.thread_id,
      pending_task_id = excluded.pending_task_id, workspace = excluded.workspace,
      repo_root = excluded.repo_root, worktree_path = excluded.worktree_path,
      worktree_branch = excluded.worktree_branch, worktree_base_commit = excluded.worktree_base_commit,
      execution_mode = excluded.execution_mode
  `).run(owner, sessionName, threadId, pendingTaskId, workspace,
    worktree?.repo_root ?? null, worktree?.path ?? null, worktree?.branch ?? null, worktree?.base_commit ?? null, executionMode);
}

function bindThread(database, owner, threadId, sessionName = defaultSession, workspace = null, worktree = null, executionMode = "desktop") {
  saveBinding(database, owner, sessionName, threadId, null, workspace, worktree, executionMode);
}

function bindingWorktree(binding) {
  if (!binding?.worktree_path) return null;
  return {
    repo_root: binding.repo_root, path: binding.worktree_path,
    branch: binding.worktree_branch, base_commit: binding.worktree_base_commit,
  };
}

function markAccepted(database, taskId, threadId, turnId, writerPid = null) {
  const update = database.prepare(`
    UPDATE tasks SET thread_id = ?, turn_id = ?, state = 'running', detail = NULL, draft_prompt = NULL
    WHERE id = ? AND turn_id IS NULL AND writer_pid IS ? AND (thread_id IS NULL OR thread_id = ?)
      AND state IN ('awaiting_send','dispatching','queued','dispatch_unknown','running')
  `).run(threadId, turnId, taskId, writerPid, threadId);
  if (update.changes) {
    database.prepare(`
      UPDATE bindings SET thread_id = ?, pending_task_id = NULL,
        workspace = (SELECT workspace FROM tasks WHERE id = ?)
      WHERE pending_task_id = ? AND (owner, session_name) = (SELECT owner, session_name FROM tasks WHERE id = ?)
    `).run(threadId, taskId, taskId, taskId);
  }
}

function recordResult(database, taskId, state, report, detail = null) {
  database.prepare(`
    UPDATE tasks SET state = ?, report = ?, detail = ?
    WHERE id = ? AND writer_pid IS NULL AND turn_id IS NOT NULL AND state IN ('running','dispatch_unknown')
  `).run(state, report, detail, taskId);
}

async function startDesktop(uri, { platform = process.platform, spawnProcess = spawn, env = process.env, timeout = 10000 } = {}) {
  const directHint = '没有可用桌面时，可指定 execution_mode: "direct"。';
  let command;
  let args = [uri];
  if (platform === "win32") {
    command = "powershell.exe";
    args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:AGY_CODEX_BRIDGE_URL"];
    env = { ...env, AGY_CODEX_BRIDGE_URL: uri };
  } else if (platform === "darwin") {
    command = "/usr/bin/open";
  } else if (platform === "linux") {
    command = "xdg-open";
  } else {
    throw new Error(`当前平台没有 Codex 桌面打开器。${directHint}`);
  }

  const failed = reason => new Error(`未打开 Codex 桌面草稿：${reason}。${directHint}`);
  const launchError = error => failed(error.code === "ENOENT" ? `找不到 ${command}` : `无法启动 ${command}`);
  let child;
  try {
    child = spawnProcess(command, args, { env, windowsHide: true, stdio: "ignore" });
  } catch (error) {
    throw launchError(error);
  }
  let timer;
  const result = new Promise((resolve, reject) => {
    child.once("error", error => reject(launchError(error)));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else if (signal) {
        reject(unconfirmedDesktop(`打开器因 ${signal} 退出`));
      } else if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
        reject(failed("xdg-open 失败，当前进程可能没有可用图形会话"));
      } else {
        reject(failed(`${command} 返回 ${code}，请检查 Codex App 和 codex:// 协议关联`));
      }
    });
    timer = setTimeout(() => {
      // xdg-open can stay alive while the desktop application is already open.
      child.unref();
      reject(unconfirmedDesktop("打开器响应超时"));
    }, timeout);
  });
  return result.finally(() => clearTimeout(timer));
}

function unconfirmedDesktop(reason) {
  return Object.assign(new Error(`桌面草稿状态未确认：${reason}。请先在 Codex App 检查原草稿，避免重复发送。`), {
    code: "DESKTOP_OPEN_UNCONFIRMED",
  });
}

function queueTask(codex, workspace, threadId, prompt) {
  return run(codex, ["queue", "--thread", threadId, "--message", prompt], {
    cwd: workspace,
    windowsHide: true,
    timeout: 15000,
  });
}

function waitForExit(exited, ms) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); });
  return Promise.race([exited, timeout]).finally(() => clearTimeout(timer));
}

function childLifecycle(child, platform = process.platform) {
  let resolveExit, resolveClose, outcome, drainTimer, closing;
  let pipesClosed = false;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const closed = new Promise(resolve => { resolveClose = resolve; });

  const finish = () => {
    pipesClosed = true;
    clearTimeout(drainTimer);
    resolveClose(outcome);
  };
  const closePipes = () => {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    finish();
  };
  const noteExit = result => {
    if (outcome) return;
    outcome = result;
    resolveExit(true);
    // Drain buffered JSONL after exit without waiting for inherited pipes indefinitely.
    if (!pipesClosed) drainTimer = setTimeout(closePipes, 100);
  };
  child.once("exit", (code, signal) => noteExit({ code, signal }));
  child.on("error", error => {
    if (!child.pid) noteExit({ error });
  });
  child.once("close", (code, signal) => {
    noteExit({ code, signal });
    finish();
  });

  async function stop(grace) {
    child.stdin.end();
    if (!await waitForExit(exited, grace)) {
      child.kill("SIGTERM");
      if (!await waitForExit(exited, 500) && platform !== "win32") {
        child.kill("SIGKILL");
        await waitForExit(exited, 500);
      }
    }
    if (!outcome) {
      child.unref();
      closePipes();
    }
    await closed;
    return Boolean(outcome);
  }
  return { closed, stop: grace => closing ??= stop(grace) };
}

class CodexReader {
  constructor(codex, spawnProcess = spawn) {
    this.codex = codex;
    this.spawnProcess = spawnProcess;
    this.nextId = 1;
    this.pending = new Map();
    this.retiring = new Set();
  }

  async read(method, params) {
    if (this.closed) throw new Error("Codex 历史读取连接已关闭。");
    if (!this.server) this.start();
    const server = this.server;
    await this.ready;
    if (this.server !== server) throw new Error("Codex 历史读取进程已断开。");
    return this.request(method, params);
  }

  start() {
    const server = this.spawnProcess(this.codex, ["app-server", "--listen", "stdio://"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.server = server;
    const lifecycle = childLifecycle(server);
    let stderr = "";
    server.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
    const diagnostic = (error) => stderr.trim() ? new Error(`${error.message} (stderr: ${stderr.trim()})`) : error;
    const fail = (error) => {
      if (this.server !== server) return;
      this.server = null;
      this.ready = null;
      for (const pending of this.pending.values()) pending.reject(diagnostic(error));
      this.pending.clear();
      const cleanup = lifecycle.stop(500);
      this.retiring.add(cleanup);
      void cleanup.then(exited => {
        this.retiring.delete(cleanup);
        if (!exited) process.stderr.write("AGY Codex Bridge: 无法确认历史读取进程已退出。\n");
      });
    };
    server.on("error", fail);
    server.stdin.on("error", fail);
    void lifecycle.closed.then(result => fail(result?.error ?? new Error(`Codex 历史读取进程已退出（${result?.code ?? result?.signal ?? "未知"}）。`)));
    createInterface({ input: server.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (this.server !== server) return;
      try {
        const message = JSON.parse(line);
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(Object.assign(diagnostic(new Error(message.error.message)), { code: message.error.code }));
        else pending.resolve(message.result);
      } catch (error) {
        fail(error);
      }
    });
    this.ready = this.request("initialize", {
      clientInfo: { name: "agy_codex_bridge_reader", version: "0.1.0" },
    }).then(() => server.stdin.write('{"method":"initialized"}\n')).catch((error) => {
      fail(error);
      throw error;
    });
    this.fail = fail;
  }

  async request(method, params) {
    const server = this.server;
    if (!server) throw new Error("Codex 历史读取进程已断开。");
    const id = this.nextId++;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          if (this.server === server) this.fail(new Error(`读取 Codex 历史超时（${method}）。`));
        }, 8000);
        server.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  close() {
    this.closed = true;
    this.fail?.(new Error("Codex 历史读取连接已关闭。"));
    return Promise.all(this.retiring);
  }
}

module.exports = {
  bindingWorktree, bindThread, childLifecycle, CodexReader, defaultSession, getBinding, markAccepted, openDatabase, queueTask, recordResult, saveBinding,
  sameWorkspace, startDesktop, taskMarker, threadIdFrom, transaction, workspacePath,
};
