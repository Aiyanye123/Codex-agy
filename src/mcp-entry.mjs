import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import core from "../core.cjs";
import {
  bindingStatus, clearExpiredReports, dismissTask, dispatchLeaseMs, listTasks, ongoing, readWithRetry, refreshTask, validateFollowUp,
} from "./task-state.mjs";
import { searchWorkspace } from "./workspace-search.mjs";
import { excerpt, receiptInstruction, recentReplies, reportFields } from "./receipt.mjs";

const {
  bindThread, CodexReader, openDatabase, queueTask,
  startDesktop, threadIdFrom, transaction, workspacePath,
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

function reply(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

function textReply(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function reportStatus(task, watchState, extra = {}, reportMode = "none") {
  const binding = database.prepare("SELECT thread_id FROM bindings WHERE owner = ?").get(task.owner);
  const render = reportMode === "none" ? reply : textReply;
  return render({
    task_id: task.id,
    state: task.state,
    workspace: task.workspace,
    thread_id: task.thread_id,
    thread_url: task.thread_id ? `codex://threads/${task.thread_id}` : null,
    turn_id: task.turn_id,
    ...reportFields(task.report, reportMode),
    ...(task.state === "reported" && task.report === null && {
      report_note: "工单已完成。本地回执原文不可用。已完结工单的回执原文超过 30 天后会自动清理。",
    }),
    detail: task.detail && excerpt(task.detail, 500),
    created_at: task.created_at,
    updated_at: task.updated_at,
    bound_thread_id: binding?.thread_id ?? null,
    can_follow_up: Boolean(task.thread_id && task.thread_id === binding?.thread_id && !["dismissed","cancelled"].includes(task.state)),
    ...(watchState && { watch_state: watchState }),
    ...extra,
  });
}

async function readThread(threadId) {
  const { thread } = await reader.read("thread/read", { threadId, includeTurns: false });
  if (thread?.id !== threadId || !thread.cwd) throw new Error("找不到带本机工作目录的 Codex 会话。");
  return { directory: workspacePath(thread.cwd), name: thread.name ?? null };
}

function draftUri(directory, message) {
  return `codex://threads/new?${new URLSearchParams({ path: directory, prompt: message })}`;
}

function createTask(owner, prompt, target, explicitNewChat) {
  const id = randomUUID();
  const markedPrompt = `[AGY Codex task: ${id}]\n\n${prompt}`;
  return transaction(database, () => {
    const binding = database.prepare("SELECT * FROM bindings WHERE owner = ?").get(owner);
    if (!explicitNewChat && (binding?.thread_id ?? null) !== target.threadId) {
      throw new Error("当前绑定在派单前发生了变化，请确认目标会话。");
    }
    if (!explicitNewChat && binding?.pending_task_id) {
      const pending = taskById(owner, binding.pending_task_id);
      if (pending && ongoing.has(pending.state)) return { pending };
    }
    const newChat = !target.threadId;
    let message = markedPrompt + receiptInstruction;
    let uri = newChat ? draftUri(target.directory, message) : null;
    if (uri?.length > 8000) {
      // Keep drafts that fit without the receipt instruction compatible with the desktop URI limit.
      message = markedPrompt;
      uri = draftUri(target.directory, message);
      if (uri.length > 8000) throw new Error("首单超过桌面链接的长度上限。请压缩工单，把长材料留在工作目录并引用文件。");
    }
    database.prepare(`
      INSERT INTO tasks (id, owner, workspace, thread_id, state, dispatch_deadline, draft_prompt)
      VALUES (?, ?, ?, ?, 'dispatching', ?, ?)
    `).run(id, owner, target.directory, target.threadId, Date.now() + dispatchLeaseMs, newChat ? message : null);
    if (newChat) {
      database.prepare(`
        INSERT INTO bindings (owner, pending_task_id) VALUES (?, ?)
        ON CONFLICT(owner) DO UPDATE SET thread_id = NULL, pending_task_id = excluded.pending_task_id
      `).run(owner, id);
    }
    return { id, message, uri };
  });
}

async function waitForResult(owner, taskId, waitSeconds, interval, signal) {
  const deadline = Date.now() + waitSeconds * 1000;
  const historyReader = { read: (method, params) => readWithRetry(reader, method, params, taskId, signal) };
  do {
    signal.throwIfAborted();
    let task = taskById(owner, taskId);
    if (!task) throw new Error("当前 Antigravity 对话没有这条桥接任务。");
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
    await delay(Math.min(interval, remaining), undefined, { signal });
  } while (true);
}

server.registerTool("bind", {
  description: "将用户明确给出的本机 Codex 会话深链接或 UUID 绑定到当前 Antigravity 对话。只查询会话与目录，不派单。",
  inputSchema: { session: z.string().min(1).max(200) },
}, async ({ session }, context) => {
  const owner = conversationOwner(context);
  const threadId = threadIdFrom(session);
  const thread = await readThread(threadId);
  bindThread(database, owner, threadId);
  return reply({
    state: "bound", thread_id: threadId, workspace: thread.directory, name: thread.name,
    thread_url: `codex://threads/${threadId}`,
  });
});

server.registerTool("unbind", {
  description: "当用户说“取消绑定”或“解绑”时，清除当前 Antigravity 对话的 Codex 目标和待绑定请求。已发出的工单仍可查询。",
  inputSchema: {},
}, async (_args, context) => {
  const owner = conversationOwner(context);
  const binding = database.prepare(`
    DELETE FROM bindings WHERE owner = ? RETURNING thread_id
  `).get(owner);
  return reply({
    state: "unbound",
    previous_thread_id: binding?.thread_id ?? null,
    detail: binding ? "已取消当前对话的 Codex 绑定。" : "当前对话没有绑定 Codex 会话。",
  });
});

server.registerTool("submit", {
  description: "发送工单。已绑定时投递到同一 Codex 会话，首次未绑定时在当前目录打开桌面新会话并预填，需用户点发送。只有用户明确要另开时才设置 new_chat。",
  inputSchema: {
    prompt: z.string().trim().min(1).max(12000),
    new_chat: z.boolean().optional(),
    follow_up_task_id: z.string().uuid().optional().describe("补单时传原工单 ID，以核对投递目标。"),
  },
}, async ({ prompt, new_chat: newChat, follow_up_task_id: followUpTaskId }, context) => {
  const owner = conversationOwner(context);
  const binding = database.prepare("SELECT * FROM bindings WHERE owner = ?").get(owner);
  let threadId = newChat ? null : binding?.thread_id ?? null;
  if (followUpTaskId) threadId = validateFollowUp(database, owner, followUpTaskId, newChat);
  const actualWorkspace = threadId ? (await readThread(threadId)).directory : workspace;
  const task = createTask(owner, prompt, { directory: actualWorkspace, threadId }, newChat);
  if (task.pending) {
    return reportStatus(task.pending, null, {
      new_task_dispatched: false,
      detail: "未派发本次新单。当前对话已有未结束的首单，请查询、恢复或放弃原单。"
        + (task.pending.detail ?? ""),
    });
  }
  let state = threadId ? "queued" : "awaiting_send";
  let detail = threadId ? "已入队，等待 Codex App 领取。" : "请在 Codex App 审核预填工单并点发送。";
  activeDispatches.add(task.id);
  try {
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
    UPDATE tasks SET state = ?, detail = ?, dispatch_deadline = NULL
    WHERE id = ? AND state IN ('dispatching', 'dispatch_unknown')
  `).run(state, detail, task.id);
  return reportStatus(taskById(owner, task.id));
});

server.registerTool("status", {
  description: "查询当前 Antigravity 工单的状态。默认只查进度；report_mode=summary 查简短结果，full 才取完整回执。可等待至多 25 秒。",
  inputSchema: {
    task_id: z.string().uuid().optional(),
    wait_seconds: z.number().int().min(0).max(25).optional(),
    report_mode: z.enum(["none", "summary", "full"]).optional(),
  },
}, async ({ task_id: taskId, wait_seconds: waitSeconds = 0, report_mode: reportMode = "none" }, context) => {
  const owner = conversationOwner(context);
  taskId ??= database.prepare("SELECT id FROM tasks WHERE owner = ? ORDER BY rowid DESC LIMIT 1").get(owner)?.id;
  if (!taskId) {
    const binding = await bindingStatus(database, owner, readThread);
    return reply({
      state: "no_task",
      thread_id: binding.bound_thread_id,
      ...binding,
      new_chat_workspace: workspace,
      detail: "当前对话还没有派单。",
    });
  }
  await waitForResult(owner, taskId, waitSeconds, 2000, context.signal);
  const binding = await bindingStatus(database, owner, readThread);
  return reportStatus(taskById(owner, taskId), null, binding, reportMode);
});

server.registerTool("list_tasks", {
  description: "列出当前对话最近的工单，包含状态、工作目录、时间与简要说明。",
  inputSchema: { limit: z.number().int().min(1).max(100).default(10) },
}, async ({ limit }, context) => reply({ tasks: listTasks(database, conversationOwner(context), limit) }));

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
  inputSchema: z.strictObject({ limit: z.number().int().min(1).max(6).optional() }),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ limit = 3 }, context) => {
  const owner = conversationOwner(context);
  const current = () => database.prepare("SELECT thread_id FROM bindings WHERE owner = ?").get(owner)?.thread_id;
  const threadId = current();
  if (!threadId) throw new Error("请先绑定要回看的 Codex 会话。");
  const replies = await recentReplies(reader, threadId, limit, context.signal);
  if (current() !== threadId) throw new Error("读取时绑定已变化，请核对会话后重试。");
  return textReply({ thread_id: threadId, replies });
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
  inputSchema: { task_id: z.string().uuid() },
}, async ({ task_id: id }, context) => {
  const owner = conversationOwner(context);
  const task = await waitForResult(owner, id, 0, 0, context.signal);
  const binding = database.prepare("SELECT pending_task_id FROM bindings WHERE owner = ?").get(owner);
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

server.registerTool("watch", {
  description: "后台等待当前 Antigravity 对话的指定 Codex 工单有最终回执，供 Gemini 验收并汇报。每个尚未完成的工单调用一次。",
  inputSchema: { task_id: z.string().uuid() },
}, async ({ task_id: taskId }, context) => {
  const owner = conversationOwner(context);
  const task = taskById(owner, taskId);
  if (!task) throw new Error("当前 Antigravity 对话没有这条桥接任务。");
  if (!ongoing.has(task.state)) return reportStatus(task, undefined, {}, "summary");
  if (watching.has(taskId)) return reportStatus(task, "already_watching");
  watching.add(taskId);
  try {
    const result = await waitForResult(owner, taskId, 3600, 5000, context.signal);
    return reportStatus(result, ongoing.has(result.state) ? "timed_out" : undefined, {}, "summary");
  } finally {
    watching.delete(taskId);
  }
});

server.server.onclose = () => reader.close();
process.stdin.once("end", () => void server.close());
server.connect(new StdioServerTransport()).catch((error) => {
  process.stderr.write(`AGY Codex Bridge: ${error.message}\n`);
  process.exitCode = 1;
});
