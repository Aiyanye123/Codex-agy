import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import core from "../core.cjs";
import { bindingStatus, dismissTask, listTasks, readWithRetry, refreshTask } from "../src/task-state.mjs";

const root = core.workspacePath(fileURLToPath(new URL("../", import.meta.url)));
const scratchRoot = path.join(root, ".state");
let scratch;

before(() => {
  mkdirSync(scratchRoot, { recursive: true });
  scratch = mkdtempSync(path.join(scratchRoot, "bridge-test-"));
});
after(() => {
  if (!scratch) return;
  assert.equal(path.dirname(scratch), scratchRoot);
  execFileSync("pwsh", ["-NoProfile", "-Command",
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:BRIDGE_TEST_DIR,'OnlyErrorDialogs','SendToRecycleBin')"],
    { env: { ...process.env, BRIDGE_TEST_DIR: scratch } });
});

function insertTask(db, state, owner = "owner", thread = null) {
  const id = randomUUID();
  db.prepare("INSERT INTO tasks(id, owner, workspace, state, thread_id) VALUES (?, ?, ?, ?, ?)").run(id, owner, root, state, thread);
  return id;
}

test("migration preserves unknown legacy times and tracks new inserts and state changes", () => {
  const file = path.join(scratch, "legacy.sqlite");
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY, owner TEXT, workspace TEXT, state TEXT, thread_id TEXT, turn_id TEXT, report TEXT, detail TEXT)");
  const id = insertTask(old, "queued");
  old.close();
  const db = core.openDatabase(file);
  try {
    const [legacy] = listTasks(db, "owner", 10);
    assert.equal(legacy.created_at, null);
    assert.equal(legacy.updated_at, null);
    core.markAccepted(db, id, randomUUID(), randomUUID());
    assert.ok(Date.parse(listTasks(db, "owner", 1)[0].updated_at));
    const next = insertTask(db, "awaiting_send");
    insertTask(db, "running", "other");
    const [recent] = listTasks(db, "owner", 1);
    assert.equal(recent.task_id, next);
    assert.ok(Date.parse(recent.created_at));
    assert.equal(recent.updated_at, recent.created_at);
    assert.deepEqual(listTasks(db, "owner", 10).map(t => t.task_id), [next, id]);
  } finally { db.close(); }
});

test("MCP startup clears expired receipts without changing task history or bindings", async () => {
  const file = path.join(scratch, "receipt-retention.sqlite");
  const db = core.openDatabase(file);
  const day = 24 * 60 * 60 * 1000;
  const old = new Date(Date.now() - 31 * day).toISOString();
  const recent = new Date(Date.now() - 29 * day).toISOString();
  const cases = [
    ["reported", old, old, true],
    ["failed", old, null, true],
    ["reported", old, recent, false],
    ["reported", null, null, false],
    ...["awaiting_send", "dispatching", "queued", "dispatch_unknown", "running"]
      .map(state => [state, old, old, false]),
  ];
  const expired = new Set();
  let oldestReported;
  let beforeTasks;
  let beforeBindings;
  try {
    for (const [state, createdAt, updatedAt, shouldExpire] of cases) {
      const id = insertTask(db, state, "owner", randomUUID());
      db.prepare("UPDATE tasks SET report = ?, detail = ?, turn_id = ? WHERE id = ?")
        .run("Complete receipt", "Original detail", randomUUID(), id);
      db.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?").run(createdAt, updatedAt, id);
      if (shouldExpire) {
        expired.add(id);
        if (state === "reported") oldestReported = id;
      }
    }
    db.prepare("INSERT INTO bindings (owner, thread_id, pending_task_id) VALUES (?, ?, ?)")
      .run("another-owner", randomUUID(), randomUUID());
    beforeTasks = db.prepare("SELECT * FROM tasks ORDER BY rowid").all();
    beforeBindings = db.prepare("SELECT * FROM bindings").all();
    // Simulate a database created with the previous trigger, which touched timestamps for every report change.
    db.exec(`
      DROP TRIGGER task_changed;
      CREATE TRIGGER task_changed AFTER UPDATE OF state, detail, turn_id, thread_id, report ON tasks
      WHEN NEW.state IS NOT OLD.state OR NEW.detail IS NOT OLD.detail OR NEW.turn_id IS NOT OLD.turn_id
        OR NEW.thread_id IS NOT OLD.thread_id OR NEW.report IS NOT OLD.report BEGIN
        UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
      END;
    `);
  } finally { db.close(); }

  const client = new Client({ name: "receipt-retention-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, "mcp.cjs"), ".", file, "unused"], cwd: root });
  await client.connect(transport);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args,
      _meta: { "antigravity.google/root_conversation_id": "owner" } });
    assert.ok(!response.isError, JSON.stringify(response.content));
    return JSON.parse(response.content[0].text);
  };
  try {
    const status = await call("status", { task_id: oldestReported, report_mode: "full" });
    assert.equal(status.state, "reported");
    assert.equal(status.has_report, false);
    assert.match(status.report_note, /已完成.*30 天/);
    assert.ok((await call("list_tasks", {})).tasks.some(task => task.task_id === oldestReported));

    const cleaned = new DatabaseSync(file);
    try {
      const tasks = cleaned.prepare("SELECT * FROM tasks ORDER BY rowid").all();
      assert.deepEqual(tasks, beforeTasks.map(task => expired.has(task.id) ? Object.assign(task, { report: null }) : task));
      assert.deepEqual(cleaned.prepare("SELECT * FROM bindings").all(), beforeBindings);
      const running = tasks.find(task => task.state === "running");
      core.recordResult(cleaned, running.id, "reported", "New receipt");
      assert.ok(cleaned.prepare("SELECT updated_at FROM tasks WHERE id = ?").get(running.id).updated_at > old);
    } finally { cleaned.close(); }
  } finally { await client.close(); }
});

