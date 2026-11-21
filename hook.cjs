const { readFileSync } = require("node:fs");
const {
  markAccepted, openDatabase, recordResult, sameWorkspace, taskMarker,
  threadIdFrom, transaction, workspacePath,
} = require("./core.cjs");

function collect(database, workspace, event) {
  const { hook_event_name: name, session_id: sessionId, turn_id: turnId } = event;
  const marker = name === "UserPromptSubmit" && taskMarker.exec(event.prompt ?? "");
  if (name === "UserPromptSubmit" && !marker) return;
  if (!["UserPromptSubmit", "Stop", "Interrupt"].includes(name)) return;
  if (!sessionId || !turnId || !event.cwd || !sameWorkspace(workspacePath(event.cwd), workspace)) return;
  const threadId = threadIdFrom(sessionId);

  if (marker) {
    return transaction(database, () => {
      const task = database.prepare("SELECT * FROM tasks WHERE id = ?").get(marker[1].toLowerCase());
      if (!task || !sameWorkspace(task.workspace, workspace)) return;
      if (task.state === "cancelled" || task.state === "dismissed") return;
      if ((task.thread_id && task.thread_id !== threadId) || (task.turn_id && task.turn_id !== turnId)) {
        return { decision: "block", reason: "这条桥接任务已经关联到另一条会话或回合，请从 Antigravity 查询原任务。" };
      }
      markAccepted(database, task.id, threadId, turnId);
    });
  }

  const task = database.prepare("SELECT id FROM tasks WHERE thread_id = ? AND turn_id = ?").get(threadId, turnId);
  if (!task) return;
  if (name === "Interrupt") {
    recordResult(database, task.id, "interrupted", null, "Codex 回合已中止。");
  } else if (event.last_assistant_message?.trim()) {
    recordResult(database, task.id, "reported", event.last_assistant_message);
  }
}

try {
  const [, , statePath, directory] = process.argv;
  const event = JSON.parse(readFileSync(0, "utf8").replace(/^\uFEFF/, ""));
  const database = openDatabase(statePath);
  try {
    const response = collect(database, workspacePath(directory), event);
    if (response) process.stdout.write(JSON.stringify(response));
  } finally {
    database.close();
  }
} catch (error) {
  process.stderr.write(`AGY Codex Bridge: ${error.message}\n`);
  process.exitCode = 1;
}
