import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import core from "../core.cjs";
import { refreshTask, validateFollowUp } from "../src/task-state.mjs";

const { openDatabase, bindThread, recordResult } = core;

function fixture(t, { state = "queued", threadId = "thread-a", deadline = null } = {}) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const id = randomUUID();
  db.prepare("INSERT INTO tasks(id, owner, workspace, thread_id, state, dispatch_deadline) VALUES (?, 'owner', '.', ?, ?, ?)")
    .run(id, threadId, state, deadline);
  const task = () => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  const userMessage = { type: "userMessage", content: [{ type: "text", text: `[AGY Codex task: ${id}]\n\nwork` }] };
  return { db, id, task, userMessage };
}

function assistant(text, phase = "final_answer") {
  return { type: "agentMessage", phase, text };
}

function history(turns) {
  return { async read(method) {
    assert.equal(method, "thread/turns/list");
    return { data: turns };
  } };
}

for (const [label, status, completedAt, messages, state, report] of [
  ["active history reconstructed as interrupted", "interrupted", null, [assistant("premature")], "running", null],
  ["confirmed interruption even with final text", "interrupted", 123, [assistant("premature")], "interrupted", null],
  ["in-progress final text", "inProgress", null, [assistant("premature")], "running", null],
  ["completed final answer", "completed", 123, [assistant("done")], "reported", "done"],
  ["completed legacy answer", "completed", null, [assistant("legacy", null)], "reported", "legacy"],
  ["completed without a final answer", "completed", 123, [assistant("progress", "commentary")], "no_report", null],
]) {
  test(label, async (t) => {
    const { db, task, userMessage } = fixture(t);
    const turn = { id: "turn-a", status, completedAt, durationMs: 50, items: [userMessage, ...messages] };
    await refreshTask(db, history([turn]), task(), new Set());
    assert.equal(task().turn_id, turn.id);
    assert.equal(task().state, state);
    assert.equal(task().report, report);
  });
}

test("orphaned first dispatch is recovered by its original marker", async (t) => {
  const { db, id, task, userMessage } = fixture(t, { state: "dispatching", threadId: null });
  db.prepare("INSERT INTO bindings(owner, pending_task_id) VALUES ('owner', ?)").run(id);
  const calls = [];
  const reader = { async read(method, params) {
    calls.push(method);
    if (method === "thread/list") return { data: [{ id: "found", preview: userMessage.content[0].text }] };
    assert.equal(method, "thread/turns/list");
    assert.equal(params.threadId, "found");
    return { data: [{ id: "found-turn", status: "completed", items: [userMessage, assistant("done")] }] };
  } };
  await refreshTask(db, reader, task(), new Set());
  assert.deepEqual(calls, ["thread/list", "thread/turns/list"]);
  assert.equal(task().state, "reported");
  assert.equal(task().report, "done");
  assert.equal(task().turn_id, "found-turn");
  assert.equal(db.prepare("SELECT thread_id FROM bindings").get().thread_id, "found");
});

test("unconfirmed dispatch uses only history and can later receive the original turn", async (t) => {
  const { db, task, userMessage } = fixture(t, { state: "dispatching", deadline: Date.now() - 1 });
  const calls = [];
  await refreshTask(db, { async read(method) {
    calls.push(method);
    return { data: [{ id: "unrelated", status: "completed", items: [assistant("other")] }] };
  } }, task(), new Set());
  assert.deepEqual(calls, ["thread/turns/list"]);
  assert.equal(task().state, "dispatch_unknown");
  assert.match(task().detail, /投递未确认/);
  await refreshTask(db, history([{ id: "late", status: "inProgress", items: [userMessage] }]), task(), new Set());
  assert.equal(task().state, "running");
  assert.equal(task().turn_id, "late");
  assert.equal(db.prepare("SELECT count(*) AS total FROM tasks").get().total, 1);
});

test("live local dispatch and unexpired peer dispatch are left alone", async (t) => {
  const { db, id, task } = fixture(t, { state: "dispatching" });
  let reads = 0;
  const reader = { async read() { reads++; return { data: [] }; } };
  await refreshTask(db, reader, task(), new Set([id]));
  assert.equal(task().state, "dispatching");
  db.prepare("UPDATE tasks SET dispatch_deadline = ? WHERE id = ?").run(Date.now() + 30000, id);
  await refreshTask(db, reader, task(), new Set());
  assert.equal(reads, 0);
  assert.equal(task().state, "dispatching");
});

test("hook receipt wins when history arrives later", async (t) => {
  const { db, id, task, userMessage } = fixture(t, { state: "running" });
  db.prepare("UPDATE tasks SET turn_id = 'turn-a' WHERE id = ?").run(id);
  const snapshot = task();
  recordResult(db, id, "interrupted", null, "hook");
  await refreshTask(db, history([{ id: "turn-a", status: "completed", items: [userMessage, assistant("late")] }]), snapshot, new Set());
  assert.equal(task().state, "interrupted");
  assert.equal(task().detail, "hook");
});

test("follow-up requires the original owner and bound chat", (t) => {
  const { db, id } = fixture(t);
  bindThread(db, "owner", "thread-a");
  assert.equal(validateFollowUp(db, "owner", id, false), "thread-a");
  assert.throws(() => validateFollowUp(db, "owner", id, true), /新开会话/);
  assert.throws(() => validateFollowUp(db, "another-owner", id, false), /原工单/);
  bindThread(db, "owner", "thread-b");
  assert.throws(() => validateFollowUp(db, "owner", id, false), /换绑或解绑/);
  db.prepare("DELETE FROM bindings WHERE owner = 'owner'").run();
  assert.throws(() => validateFollowUp(db, "owner", id, false), /换绑或解绑/);
});
