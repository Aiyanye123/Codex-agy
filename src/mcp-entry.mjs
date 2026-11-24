import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import core from "../core.cjs";
import {
  assertNoDirectWriter, bindingStatus, clearExpiredReports, dismissTask, dispatchLeaseMs, listTasks, ongoing,
  readWithRetry, refreshTask, releaseAbandonedWriter, taskIdsForTurn, validateFollowUp, waitingForUser,
} from "./task-state.mjs";
import { searchWorkspace } from "./workspace-search.mjs";
import { excerpt, receiptInstruction, recentReplies, reportFields } from "./receipt.mjs";
import { addWorktree, inspectWorktree, planWorktree } from "./worktree.mjs";
import { DirectRun, desktopOwnsThread } from "./direct-run.mjs";

const {
  bindingWorktree, bindThread, CodexReader, defaultSession, getBinding, markAccepted, openDatabase, queueTask,
  sameWorkspace, saveBinding, startDesktop, threadIdFrom, transaction, workspacePath,
} = core;
const [, , directory, statePath, codex] = process.argv;
const workspace = workspacePath(directory);
const database = openDatabase(statePath);
clearExpiredReports(database);
const reader = new CodexReader(codex);
const server = new McpServer({ name: "agy-codex-bridge", version: "0.1.0" }, {
  instructions: "Use bridge tools directly.",
});
const watching = new Set();
const activeDispatches = new Set();
const directRuns = new Map();
const taskChanges = new EventEmitter();
let stopping = false;
const desktopTakeover = "检测到 Codex App 桌面端已接手该会话，已自动降级为排队模式。此工单沿用桌面会话的沙箱和审批设置。";
const completedWatches = new Map();
const completedWatchLimit = 1024;
const codexTerminalStates = new Set(["reported", "no_report", "failed", "interrupted"]);
const sessionNameParam = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).optional()
  .describe("目标子会话名。省略时使用 default。");

function conversationOwner(context) {
  const owner = context._meta?.["antigravity.google/root_conversation_id"];
  if (typeof owner !== "string" || !owner.trim() || owner.length > 200) {
    throw new Error("Antigravity 未提供会话 ID。请使用支持 MCP 根会话元数据的 agy 1.4.4 或更新版本。");
  }
  return owner;
}

function taskById(owner, id) {
  return database.prepare("SELECT * FROM tasks WHERE owner = ? AND id = ?").get(owner, id);
}

function taskInSession(owner, id, sessionName) {
  const task = taskById(owner, id);
  if (!task) throw new Error("当前 Antigravity 对话没有这条桥接任务。");
  if (task.session_name !== sessionName) throw new Error(`工单属于子会话 ${task.session_name}，请指定该子会话。`);
  return task;
}

async function bindingOverview(owner) {
  const rows = database.prepare("SELECT * FROM bindings WHERE owner = ? ORDER BY session_name").all(owner);
  return Promise.all(rows.map(async row => {
    let directory = row.workspace;
    if (directory === null && row.thread_id) {
      const current = await bindingStatus(database, owner, readThread, row.session_name);
      if (current.bound_thread_id === row.thread_id) directory = current.bound_workspace;
    }
    return {
      session_name: row.session_name, thread_id: row.thread_id, pending_task_id: row.pending_task_id,
      workspace: directory, worktree: bindingWorktree(row), execution_mode: row.execution_mode,
    };
  }));
}

function worktreeNotice(worktree) {
  if (!worktree) return null;
  const branch = worktree.branch ? `（分支 ${worktree.branch}）` : "";
  return `工作树已保留在 ${worktree.path}${branch}，请按需自行合并或清理。`;
}

