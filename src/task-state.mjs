import core from "../core.cjs";
import { setTimeout as delay } from "node:timers/promises";
import { finalMessage } from "./receipt.mjs";

const { defaultSession, getBinding, markAccepted, recordResult, taskMarker, transaction } = core;

// Both dispatch commands time out within 15 s. Give other processes time to record their result.
export const dispatchLeaseMs = 30_000;
export const waitingForUser = new Set(["waiting_approval", "waiting_user_input"]);
export const ongoing = new Set(["dispatching", "dispatch_unknown", "awaiting_send", "queued", "running", "finishing", ...waitingForUser]);

export function releaseAbandonedWriter(database, task) {
  if (!task.writer_pid) return false;
  try {
    process.kill(task.writer_pid, 0);
    return false;
  } catch (error) {
    if (error.code !== "ESRCH") return false;
  }
  const pending = ongoing.has(task.state);
  database.prepare(`
    UPDATE tasks SET writer_pid = NULL, approvals_json = NULL, dispatch_deadline = NULL, state = ?, detail = ?
    WHERE id = ? AND writer_pid = ?
  `).run(pending ? "dispatch_unknown" : task.state,
    pending ? "原直连执行进程已退出。正在通过原工单记录核对结果，请勿重复派单。" : task.detail,
    task.id, task.writer_pid);
  return true;
}

export function assertNoDirectWriter(database, owner, sessionName, threadId = null) {
  const writers = database.prepare(`
    SELECT id, writer_pid, state, detail FROM tasks
    WHERE writer_pid IS NOT NULL AND ((owner = ? AND session_name = ?) OR thread_id = ?)
  `).all(owner, sessionName, threadId);
  for (const writer of writers) {
    if (!releaseAbandonedWriter(database, writer)) {
      throw new Error("该子会话或线程已有直连工单在运行。请查看原工单，按需使用 steer 或 interrupt。");
    }
  }
}

export function clearExpiredReports(database) {
  const nonterminal = [...ongoing];
  database.prepare(`
    UPDATE tasks SET report = NULL, tool_results_json = NULL
    WHERE (report IS NOT NULL OR tool_results_json IS NOT NULL) AND state NOT IN (${nonterminal.map(() => "?").join(", ")})
      AND julianday(coalesce(updated_at, created_at)) < julianday('now', '-30 days')
  `).run(...nonterminal);
}

export function dismissTask(database, owner, id) {
  return transaction(database, () => {
    const task = database.prepare("SELECT id, state, detail, session_name, writer_pid FROM tasks WHERE owner = ? AND id = ?").get(owner, id);
    if (!task) throw new Error("当前 Antigravity 对话没有这条桥接任务。");
    if (task.writer_pid && !releaseAbandonedWriter(database, task)) {
      throw new Error("直连工单仍在运行。请使用 interrupt 中断，或等待执行结束。");
    }
    if (!ongoing.has(task.state)) return;
    const draft = task.state === "awaiting_send";
    const detail = draft ? "已放弃本地草稿。请关闭 App 中的预填消息。"
      : "仅停止本地跟踪，不代表 Codex App 已撤回执行。";
    database.prepare("UPDATE tasks SET state = ?, detail = ?, draft_prompt = NULL WHERE id = ?")
      .run(draft ? "cancelled" : "dismissed", detail, id);
    database.prepare("UPDATE bindings SET pending_task_id = NULL WHERE owner = ? AND session_name = ? AND pending_task_id = ?")
      .run(owner, task.session_name, id);
  });
}

export function listTasks(database, owner, limit, sessionName = defaultSession) {
  return database.prepare(`
    SELECT id AS task_id, session_name, state, workspace, thread_id, created_at, updated_at,
      execution_mode, desktop_fallback, approvals_json, substr(coalesce(detail, report, ''), 1, 240) AS detail
    FROM tasks WHERE owner = ? AND session_name = ? ORDER BY rowid DESC LIMIT ?
  `).all(owner, sessionName, limit).map(({ approvals_json, desktop_fallback, ...task }) => ({
    ...task, desktop_fallback: Boolean(desktop_fallback), approvals: approvals_json ? JSON.parse(approvals_json) : [],
  }));
}