test("late hooks and history cannot revive a dismissed task or replace a newer pending binding", async () => {
  const file = path.join(scratch, "hooks.sqlite");
  const db = core.openDatabase(file);
  const thread = randomUUID();
  const turn = randomUUID();
  try {
    const id = insertTask(db, "awaiting_send");
    const get = () => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    const stale = get();
    db.prepare("INSERT INTO bindings(owner,pending_task_id) VALUES ('owner',?)").run(id);
    assert.throws(() => dismissTask(db, "other", id), /没有/);
    dismissTask(db, "owner", id);
    const next = insertTask(db, "awaiting_send");
    db.prepare("UPDATE bindings SET pending_task_id = ? WHERE owner = 'owner'").run(next);
    const prompt = `[AGY Codex task: ${id}]\n\nwork`;
    for (const event of ["UserPromptSubmit", "Stop", "Interrupt"]) {
      const result = spawnSync(process.execPath, ["hook.cjs", file, root], { cwd: root, encoding: "utf8",
        input: JSON.stringify({ hook_event_name: event, cwd: root, session_id: thread, turn_id: turn, prompt, last_assistant_message: "finished" }) });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    }
    await refreshTask(db, { async read(method) {
      if (method === "thread/list") return { data: [{ id: thread, preview: prompt }] };
      return { data: [{ id: turn, status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: prompt }] }] }] };
    } }, stale, new Set());
    assert.equal(get().state, "cancelled");
    assert.equal(get().turn_id, null);
    assert.equal(db.prepare("SELECT pending_task_id FROM bindings").get().pending_task_id, next);
    for (const state of ["queued", "running", "dispatch_unknown", "dispatching"]) {
      const other = insertTask(db, state);
      dismissTask(db, "owner", other);
      const task = listTasks(db, "owner", 1)[0];
      assert.equal(task.state, "dismissed");
      assert.match(task.detail, /不代表 Codex App 已撤回执行/);
    }
  } finally { db.close(); }
});

