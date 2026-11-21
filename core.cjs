const { execFile, spawn } = require("node:child_process");
const { realpathSync, statSync } = require("node:fs");
const { createInterface } = require("node:readline");
const { DatabaseSync } = require("node:sqlite");
const { promisify } = require("node:util");

const run = promisify(execFile);
const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const taskMarker = new RegExp(`^\\[AGY Codex task: (${uuid})\\]\\r?\\n`, "i");

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
  return first.toLowerCase() === second.toLowerCase();
}

function openDatabase(path) {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS bindings (
      owner TEXT PRIMARY KEY,
      thread_id TEXT,
      pending_task_id TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      workspace TEXT NOT NULL,
      thread_id TEXT,
      turn_id TEXT,
      state TEXT NOT NULL,
      report TEXT,
      detail TEXT,
      dispatch_deadline INTEGER,
      draft_prompt TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  const columns = { dispatch_deadline: "INTEGER", draft_prompt: "TEXT", created_at: "TEXT", updated_at: "TEXT" };
  const tableColumns = () => new Set(database.prepare("PRAGMA table_info(tasks)").all().map((col) => col.name));
  const existing = tableColumns();
  if (Object.keys(columns).some((name) => !existing.has(name))) {
    transaction(database, () => {
      const current = tableColumns();
      for (const [name, type] of Object.entries(columns)) {
        if (!current.has(name)) database.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
      }
    });
  }
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS task_created AFTER INSERT ON tasks BEGIN
      UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS task_changed AFTER UPDATE OF state, detail, turn_id, thread_id, report ON tasks
    WHEN NEW.state IS NOT OLD.state OR NEW.detail IS NOT OLD.detail OR NEW.turn_id IS NOT OLD.turn_id
      OR NEW.thread_id IS NOT OLD.thread_id OR NEW.report IS NOT OLD.report BEGIN
      UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS preserve_dismissed BEFORE UPDATE OF state ON tasks
    WHEN OLD.state IN ('cancelled','dismissed') AND NEW.state <> OLD.state BEGIN
      SELECT RAISE(IGNORE);
    END;
  `);
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

function bindThread(database, owner, threadId) {
  database.prepare(`
    INSERT INTO bindings (owner, thread_id) VALUES (?, ?)
    ON CONFLICT(owner) DO UPDATE SET thread_id = excluded.thread_id, pending_task_id = NULL
  `).run(owner, threadId);
}

function markAccepted(database, taskId, threadId, turnId) {
  const update = database.prepare(`
    UPDATE tasks SET thread_id = ?, turn_id = ?, state = 'running', detail = NULL, draft_prompt = NULL
    WHERE id = ? AND turn_id IS NULL AND (thread_id IS NULL OR thread_id = ?)
      AND state IN ('awaiting_send','dispatching','queued','dispatch_unknown','running')
  `).run(threadId, turnId, taskId, threadId);
  if (update.changes) {
    database.prepare(`
      UPDATE bindings SET thread_id = ?, pending_task_id = NULL WHERE pending_task_id = ?
    `).run(threadId, taskId);
  }
}

function recordResult(database, taskId, state, report, detail = null) {
  database.prepare(`
    UPDATE tasks SET state = ?, report = ?, detail = ? WHERE id = ? AND state = 'running'
  `).run(state, report, detail, taskId);
}

function startDesktop(uri) {
  return run("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:AGY_CODEX_BRIDGE_URL",
  ], {
    env: { ...process.env, AGY_CODEX_BRIDGE_URL: uri },
    windowsHide: true,
    timeout: 10000,
  });
}

function queueTask(codex, workspace, threadId, prompt) {
  return run(codex, ["queue", "--thread", threadId, "--message", prompt], {
    cwd: workspace,
    windowsHide: true,
    timeout: 15000,
  });
}

class CodexReader {
  constructor(codex, spawnProcess = spawn) {
    this.codex = codex;
    this.spawnProcess = spawnProcess;
    this.nextId = 1;
    this.pending = new Map();
  }

  async read(method, params) {
    if (!this.server) this.start();
    await this.ready;
    return this.request(method, params);
  }

  start() {
    const server = this.spawnProcess(this.codex, ["app-server", "--listen", "stdio://"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.server = server;
    let stderr = "";
    server.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
    const diagnostic = (error) => stderr.trim() ? new Error(`${error.message} (stderr: ${stderr.trim()})`) : error;
    const fail = (error) => {
      if (this.server !== server) return;
      this.server = null;
      this.ready = null;
      for (const pending of this.pending.values()) pending.reject(diagnostic(error));
      this.pending.clear();
      server.kill();
    };
    server.on("error", fail);
    server.stdin.on("error", fail);
    server.on("close", (code, signal) => fail(new Error(`Codex 历史读取进程已退出（${code ?? signal}）。`)));
    createInterface({ input: server.stdout }).on("line", (line) => {
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
    this.server?.kill();
  }
}

module.exports = {
  bindThread, CodexReader, markAccepted, openDatabase, queueTask, recordResult,
  sameWorkspace, startDesktop, taskMarker, threadIdFrom, transaction, workspacePath,
};