export function taskIdsForTurn(database, { owner, thread_id: threadId, turn_id: turnId }) {
  if (!threadId || !turnId) return [];
  return database.prepare(`
    SELECT id FROM tasks WHERE owner = ? AND thread_id = ? AND turn_id = ? ORDER BY rowid ASC
  `).all(owner, threadId, turnId).map(({ id }) => id);
}

export async function bindingStatus(database, owner, readThread, sessionName = defaultSession) {
  const current = () => getBinding(database, owner, sessionName)?.thread_id ?? null;
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
  for (let page = 0; page < 5; page++) {
    const result = await reader.read(method, { ...params, ...(cursor && { cursor }) });
    yield result.data;
    if (!result.nextCursor || result.nextCursor === cursor) return;
    cursor = result.nextCursor;
  }
}

export function validateFollowUp(database, owner, taskId, newChat, sessionName = defaultSession) {
  if (newChat) throw new Error("补单不能要求新开会话。");
  const task = database.prepare("SELECT thread_id, state, session_name FROM tasks WHERE owner = ? AND id = ?").get(owner, taskId);
  if (!task?.thread_id) throw new Error("当前对话没有这条已关联 Codex 会话的原工单，无法补单。");
  if (task.session_name !== sessionName) throw new Error(`原工单属于子会话 ${task.session_name}，请在原子会话补单。`);
  if (task.state === "cancelled" || task.state === "dismissed") throw new Error("这条工单已停止跟踪，无法补单。");
  const binding = getBinding(database, owner, sessionName);
  if (binding?.thread_id !== task.thread_id) throw new Error("当前已换绑或解绑，未向其他会话投递补单。");
  return task.thread_id;
}

function markedTaskIds(turn) {
  const ids = new Set();
  for (const item of turn.items) {
    if (item.type !== "userMessage") continue;
    for (const input of item.content) {
      const marker = input.type === "text" && taskMarker.exec(input.text);
      if (marker) ids.add(marker[1].toLowerCase());
    }
  }
  return ids;
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
    turn = turns.find(item => task.turn_id ? item.id === task.turn_id : markedTaskIds(item).has(task.id));
    if (turn) break;
  }
  if (!turn) return;

  transaction(database, () => {
    markAccepted(database, task.id, task.thread_id, turn.id);
    // A steered prompt may be visible in history before its own watcher associates the task.
    const unlinked = database.prepare(`
      SELECT id FROM tasks WHERE id = ? AND owner = ? AND thread_id = ? AND turn_id IS NULL
    `);
    for (const id of markedTaskIds(turn)) {
      if (id !== task.id && unlinked.get(id, task.owner, task.thread_id)) {
        markAccepted(database, id, task.thread_id, turn.id);
      }
    }

    let state, report = null, detail = null;
    if (turn.status === "failed") {
      state = "failed";
      detail = turn.error?.message ?? "Codex 回合失败。";
    } else if (turn.status === "interrupted" && Number.isSafeInteger(turn.completedAt) && turn.completedAt > 0) {
      state = "interrupted";
      detail = "Codex 回合已中止。";
    } else if (turn.status === "completed") {
      report = finalMessage(turn)?.text ?? null;
      state = report ? "reported" : "no_report";
      if (!report) detail = "Codex 回合已完成，记录中没有最终文字回复。";
    }
    if (!state) return;
    for (const id of taskIdsForTurn(database, { ...task, turn_id: turn.id })) {
      recordResult(database, id, state, report, detail);
    }
  });
}

export async function refreshTask(database, reader, task, activeDispatches) {
  if (task.writer_pid) return;
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
    throw error;
  } finally {
    // A matching turn or late dispatch receipt takes precedence over a missing history entry.
    database.prepare("UPDATE tasks SET state = 'dispatch_unknown', detail = ? WHERE id = ? AND state = 'dispatching'")
      .run(detail, task.id);
  }
}