function reply(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

function textReply(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function reportStatus(task, watchState, extra = {}, reportMode = "none", turnTaskIds = taskIdsForTurn(database, task)) {
  const binding = getBinding(database, task.owner, task.session_name);
  const worktree = binding?.workspace && sameWorkspace(binding.workspace, task.workspace) ? bindingWorktree(binding) : null;
  const render = reportMode === "none" ? reply : textReply;
  return render({
    task_id: task.id,
    session_name: task.session_name,
    state: task.state,
    workspace: task.workspace,
    thread_id: task.thread_id,
    thread_url: task.thread_id ? `codex://threads/${task.thread_id}` : null,
    turn_id: task.turn_id,
    execution_mode: task.execution_mode,
    desktop_fallback: Boolean(task.desktop_fallback),
    ...(task.desktop_fallback && { execution_note: desktopTakeover }),
    approvals: task.approvals_json ? JSON.parse(task.approvals_json) : [],
    ...(task.tool_results_json && reportMode !== "none" && { tool_results: JSON.parse(task.tool_results_json) }),
    ...(turnTaskIds.length > 1 && { shared_turn_task_ids: turnTaskIds }),
    ...reportFields(task.report, reportMode),
    ...(task.state === "reported" && task.report === null && {
      report_note: "工单已完成。本地回执原文不可用。已完结工单的回执原文超过 30 天后会自动清理。",
    }),
    detail: task.detail && excerpt(task.detail, 500),
    created_at: task.created_at,
    updated_at: task.updated_at,
    bound_thread_id: binding?.thread_id ?? null,
    worktree,
    ...(worktree && ["dismissed", "cancelled"].includes(task.state) && { worktree_note: worktreeNotice(worktree) }),
    can_follow_up: Boolean(task.thread_id && task.thread_id === binding?.thread_id && !["dismissed","cancelled"].includes(task.state)),
    ...(watchState && { watch_state: watchState }),
    ...extra,
  });
}

function completedWatch(task, signal) {
  signal.throwIfAborted();
  if (!task.thread_id || !task.turn_id || !codexTerminalStates.has(task.state)) {
    return reportStatus(task, undefined, {}, "summary");
  }

  const turnTaskIds = taskIdsForTurn(database, task);
  const key = JSON.stringify([task.owner, task.thread_id, task.turn_id]);
  const reportedBy = completedWatches.get(key);
  if (reportedBy && turnTaskIds.length > 1) {
    return reportStatus(task, undefined, {
      shared_turn_reported_by: reportedBy,
      report_note: "同一 Codex 回合的结果已由其他等待通知返回，可查询工单读取回执。",
    }, "none", turnTaskIds);
  }

  const result = reportStatus(task, undefined, {}, "summary", turnTaskIds);
  // Keep the first result even if another task is only associated with this turn later.
  if (!reportedBy) {
    if (completedWatches.size >= completedWatchLimit) completedWatches.delete(completedWatches.keys().next().value);
    completedWatches.set(key, task.id);
  }
  return result;
}

async function readThread(threadId) {
  const { thread } = await reader.read("thread/read", { threadId, includeTurns: false });
  if (thread?.id !== threadId || !thread.cwd) throw new Error("找不到带本机工作目录的 Codex 会话。");
  return { directory: workspacePath(thread.cwd), name: thread.name ?? null };
}

async function readDispatchWorkspace(threadId, savedWorkspace, mode) {
  try {
    return (await readThread(threadId)).directory;
  } catch (error) {
    if (error.code !== -32600 || !error.message.startsWith(`thread not loaded: ${threadId}`)) throw error;
    // The history reader has its own app-server. Let the direct writer attempt to resume the same thread.
    if (mode === "direct" && savedWorkspace) return workspacePath(savedWorkspace);
    throw new Error(`未派单。Codex 无法读取绑定会话 ${threadId}（thread/read: thread not loaded）。请在 Codex App 打开该会话后重试。如果会话已不可用，请重新绑定或新开会话。`, { cause: error });
  }
}

function setBindingMode(owner, sessionName, threadId, mode) {
  database.prepare("UPDATE bindings SET execution_mode = ? WHERE owner = ? AND session_name = ? AND thread_id = ?")
    .run(mode, owner, sessionName, threadId);
}

function draftUri(directory, message) {
  return `codex://threads/new?${new URLSearchParams({ path: directory, prompt: message })}`;
}

function createTask(id, owner, sessionName, prompt, target, explicitNewChat, pendingTaskId) {
  const markedPrompt = `[AGY Codex task: ${id}]\n\n${prompt}`;
  return transaction(database, () => {
    const binding = getBinding(database, owner, sessionName);
    assertNoDirectWriter(database, owner, sessionName, target.threadId);
    if (!explicitNewChat && (binding?.thread_id ?? null) !== target.threadId) {
      throw new Error("当前绑定在派单前发生了变化，请确认目标会话。");
    }
    if (binding?.pending_task_id) {
      const pending = taskById(owner, binding.pending_task_id);
      if (pending && ongoing.has(pending.state) &&
        (!explicitNewChat || binding.pending_task_id !== pendingTaskId || pending.state === "dispatching")) return { pending };
    }
    const newChat = !target.threadId;
    let message = markedPrompt + receiptInstruction;
    let uri = newChat && target.mode === "desktop" ? draftUri(target.directory, message) : null;
    if (uri?.length > 8000) {
      // Keep drafts that fit without the receipt instruction compatible with the desktop URI limit.
      message = markedPrompt;
      uri = draftUri(target.directory, message);
      if (uri.length > 8000) throw new Error("首单超过桌面链接的长度上限。请压缩工单，把长材料留在工作目录并引用文件。");
    }
    database.prepare(`
      INSERT INTO tasks (id, owner, session_name, workspace, thread_id, state, dispatch_deadline, draft_prompt,
        execution_mode, writer_pid)
      VALUES (?, ?, ?, ?, ?, 'dispatching', ?, ?, ?, ?)
    `).run(id, owner, sessionName, target.directory, target.threadId, Date.now() + dispatchLeaseMs,
      uri ? message : null, target.mode, target.mode === "direct" ? process.pid : null);
    if (newChat) {
      saveBinding(database, owner, sessionName, null, id, target.directory, target.worktree, target.mode);
    } else if (target.requestedMode === "desktop") {
      setBindingMode(owner, sessionName, target.threadId, "desktop");
    }
    return { id, message, uri, previousBinding: binding };
  });
}

function failBeforeDispatch(owner, sessionName, task, detail) {
  transaction(database, () => {
    database.prepare(`
      UPDATE tasks SET state = 'dispatch_failed', detail = ?, dispatch_deadline = NULL, draft_prompt = NULL, writer_pid = NULL
      WHERE id = ? AND state = 'dispatching'
    `).run(detail, task.id);
    if (getBinding(database, owner, sessionName)?.pending_task_id !== task.id) return;
    const previous = task.previousBinding;
    if (previous) {
      saveBinding(database, owner, sessionName, previous.thread_id, previous.pending_task_id,
        previous.workspace, bindingWorktree(previous), previous.execution_mode);
    } else {
      database.prepare("DELETE FROM bindings WHERE owner = ? AND session_name = ?").run(owner, sessionName);
    }
  });
}

function storeApprovals(taskId, approvals) {
  let state = "running";
  if (approvals.length) {
    state = approvals.some(request => request.type !== "user_input") ? "waiting_approval" : "waiting_user_input";
  }
  const update = database.prepare(`
    UPDATE tasks SET state = ?, approvals_json = ?
    WHERE id = ? AND writer_pid = ? AND state IN ('running', 'waiting_approval', 'waiting_user_input')
  `).run(state, approvals.length ? JSON.stringify(approvals) : null, taskId, process.pid);
  if (update.changes) taskChanges.emit(taskId);
}

async function finishDirect(taskId, run) {
  const { turn, final, toolResults, unsettledTools, error } = await run.done;
  let state = "dispatch_unknown";
  let detail = null;
  if (turn?.status === "completed") {
    state = final?.trim() ? "reported" : "no_report";
    if (state === "no_report") detail = "Codex 回合已完成，记录中没有最终文字回复。";
    if (unsettledTools) detail = [detail, "收尾窗口内仍有工具项未返回结果。"].filter(Boolean).join(" ");
  } else if (turn?.status === "interrupted") {
    state = "interrupted";
    detail = "Codex 回合已中止。";
  } else if (turn?.status === "failed") {
    state = "failed";
    detail = turn.error?.message ?? "Codex 回合失败。";
  } else {
    detail = `直连未收到最终状态：${error?.message ?? "未知错误"} 请核对原工单，避免重复派单。`;
  }
  try {
    database.prepare(`
      UPDATE tasks SET state = 'finishing', report = ?, detail = ?, tool_results_json = ?, approvals_json = NULL
      WHERE id = ? AND writer_pid = ?
    `).run(state === "reported" ? final : null, detail, toolResults?.length ? JSON.stringify(toolResults) : null, taskId, process.pid);
  } finally {
    await run.close();
    database.prepare(`
      UPDATE tasks SET state = ?, writer_pid = NULL, dispatch_deadline = NULL
      WHERE id = ? AND writer_pid = ?
    `).run(state, taskId, process.pid);
    directRuns.delete(taskId);
    taskChanges.emit(taskId);
  }
}

async function launchDirect(owner, sessionName, task, target, sandbox, approvalPolicy) {
  let run;
  try {
    if (stopping) throw new Error("桥接正在关闭。");
    run = new DirectRun(codex, target.directory, sandbox, approvals => storeApprovals(task.id, approvals));
    directRuns.set(task.id, run);
    const turnId = await run.start({
      threadId: target.threadId, taskId: task.id, message: task.message, sandbox, approvalPolicy,
      onThread: threadId => database.prepare("UPDATE tasks SET thread_id = ? WHERE id = ? AND writer_pid = ?")
        .run(threadId, task.id, process.pid),
    });
    transaction(database, () => {
      markAccepted(database, task.id, run.threadId, turnId, process.pid);
      database.prepare("UPDATE tasks SET dispatch_deadline = NULL WHERE id = ?").run(task.id);
      setBindingMode(owner, sessionName, run.threadId, "direct");
    });
    storeApprovals(task.id, run.approvals);
    run.finished = finishDirect(task.id, run);
    void run.finished.catch(error => process.stderr.write(`AGY Codex Bridge: ${error.message}\n`));
    return "started";
  } catch (error) {
    await run?.close();
    directRuns.delete(task.id);
    if (target.threadId && desktopOwnsThread(error)) {
      transaction(database, () => {
        database.prepare("UPDATE tasks SET execution_mode = 'desktop', desktop_fallback = 1 WHERE id = ?").run(task.id);
        setBindingMode(owner, sessionName, target.threadId, "desktop");
      });
      return "fallback";
    }
    const source = error.method ? `（${error.method}）` : "";
    if (run?.turnRequested) {
      const detail = `直连派单未确认${source}：${error.message}`;
      database.prepare(`
        UPDATE tasks SET state = 'dispatch_unknown', detail = ?, writer_pid = NULL, dispatch_deadline = NULL WHERE id = ?
      `).run(`${detail} 请查询原工单，避免重复派单。`, task.id);
    } else {
      failBeforeDispatch(owner, sessionName, task, `直连未派单${source}：${error.message}`);
    }
    taskChanges.emit(task.id);
    return "failed";
  }
}

async function waitForTaskChange(task, ms, signal) {
  if (!directRuns.has(task.id)) {
    await delay(Math.min(ms, 250), undefined, { signal });
    return;
  }
  const timeout = AbortSignal.timeout(ms);
  try {
    await once(taskChanges, task.id, { signal: AbortSignal.any([signal, timeout]) });
  } catch (error) {
    signal.throwIfAborted();
    if (!timeout.aborted) throw error;
  }
}

async function waitForResult(owner, taskId, waitSeconds, interval, signal) {
  const deadline = Date.now() + waitSeconds * 1000;
  const historyReader = { read: (method, params) => readWithRetry(reader, method, params, taskId, signal) };
  do {
    signal.throwIfAborted();
    let task = taskById(owner, taskId);
    if (!task) throw new Error("当前 Antigravity 对话没有这条桥接任务。");
    if (releaseAbandonedWriter(database, task)) task = taskById(owner, taskId);
    if (waitingForUser.has(task.state)) return task;
    if (task.writer_pid) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return task;
      await waitForTaskChange(task, remaining, signal);
      continue;
    }
    if (!ongoing.has(task.state)) return task;
    try {
      await refreshTask(database, historyReader, task, activeDispatches);
    } catch (error) {
      const latest = taskById(owner, taskId);
      if (latest && !ongoing.has(latest.state)) return latest;
      throw error;
    }
    task = taskById(owner, taskId);
    const remaining = deadline - Date.now();
    if (!ongoing.has(task.state) || remaining <= 0) return task;
    if (task.execution_mode === "direct" && task.state === "dispatch_unknown") return task;
    await delay(Math.min(interval, remaining), undefined, { signal });
  } while (true);
}

server.registerTool("bind", {
  description: "将用户明确给出的本机 Codex 会话深链接或 UUID 绑定到当前 Antigravity 对话。只查询会话与目录，不派单。",
  inputSchema: { session: z.string().min(1).max(200), session_name: sessionNameParam },
}, async ({ session, session_name: sessionName = defaultSession }, context) => {
  const owner = conversationOwner(context);
  const threadId = threadIdFrom(session);
  const thread = await readThread(threadId);
  const worktree = await inspectWorktree(thread.directory);
  transaction(database, () => {
    assertNoDirectWriter(database, owner, sessionName);
    const previous = bindingWorktree(getBinding(database, owner, sessionName));
    if (worktree && previous && sameWorkspace(worktree.path, previous.path)) worktree.base_commit = previous.base_commit;
    bindThread(database, owner, threadId, sessionName, thread.directory, worktree);
  });
  return reply({
    state: "bound", session_name: sessionName, thread_id: threadId, workspace: thread.directory, name: thread.name,
    worktree, execution_mode: "desktop",
    thread_url: `codex://threads/${threadId}`,
  });
});

server.registerTool("unbind", {
  description: "当用户说“取消绑定”或“解绑”时，清除当前 Antigravity 对话的 Codex 目标和待绑定请求。已发出的工单仍可查询。",
  inputSchema: { session_name: sessionNameParam },
}, async ({ session_name: sessionName = defaultSession }, context) => {
  const owner = conversationOwner(context);
  const binding = transaction(database, () => {
    assertNoDirectWriter(database, owner, sessionName);
    return database.prepare("DELETE FROM bindings WHERE owner = ? AND session_name = ? RETURNING *").get(owner, sessionName);
  });
  const worktree = bindingWorktree(binding);
  return reply({
    state: "unbound",
    session_name: sessionName,
    previous_thread_id: binding?.thread_id ?? null,
    worktree,
    worktree_note: worktreeNotice(worktree),
    detail: binding ? "已取消目标子会话的 Codex 绑定。" : "目标子会话没有绑定 Codex 会话。",
  });
});

server.registerTool("submit", {
  description: "向目标子会话发送工单。新会话默认打开 Codex App 草稿，已绑定的桌面会话走排队。显式指定 execution_mode=direct 可切换到直连，同一绑定后续会沿用该模式，直到显式切回 desktop 或桌面占锁触发自动降级。新会话可用 worktree 隔离。",
  inputSchema: {
    prompt: z.string().trim().min(1).max(12000),
    new_chat: z.boolean().optional(),
    session_name: sessionNameParam,
    worktree: z.boolean().optional().describe("为新会话创建独立 Git 工作树。"),
    execution_mode: z.enum(["direct", "desktop"]).optional(),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional().describe("直连工单的沙箱覆盖，省略时沿用 Codex 配置。"),
    approval_policy: z.enum(["never", "on-request", "untrusted"]).optional().describe("直连工单的审批策略覆盖。"),
    follow_up_task_id: z.string().uuid().optional().describe("补单时传原工单 ID，以核对投递目标。"),
  },
}, async ({
  prompt, new_chat: newChat, session_name: sessionName = defaultSession, worktree: isolated,
  follow_up_task_id: followUpTaskId, execution_mode: requestedMode, sandbox, approval_policy: approvalPolicy,
}, context) => {
  const owner = conversationOwner(context);
  const binding = getBinding(database, owner, sessionName);
  let threadId = newChat ? null : binding?.thread_id ?? null;
  if (followUpTaskId) threadId = validateFollowUp(database, owner, followUpTaskId, newChat, sessionName);
  if (threadId && isolated) throw new Error("只能为新会话创建工作树。请选择未绑定的子会话或明确另开会话。");
  const mode = requestedMode ?? (threadId ? binding.execution_mode : "desktop");
  if (mode === "desktop" && (sandbox || approvalPolicy)) {
    throw new Error("桌面模式沿用 Codex App 会话设置。要传 sandbox 或 approval_policy，请指定 execution_mode: \"direct\"。");
  }
  const id = randomUUID();
  const worktree = isolated ? await planWorktree(workspace, id) : null;
  const actualWorkspace = threadId ? await readDispatchWorkspace(threadId, binding.workspace, mode) : worktree?.path ?? workspace;
  const target = { directory: actualWorkspace, threadId, worktree, mode, requestedMode };
  const task = createTask(id, owner, sessionName, prompt, target, newChat, binding?.pending_task_id);
  if (task.pending) {
    return reportStatus(task.pending, null, {
      new_task_dispatched: false,
      detail: "未派发本次新单。目标子会话已有未结束的首单，请查询、恢复或放弃原单。"
        + (task.pending.detail ?? ""),
    });
  }
  let state = threadId ? "queued" : "awaiting_send";
  let detail = threadId ? "已入队，等待 Codex App 领取。" : "请在 Codex App 审核预填工单并点发送。";
  activeDispatches.add(task.id);
  try {
    if (worktree) {
      try {
        await addWorktree(worktree);
        if (getBinding(database, owner, sessionName)?.pending_task_id !== task.id) {
          throw new Error("子会话在创建工作树期间已变更，未派单。");
        }
      } catch (error) {
        const failure = `${error.message} 工作树目标路径为 ${worktree.path}（分支 ${worktree.branch}）。`;
        failBeforeDispatch(owner, sessionName, task, failure);
        return reportStatus(taskById(owner, task.id), null, { new_task_dispatched: false, worktree, detail: failure });
      }
    }
    if (mode === "direct") {
      const result = await launchDirect(owner, sessionName, task, target, sandbox, approvalPolicy);
      if (result !== "fallback") return reportStatus(taskById(owner, task.id));
      detail = desktopTakeover;
    }
    if (threadId) await queueTask(codex, actualWorkspace, threadId, task.message);
    else await startDesktop(task.uri);
  } catch (error) {
    state = threadId || error.killed ? "dispatch_unknown" : "dispatch_failed";
    const reason = error.killed ? "本机调度超时。" : error.stderr?.trim().slice(0, 500) || error.code;
    detail = `调度未确认：${reason ?? "进程返回错误"}。请先查看原任务，避免重复派单。`;
  } finally {
    activeDispatches.delete(task.id);
  }
  database.prepare(`
    UPDATE tasks SET state = ?, detail = ?, dispatch_deadline = NULL, writer_pid = NULL
    WHERE id = ? AND state IN ('dispatching', 'dispatch_unknown')
  `).run(state, detail, task.id);
  taskChanges.emit(task.id);
  return reportStatus(taskById(owner, task.id));
});

server.registerTool("status", {
  description: "查询当前 Antigravity 工单的状态。默认只查进度；report_mode=summary 查简短结果，full 才取完整回执。可等待至多 25 秒。",
  inputSchema: {
    task_id: z.string().uuid().optional(),
    session_name: sessionNameParam,
    wait_seconds: z.number().int().min(0).max(25).optional(),
    report_mode: z.enum(["none", "summary", "full"]).optional(),
  },
}, async ({ task_id: taskId, session_name: sessionName = defaultSession, wait_seconds: waitSeconds = 0, report_mode: reportMode = "none" }, context) => {
  const owner = conversationOwner(context);
  taskId ??= database.prepare("SELECT id FROM tasks WHERE owner = ? AND session_name = ? ORDER BY rowid DESC LIMIT 1")
    .get(owner, sessionName)?.id;
  if (!taskId) {
    const binding = await bindingStatus(database, owner, readThread, sessionName);
    return reply({
      state: "no_task",
      session_name: sessionName,
      execution_mode: getBinding(database, owner, sessionName)?.execution_mode ?? "desktop",
      thread_id: binding.bound_thread_id,
      ...binding,
      bindings: await bindingOverview(owner),
      new_chat_workspace: workspace,
      detail: "目标子会话还没有派单。",
    });
  }
  taskInSession(owner, taskId, sessionName);
  await waitForResult(owner, taskId, waitSeconds, 2000, context.signal);
  const binding = await bindingStatus(database, owner, readThread, sessionName);
  const bindings = await bindingOverview(owner);
  return reportStatus(taskById(owner, taskId), null, { ...binding, bindings }, reportMode);
});

server.registerTool("list_tasks", {
  description: "列出目标子会话最近的工单，以及当前对话的全部子会话绑定。",
  inputSchema: { limit: z.number().int().min(1).max(100).default(10), session_name: sessionNameParam },
}, async ({ limit, session_name: sessionName = defaultSession }, context) => {
  const owner = conversationOwner(context);
  const writers = database.prepare("SELECT id, writer_pid, state, detail FROM tasks WHERE owner = ? AND session_name = ? AND writer_pid IS NOT NULL")
    .all(owner, sessionName);
  for (const writer of writers) releaseAbandonedWriter(database, writer);
  return reply({ tasks: listTasks(database, owner, limit, sessionName), bindings: await bindingOverview(owner) });
});

server.registerTool("search_workspace", {
  description: "只读检索 Antigravity 当前工作区。files 找路径，docs 查文档，code 定位代码和配置，text 搜全部文本。path 限定相对路径，glob 可过滤文件。默认按字面匹配，文字结果返回行号和短片段。",
  inputSchema: z.strictObject({
    mode: z.enum(["files", "docs", "code", "text"]),
    query: z.string().trim().max(120).regex(/^[^\x00-\x1f\x7f]*$/u).optional(),
    path: z.string().max(500).regex(/^[^\x00-\x1f\x7f]+$/u).optional(),
    glob: z.string().max(120).regex(/^[^\x00-\x1f\x7f]+$/u).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    per_file: z.number().int().min(1).max(8).optional(),
    case_sensitive: z.boolean().optional(),
    whole_word: z.boolean().optional(),
    regex: z.boolean().optional(),
    context_lines: z.number().int().min(0).max(2).optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async (options, context) => textReply(await searchWorkspace(workspace, options, context.signal)));

server.registerTool("recent_replies", {
  description: "按需查看当前 Antigravity 对话已绑定的 Codex 会话中最近的最终回复，默认三条、最多六条；无需工单，不会续写会话。",
  inputSchema: z.strictObject({ limit: z.number().int().min(1).max(6).optional(), session_name: sessionNameParam }),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ limit = 3, session_name: sessionName = defaultSession }, context) => {
  const owner = conversationOwner(context);
  const current = () => getBinding(database, owner, sessionName)?.thread_id;
  const threadId = current();
  if (!threadId) throw new Error("请先绑定要回看的 Codex 会话。");
  const replies = await recentReplies(reader, threadId, limit, context.signal);
  if (current() !== threadId) throw new Error("读取时绑定已变化，请核对会话后重试。");
  return textReply({ session_name: sessionName, thread_id: threadId, replies });
});

server.registerTool("dismiss", {
  description: "用户明确要求放弃草稿或停止跟踪时使用。仅停止本地跟踪，不代表 Codex App 已撤回执行。",
  inputSchema: { task_id: z.string().uuid() },
}, async ({ task_id: id }, context) => {
  const owner = conversationOwner(context);
  dismissTask(database, owner, id);
  return reportStatus(taskById(owner, id));
});

server.registerTool("resume_draft", {
  description: "用户明确要求恢复未发送的首单时，在原目录重新打开带原标记的草稿，仍需手动发送。",
  inputSchema: { task_id: z.string().uuid(), session_name: sessionNameParam },
}, async ({ task_id: id, session_name: sessionName = defaultSession }, context) => {
  const owner = conversationOwner(context);
  taskInSession(owner, id, sessionName);
  const task = await waitForResult(owner, id, 0, 0, context.signal);
  const binding = getBinding(database, owner, sessionName);
  if (task.state !== "awaiting_send" || binding?.pending_task_id !== id) {
    throw new Error("只能恢复当前绑定中尚待发送的草稿。");
  }
  if (task.detail?.includes("无法唯一匹配")) throw new Error(task.detail);
  if (!task.draft_prompt) throw new Error("旧版草稿没有保存正文。请在 App 发送原草稿，或放弃后重新派单。");
  await startDesktop(draftUri(task.workspace, task.draft_prompt));
  return reportStatus(taskById(owner, id), null, {
    new_task_dispatched: false, detail: "已重新打开原草稿，请只在一个窗口点击发送。",
  });
});

function activeDirectRun(owner, taskId) {
  const task = taskById(owner, taskId);
  if (!task) throw new Error("当前 Antigravity 对话没有这条桥接任务。");
  const run = directRuns.get(taskId);
  if (!task.turn_id || task.execution_mode !== "direct" || !run?.finished || run.completed) {
    throw new Error("当前桥接没有这张工单正在运行的直连回合。请先查询工单状态。");
  }
  return run;
}

server.registerTool("steer", {
  description: "按用户指示纠偏正在运行的直连回合。不会另起一轮。",
  inputSchema: { task_id: z.string().uuid(), prompt: z.string().trim().min(1).max(12000) },
}, async ({ task_id: taskId, prompt }, context) => {
  const run = activeDirectRun(conversationOwner(context), taskId);
  const result = await run.steer(prompt);
  return reply({ task_id: taskId, turn_id: result.turnId, steered: true });
});

server.registerTool("interrupt", {
  description: "按用户要求中断正在运行的直连回合，等待 Codex 确认最终状态。",
  inputSchema: { task_id: z.string().uuid() },
}, async ({ task_id: taskId }, context) => {
  const owner = conversationOwner(context);
  const run = activeDirectRun(owner, taskId);
  await run.interrupt();
  const timer = new AbortController();
  try {
    await Promise.race([run.finished, delay(20000, undefined, { signal: AbortSignal.any([context.signal, timer.signal]) })]);
  } finally {
    timer.abort();
  }
  const task = taskById(owner, taskId);
  return reportStatus(task, null, ongoing.has(task.state) ? { interrupt_pending: true } : {});
});

server.registerTool("approve", {
  description: "把用户对指定审批请求的明确决定传给原直连回合。用户输入请求用 answer 与按问题 ID 给出的 answers。",
  inputSchema: {
    task_id: z.string().uuid(),
    request_id: z.union([z.string(), z.number().int()]),
    decision: z.enum(["accept", "decline", "cancel", "answer"]),
    answers: z.record(z.string(), z.array(z.string().max(12000))).optional(),
  },
}, async ({ task_id: taskId, request_id: requestId, decision, answers }, context) => {
  const owner = conversationOwner(context);
  const run = activeDirectRun(owner, taskId);
  await run.approve(requestId, decision, answers);
  return reportStatus(taskById(owner, taskId), null, { resolved_request_id: requestId });
});

server.registerTool("watch", {
  description: "后台等待工单到达审批、用户输入或终态。回应待处理请求后再次调用。",
  inputSchema: { task_id: z.string().uuid() },
}, async ({ task_id: taskId }, context) => {
  const owner = conversationOwner(context);
  const task = taskById(owner, taskId);
  if (!task) throw new Error("当前 Antigravity 对话没有这条桥接任务。");
  if (!ongoing.has(task.state)) return completedWatch(task, context.signal);
  if (watching.has(taskId)) return reportStatus(task, "already_watching");
  watching.add(taskId);
  try {
    const result = await waitForResult(owner, taskId, 3600, 5000, context.signal);
    if (waitingForUser.has(result.state)) return reportStatus(result, "action_required");
    if (result.execution_mode === "direct" && result.state === "dispatch_unknown") return reportStatus(result, "unconfirmed");
    if (ongoing.has(result.state)) return reportStatus(result, "timed_out", {}, "summary");
    return completedWatch(result, context.signal);
  } finally {
    watching.delete(taskId);
  }
});

server.server.onclose = () => {
  stopping = true;
  reader.close();
  for (const run of directRuns.values()) void run.stop();
};
process.stdin.once("end", () => void server.close());
process.once("SIGINT", () => void server.close());
process.once("SIGTERM", () => void server.close());
server.connect(new StdioServerTransport()).catch((error) => {
  process.stderr.write(`AGY Codex Bridge: ${error.message}\n`);
  process.exitCode = 1;
});