test("hooks associate multiple prompts with one turn and finish or interrupt all its tasks", () => {
  const file = path.join(scratch, "shared-hooks.sqlite");
  const db = core.openDatabase(file);
  const thread = randomUUID();
  const get = db.prepare("SELECT state, turn_id, report FROM tasks WHERE id = ?");
  function hook(name, turn, payload = {}) {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "hook.cjs", file, root], {
      cwd: root, encoding: "utf8",
      input: JSON.stringify({ hook_event_name: name, cwd: root, session_id: thread, turn_id: turn, ...payload }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }

  try {
    const otherTurn = randomUUID();
    const other = insertTask(db, "queued", "owner", thread);
    core.markAccepted(db, other, thread, otherTurn);
    for (const [event, state, report] of [["Stop", "reported", "finished"], ["Interrupt", "interrupted", null]]) {
      const turn = randomUUID();
      const first = insertTask(db, "queued", "owner", thread);
      const second = insertTask(db, "queued", "owner", thread);
      for (const id of [first, second]) {
        hook("UserPromptSubmit", turn, { prompt: `[AGY Codex task: ${id}]\n\nwork` });
        assert.deepEqual({ ...get.get(id) }, { state: "running", turn_id: turn, report: null });
      }
      hook(event, turn, { last_assistant_message: "finished" });
      for (const id of [first, second]) assert.deepEqual({ ...get.get(id) }, { state, turn_id: turn, report });
    }
    assert.deepEqual({ ...get.get(other) }, { state: "running", turn_id: otherTurn, report: null });
  } finally { db.close(); }
});

test("bounded history pages find a later thread and turn and report ambiguous markers", async () => {
  const db = core.openDatabase(":memory:");
  try {
    const id = insertTask(db, "awaiting_send");
    const get = () => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    const marker = `[AGY Codex task: ${id}]\n\nhello`;
    const calls = [];
    await refreshTask(db, { async read(method, { cursor }) {
      calls.push([method, cursor]);
      if (!cursor) return { data: [], nextCursor: "more" };
      if (method === "thread/list") return { data: [{ id: "chat", preview: marker }] };
      return { data: [{ id: "turn", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: marker }] }] }] };
    } }, get(), new Set());
    assert.equal(calls.length, 4);
    assert.equal(get().turn_id, "turn");
    const pending = insertTask(db, "awaiting_send");
    const row = () => db.prepare("SELECT * FROM tasks WHERE id = ?").get(pending);
    await refreshTask(db, { async read(method, { cursor }) {
      assert.equal(method, "thread/list");
      return { data: [{ id: cursor ?? "first", preview: `[AGY Codex task: ${pending}]` }], nextCursor: cursor ? null : "second" };
    } }, row(), new Set());
    assert.equal(row().thread_id, null);
    assert.match(row().detail, /无法唯一匹配/);
    let count = 0;
    await refreshTask(db, { async read() { return { data: [], nextCursor: String(++count) }; } }, row(), new Set());
    assert.equal(count, 5);
  } finally { db.close(); }
});

test("binding directory follows current binding and degrades to null on read failure", async () => {
  const db = core.openDatabase(":memory:");
  try {
    core.bindThread(db, "owner", "second");
    assert.deepEqual(await bindingStatus(db, "owner", async id => ({ directory: "workspace/" + id })),
      { bound_thread_id: "second", bound_workspace: "workspace/second" });
    assert.deepEqual(await bindingStatus(db, "owner", async () => { throw new Error("offline"); }),
      { bound_thread_id: "second", bound_workspace: null });
  } finally { db.close(); }
});

test("history reads retry transient failures, stop at three attempts, and retain task ID and last error", async () => {
  const signal = new AbortController().signal;
  let reads = 0;
  const reader = { async read() { if (++reads < 3) throw new Error("restart"); return "ok"; } };
  assert.equal(await readWithRetry(reader, "thread/read", {}, "task", signal), "ok");
  assert.equal(reads, 3);
  reads = 0;
  await assert.rejects(readWithRetry({ async read() { throw new Error("failure-" + ++reads); } }, "thread/list", {}, "test-task", signal),
    /test-task.*thread\/list.*3.*failure-3/);
  assert.equal(reads, 3);
});

