import core from "../core.cjs";
import { setTimeout as delay } from "node:timers/promises";

const { markAccepted, recordResult, taskMarker, transaction } = core;

// Both dispatch commands time out within 15 s. Give other processes time to record their result.
export const dispatchLeaseMs = 30_000;
export const ongoing = new Set(["dispatching", "dispatch_unknown", "awaiting_send", "queued", "running"]);

export function dismissTask(database, owner, id) {
  return transaction(database, () => {
    const task = database.prepare("SELECT state FROM tasks WHERE owner = ? AND id = ?").get(owner, id);
    if (!task) throw new Error("当前 Antigravity 对话没有这条桥接任务。");
    if (!ongoing.has(task.state)) return;
    const draft = task.state === "awaiting_send";
    const detail = draft ? "已放弃本地草稿。请关闭 App 中的预填消息。"
      : "仅停止本地跟踪，不代表 Codex App 已撤回执行。";
    database.prepare("UPDATE tasks SET state = ?, detail = ?, draft_prompt = NULL WHERE id = ?")
      .run(draft ? "cancelled" : "dismissed", detail, id);
    database.prepare("UPDATE bindings SET pending_task_id = NULL WHERE owner = ? AND pending_task_id = ?").run(owner, id);
  });
}

export function listTasks(database, owner, limit) {
  return database.prepare(`
    SELECT id AS task_id, state, workspace, thread_id, created_at, updated_at,
      substr(coalesce(detail, report, ''), 1, 240) AS detail
    FROM tasks WHERE owner = ? ORDER BY rowid DESC LIMIT ?
  `).all(owner, limit);
}

export async function bindingStatus(database, owner, readThread) {
  const current = () => database.prepare("SELECT thread_id FROM bindings WHERE owner = ?").get(owner)?.thread_id ?? null;
  const id = current();
  let directory = null;
  if (id) {
    try { directory = (await readThread(id)).directory; }
    catch { /* The task receipt is still useful when the bound directory is unavailable. */ }
  }
  const latest = current();
  return { bound_thread_id: latest, bound_workspace: latest === id ? directory : null };
}

export async function readWithRetry(reader, method, params, taskId, signal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await reader.read(method, params); }
    catch (error) {
      signal.throwIfAborted();
      if (attempt === 2 || [-32600, -32601, -32602].includes(error.code)) {
        throw new Error(`任务 ${taskId} 的 ${method} 读取失败（${attempt + 1} 次）：${error.message.slice(-1200)}`);
      }
      await delay(250 * (2 ** attempt), undefined, { signal });
    }
  }
}

async function* historyPages(reader, method, params) {
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 5; page++) {
    const result = await reader.read(method, { ...params, ...(cursor && { cursor }) });
    yield result.data;
    cursor = result.nextCursor;
    if (!cursor || seen.has(cursor)) return;
    seen.add(cursor);
  }
}

export function validateFollowUp(database, owner, taskId, newChat) {
  if (newChat) throw new Error("补单不能要求新开会话。");
  const task = database.prepare("SELECT thread_id, state FROM tasks WHERE owner = ? AND id = ?").get(owner, taskId);
  if (!task?.thread_id) throw new Error("当前对话没有这条已关联 Codex 会话的原工单，无法补单。");
  if (task.state === "cancelled" || task.state === "dismissed") throw new Error("这条工单已停止跟踪，无法补单。");
  const binding = database.prepare("SELECT thread_id FROM bindings WHERE owner = ?").get(owner);
  if (binding?.thread_id !== task.thread_id) throw new Error("当前已换绑或解绑，未向其他会话投递补单。");
  return task.thread_id;
}

async function observeResult(database, reader, task) {
  if (!task.thread_id) {
    const pages = historyPages(reader, "thread/list", {
      cwd: task.workspace, limit: 12, modelProviders: [], sourceKinds: ["cli", "vscode", "appServer", "unknown"],
    });
    const marker = `[AGY Codex task: ${task.id}]`;
    const matches = new Set();
    for await (const threads of pages) {
      for (const thread of threads) if (thread.preview?.startsWith(marker)) matches.add(thread.id);
      if (matches.size > 1) {
        const detail = "多条 Codex 会话包含同一工单标记，无法唯一匹配。请核对会话后绑定。";
        database.prepare("UPDATE tasks SET detail = ? WHERE id = ? AND thread_id IS NULL AND state IN ('awaiting_send','dispatching','dispatch_unknown')")
          .run(detail, task.id);
        return detail;
      }
    }
    if (!matches.size) return;
    task = { ...task, thread_id: matches.values().next().value };
  }
  const pages = historyPages(reader, "thread/turns/list", {
    threadId: task.thread_id, limit: 20, sortDirection: "desc", itemsView: "full",
  });
  let turn;
  for await (const turns of pages) {
    turn = turns.find(({ id, items }) => task.turn_id ? id === task.turn_id :
      items.some((item) => item.type === "userMessage" && item.content.some((input) =>
        input.type === "text" && taskMarker.exec(input.text)?.[1]?.toLowerCase() === task.id)));
    if (turn) break;
  }
  if (!turn) return;

  transaction(database, () => {
    markAccepted(database, task.id, task.thread_id, turn.id);
    if (turn.status === "failed") {
      recordResult(database, task.id, "failed", null, turn.error?.message ?? "Codex 回合失败。");
    } else if (turn.status === "interrupted" && (turn.completedAt != null || turn.durationMs != null)) {
      recordResult(database, task.id, "interrupted", null, "Codex 回合已中止。");
    } else if (turn.status === "completed") {
      const messages = turn.items.filter((item) => item.type === "agentMessage" && item.text?.trim());
      const answer = messages.findLast((item) => item.phase === "final_answer")
        ?? messages.findLast((item) => item.phase == null);
      if (answer) recordResult(database, task.id, "reported", answer.text);
      else recordResult(database, task.id, "no_report", null, "Codex 回合已完成，记录中没有最终文字回复。");
    }
  });
}

export async function refreshTask(database, reader, task, activeDispatches) {
  if (task.state !== "dispatching") {
    await observeResult(database, reader, task);
    return;
  }
  if (activeDispatches.has(task.id) || task.dispatch_deadline > Date.now()) return;

  let detail = "投递未确认：可见历史中未匹配原工单。可稍后查询同一单。";
  try {
    const ambiguity = await observeResult(database, reader, task);
    if (ambiguity) detail = ambiguity;
  } catch (error) {
    detail = `投递未确认：无法核查原工单历史（${error.message}）。可稍后查询同一单。`;
    database.prepare("UPDATE tasks SET state = 'dispatch_unknown', detail = ? WHERE id = ? AND state = 'dispatching'")
      .run(detail, task.id);
    throw error;
  }
  // A matching turn, hook or late dispatch receipt takes precedence over a missing history entry.
  database.prepare("UPDATE tasks SET state = 'dispatch_unknown', detail = ? WHERE id = ? AND state = 'dispatching'")
    .run(detail, task.id);
}
