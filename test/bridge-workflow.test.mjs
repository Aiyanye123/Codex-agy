import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import core from "../core.cjs";
import { bindingStatus, dismissTask, listTasks, readWithRetry, refreshTask } from "../src/task-state.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
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
    return response.structuredContent;
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
  } finally { await client.close(); }
});