test("failed initialize is discarded and next call starts a fresh reader with bounded stderr diagnostics", async () => {
  let starts = 0;
  const reader = new core.CodexReader("unused", (_, __, options) => {
    const fail = starts++ === 0;
    const body = fail
      ? 'process.stderr.write("x".repeat(4000)+"TAIL", () => setTimeout(() => console.log(JSON.stringify({id:m.id,error:{message:"init refused"}})),40));'
      : 'console.log(JSON.stringify({id:m.id,result:{ok:true}}));';
    return spawn(process.execPath, ["-e", 'require("node:readline").createInterface({input:process.stdin}).on("line",l=>{const m=JSON.parse(l);if(m.id){'+body+'}});'], options);
  });
  try {
    await assert.rejects(reader.read("thread/read", {}), err => /init refused/.test(err.message) && /TAIL/.test(err.message) && err.message.length < 1200);
    assert.equal(reader.server, null);
    assert.deepEqual(await reader.read("thread/read", {}), { ok: true });
    assert.equal(starts, 2);
  } finally { reader.close(); }
});

test("MCP submit, resume, list, dismiss and watch use the original draft without another dispatch", async () => {
  const program = `
    const core = require("./core.cjs");
    const seen = new Map();
    core.startDesktop = async uri => {
      const msg = new URL(uri).searchParams.get("prompt");
      const id = core.taskMarker.exec(msg)[1];
      if (msg.includes("original") && !msg.includes("AGY_SUMMARY_BEGIN")) throw new Error("missing receipt instruction");
      if (uri.length > 8000) throw new Error("oversized draft");
      if (seen.has(id) && seen.get(id) !== uri) throw new Error("different draft");
      seen.set(id, uri);
    };
    let polls = 0;
    core.CodexReader = class { close() {} async read() {
      if (polls++ === 0) throw new Error("temporary restart");
      return {data:[]};
    } };
    process.argv = ["node","mcp",process.cwd(),":memory:","unused"];
    import("./src/mcp-entry.mjs");
  `;
  const client = new Client({ name: "bridge-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["-e", program], cwd: root });
  await client.connect(transport);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args, _meta: { "antigravity.google/root_conversation_id": "owner" } });
    assert.ok(!response.isError, JSON.stringify(response.content));
    return response.structuredContent ?? JSON.parse(response.content[0].text);
  };
  try {
    const draft = await call("submit", { prompt: "original" });
    const args = { task_id: draft.task_id };
    const blocked = await call("submit", { prompt: "other" });
    assert.equal(blocked.new_task_dispatched, false);
    assert.equal(blocked.task_id, draft.task_id);
    assert.match(blocked.detail, /未派发/);
    const resumed = await call("resume_draft", args);
    assert.equal(resumed.task_id, draft.task_id);
    assert.equal(resumed.state, "awaiting_send");
    assert.equal((await call("list_tasks", {})).tasks.length, 1);
    const waiting = call("watch", args);
    assert.equal((await call("dismiss", args)).state, "cancelled");
    assert.equal((await waiting).state, "cancelled");
    const next = await call("submit", { prompt: "next" });
    assert.notEqual(next.task_id, draft.task_id);
    assert.equal((await call("status", args)).bound_workspace, null);
    const nearLimit = await call("submit", { prompt: "x".repeat(7800), new_chat: true });
    assert.equal(nearLimit.state, "awaiting_send");
  } finally { await client.close(); }
});

test("MCP workspace search returns bounded read-only matches from the current workspace", async () => {
  const workspace = path.join(scratch, "search-workspace");
  const outside = path.join(scratch, "outside-search-workspace");
  mkdirSync(workspace);
  mkdirSync(outside);
  const files = {
    "README.md": "Installation\nSearchNeedle --pre=bad & literal\n",
    "settings.ps1": "# Setup\nSearchNeedle\n",
    ".gitignore": "ignored.md\n",
    ".ignore": "!.hidden.md\n",
    ".hidden.md": "HiddenNeedle\n",
    "ignored.md": "SearchNeedle\n",
    ".env.local": "SearchNeedle\n",
    "access.pem": "SearchNeedle\n",
    "package-lock.json": "SearchNeedle\n",
    "Dockerfile": "FROM alpine\nRUN echo SearchNeedle\n",
    "rg.exe": "Workspace files must not be used as executables.\n",
    "many.txt": `Bounded ${"x".repeat(1000)}\n`.repeat(25),
  };
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(workspace, file), content);
  mkdirSync(path.join(workspace, ".github"));
  writeFileSync(path.join(workspace, ".github", "pipeline.xml"), "start\nSearchNeedle\nend\n");
  const outsideFile = path.join(outside, "outside.md");
  const rgConfig = path.join(outside, "rg-config");
  writeFileSync(outsideFile, "SearchNeedle\n");
  writeFileSync(rgConfig, "--no-ignore\n--follow\n");
  symlinkSync(outside, path.join(workspace, "outside-link"), "junction");
  const before = readdirSync(workspace).sort();

  const client = new Client({ name: "search-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, "mcp.cjs"), ".", ":memory:", "unused"], cwd: workspace,
    env: { ...process.env, RIPGREP_CONFIG_PATH: rgConfig },
  });
  await client.connect(transport);
  const call = async (args) => {
    const response = await client.callTool({ name: "search_workspace", arguments: args });
    assert.ok(!response.isError, JSON.stringify(response.content));
    assert.equal(response.structuredContent, undefined);
    return JSON.parse(response.content[0].text);
  };
  try {
    const listed = await call({ mode: "files", query: "readme" });
    assert.deepEqual(listed.matches, [{ path: "README.md" }]);
    const all = await call({ mode: "files" });
    assert.ok(!all.matches.some(({ path }) => /ignored\.md|\.env\.local|access\.pem|package-lock|outside-link/.test(path)));
    assert.ok(all.matches.some(({ path }) => path === ".github/pipeline.xml"));
    assert.deepEqual((await call({ mode: "files", path: ".github", glob: "*.xml" })).matches, [{ path: ".github/pipeline.xml" }]);
    assert.deepEqual((await call({ mode: "files", path: "ignored.md", glob: "*.md" })).matches, []);
    const docs = await call({ mode: "docs", query: "searchneedle" });
    assert.deepEqual(docs.matches, [{ path: "README.md", line: 2, text: "SearchNeedle --pre=bad & literal" }]);
    assert.deepEqual((await call({ mode: "docs", query: "--pre=bad & literal" })).matches, docs.matches);
    const code = await call({ mode: "code", query: "SearchNeedle" });
    assert.deepEqual(code.matches.map(match => match.path).sort(), [".github/pipeline.xml", "Dockerfile", "settings.ps1"]);
    const text = await call({ mode: "text", query: "SearchN[e]+dle", regex: true, whole_word: true,
      case_sensitive: true, path: ".github", context_lines: 1 });
    assert.deepEqual(text.matches, [{ path: ".github/pipeline.xml", line: 2, text: "SearchNeedle",
      context: [{ line: 1, text: "start" }, { line: 3, text: "end" }] }]);
    assert.deepEqual((await call({ mode: "docs", query: "searchneedle", case_sensitive: true })).matches, []);
    const bounded = await call({ mode: "docs", query: "Bounded", limit: 4, per_file: 8 });
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.matches.length, 4);
    assert.equal((await call({ mode: "docs", query: "Bounded" })).matches.length, 3);
    assert.ok(bounded.matches.every(({ text }) => text.length <= 302));
    for (const args of [{ mode: "files", command: "write" }, { mode: "files", path: "../" },
      { mode: "files", glob: "README\u0000.md" }, { mode: "docs", query: "a\nb" },
      { mode: "files", path: outside }, { mode: "files", path: "outside-link" },
      { mode: "docs", query: "(?=test)", regex: true }]) {
      assert.equal((await client.callTool({ name: "search_workspace", arguments: args })).isError, true);
    }
    assert.deepEqual(readdirSync(workspace).sort(), before);
    for (const [file, content] of Object.entries(files)) assert.equal(readFileSync(path.join(workspace, file), "utf8"), content);
    assert.equal(readFileSync(outsideFile, "utf8"), "SearchNeedle\n");
  } finally { await client.close(); }
});

test("MCP status and watch keep receipts compact and recent replies stay inside the current binding", async () => {
  const statePath = path.join(scratch, "receipts.sqlite");
  const db = core.openDatabase(statePath);
  const thread = randomUUID();
  const otherThread = randomUUID();
  const summary = "已完成设置更新。\n验证通过。\n待用户确认：无。";
  const report = `AGY_SUMMARY_BEGIN\n${summary}\nAGY_SUMMARY_END\n${"details ".repeat(300)}`;
  const oldReport = `结果 ${"old ".repeat(600)} 末尾验证`;
  const task = insertTask(db, "reported", "task-owner", thread);
  const legacy = insertTask(db, "reported", "task-owner", thread);
  db.prepare("UPDATE tasks SET report=? WHERE id=?").run(report, task);
  db.prepare("UPDATE tasks SET report=? WHERE id=?").run(oldReport, legacy);
  core.bindThread(db, "history-owner", thread);
  core.bindThread(db, "other-owner", otherThread);
  db.close();
  const program = `
    const core = require("./core.cjs");
    core.CodexReader = class { close() {} async read(method, params) {
      if (method !== "thread/turns/list" || params.itemsView !== "summary" || params.limit !== 8) throw new Error("unexpected read");
      if (params.threadId === ${JSON.stringify(otherThread)}) return { data: [] };
      if (params.threadId !== ${JSON.stringify(thread)}) throw new Error("unexpected thread");
      if (!params.cursor) return { nextCursor: "older", data: [{id:"interrupted",status:"interrupted",items:[{type:"agentMessage",phase:"final_answer",text:"partial"}]}] };
      return { data: [
        { id:"newest", status:"completed", items:[{type:"userMessage",content:[{type:"text",text:"question ".repeat(100)}]},
          {type:"commandExecution",text:"private log"},{type:"agentMessage",phase:"commentary",text:"private commentary"},
          {type:"agentMessage",phase:"final_answer",text:"answer ".repeat(200)}]},
        { id:"older", status:"completed", items:[{type:"agentMessage",phase:"final_answer",text:${JSON.stringify(report)}}]},
        { id:"at-limit", status:"completed", items:[{type:"agentMessage",phase:"final_answer",text:"x".repeat(1200)}]},
      ] };
    } };
    process.argv = ["node", "mcp", process.cwd(), ${JSON.stringify(statePath)}, "unused"];
    import("./src/mcp-entry.mjs");
  `;
  const client = new Client({ name: "receipts-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["-e", program], cwd: root });
  await client.connect(transport);
  const invoke = (name, args, owner) => client.callTool({ name, arguments: args,
    _meta: { "antigravity.google/root_conversation_id": owner } });
  const call = async (name, args, owner = "task-owner") => {
    const response = await invoke(name, args, owner);
    assert.ok(!response.isError, JSON.stringify(response.content));
    return JSON.parse(response.content[0].text);
  };
  try {
    const status = await call("status", { task_id: task });
    assert.equal(status.has_report, true);
    assert.equal(status.report, undefined);
    const watched = await call("watch", { task_id: task });
    assert.equal(watched.report, summary);
    assert.equal(watched.report_kind, "summary");
    assert.equal((await invoke("watch", { task_id: task }, "task-owner")).structuredContent, undefined);
    assert.equal((await call("status", { task_id: task, report_mode: "summary" })).report, summary);
    assert.equal((await call("status", { task_id: task, report_mode: "full" })).report, report);
    const old = await call("watch", { task_id: legacy });
    assert.equal(old.report_kind, "excerpt");
    assert.equal(old.report_truncated, true);
    assert.ok(old.report.length <= 1200 && old.report.endsWith("末尾验证"));
    assert.equal((await call("status", {}, "history-owner")).state, "no_task");
    const history = await call("recent_replies", {}, "history-owner");
    assert.deepEqual(history.replies.map(item => item.turn_id), ["newest", "older", "at-limit"]);
    assert.ok(history.replies[0].user.length <= 240);
    assert.equal(history.replies[0].reply.length, 1200);
    assert.equal(history.replies[0].reply_truncated, true);
    assert.equal(history.replies[1].reply, summary);
    assert.equal(history.replies[1].reply_is_summary, true);
    assert.equal(history.replies[2].reply.length, 1200);
    assert.equal(history.replies[2].reply_truncated, false);
    assert.equal((await call("recent_replies", { limit: 1 }, "history-owner")).replies.length, 1);
    assert.deepEqual((await call("recent_replies", {}, "other-owner")).replies, []);
    assert.equal((await invoke("recent_replies", {}, "unbound")).isError, true);
    assert.equal((await invoke("recent_replies", { thread_id: otherThread }, "history-owner")).isError, true);
  } finally { await client.close(); }
});

test("MCP watches share one terminal receipt per owner and turn while manual status can reread it", async () => {
  const statePath = path.join(scratch, "shared-watches.sqlite");
  const db = core.openDatabase(statePath);
  const thread = randomUUID();
  const turnId = randomUUID();
  const original = insertTask(db, "queued", "owner", thread);
  const steered = insertTask(db, "queued", "owner", thread);
  const laterMarker = insertTask(db, "queued", "owner", thread);
  const otherOwner = insertTask(db, "queued", "other-owner", thread);
  for (const id of [original, steered, otherOwner]) core.markAccepted(db, id, thread, turnId);
  const independent = [insertTask(db, "queued", "owner", thread), insertTask(db, "queued", "owner", thread)];
  db.close();

  const summary = "Shared work is complete.";
  const report = `AGY_SUMMARY_BEGIN\n${summary}\nAGY_SUMMARY_END\nDetails for all prompts.`;
  function turn(id, tasks, reportText) {
    const prompts = tasks.map(task => ({ type: "userMessage", content: [{ type: "text", text: `[AGY Codex task: ${task}]\n\nwork` }] }));
    return { id, status: "completed", items: [...prompts, { type: "agentMessage", phase: "final_answer", text: reportText }] };
  }
  const turns = [turn(turnId, [original, steered, laterMarker], report),
    ...independent.map((id, index) => turn(randomUUID(), [id], `Independent receipt ${index}`))];
  const program = `
    const core = require("./core.cjs");
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    core.CodexReader = class { close() {} async read(method, params) {
      if (params.threadId !== ${JSON.stringify(thread)}) throw new Error("unexpected thread");
      if (method === "thread/read") { release(); return { thread: { id: params.threadId, cwd: process.cwd() } }; }
      if (method !== "thread/turns/list") throw new Error("unexpected read");
      await ready;
      return { data: ${JSON.stringify(turns)} };
    } };
    process.argv = ["node", "mcp", process.cwd(), ${JSON.stringify(statePath)}, "unused"];
    require("./mcp.cjs");
  `;
  const client = new Client({ name: "shared-watches-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["-e", program], cwd: root });
  await client.connect(transport);
  const call = async (name, args, owner = "owner") => {
    const response = await client.callTool({ name, arguments: args, _meta: { "antigravity.google/root_conversation_id": owner } });
    assert.ok(!response.isError, JSON.stringify(response.content));
    return JSON.parse(response.content[0].text);
  };

  try {
    const firstWatch = call("watch", { task_id: steered });
    const pending = await call("watch", { task_id: steered });
    assert.equal(pending.watch_state, "already_watching");
    assert.deepEqual(pending.shared_turn_task_ids, [original, steered]);
    const otherWatches = [original, laterMarker].map(task_id => call("watch", { task_id }));
    await call("bind", { session: thread });
    const [first, ...duplicates] = await Promise.all([firstWatch, ...otherWatches]);
    const sharedIds = [original, steered, laterMarker];
    assert.equal(first.report_kind, "summary");
    assert.equal(first.report, summary);
    for (const result of [first, ...duplicates]) {
      assert.equal(result.state, "reported");
      assert.deepEqual(result.shared_turn_task_ids, sharedIds);
    }
    for (const result of duplicates) {
      assert.equal(result.report, undefined);
      assert.equal(result.has_report, true);
      assert.equal(result.shared_turn_reported_by, steered);
    }
    for (const [mode, expected] of [["summary", summary], ["full", report]]) {
      const status = await call("status", { task_id: original, report_mode: mode });
      assert.equal(status.report, expected);
      assert.deepEqual(status.shared_turn_task_ids, sharedIds);
    }
    const sameTurnOtherOwner = await call("watch", { task_id: otherOwner }, "other-owner");
    assert.equal(sameTurnOtherOwner.report, summary);
    assert.equal(sameTurnOtherOwner.shared_turn_task_ids, undefined);
    for (const [index, task_id] of independent.entries()) {
      const result = await call("watch", { task_id });
      assert.equal(result.report, `Independent receipt ${index}`);
      assert.equal(result.shared_turn_task_ids, undefined);
    }
  } finally { await client.close(); }
});
