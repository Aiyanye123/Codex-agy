import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import core from "./core.cjs";

const {
  bindThread, CodexReader, markAccepted, openDatabase, queueTask, recordResult,
  startDesktop, taskMarker, threadIdFrom, transaction, workspacePath,
} = core;
const [, , directory, statePath, codex] = process.argv;
const workspace = workspacePath(directory);
const database = openDatabase(statePath);
const reader = new CodexReader(codex);
const server = new McpServer({ name: "agy-codex-bridge", version: "0.1.0" });
const ongoing = new Set(["dispatching", "dispatch_unknown", "awaiting_send", "queued", "running"]);
const watching = new Set();

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

function reportStatus(task, watchState) {
  const binding = database.prepare("SELECT thread_id FROM bindings WHERE owner = ?").get(task.owner);
  return reply({
    task_id: task.id,
    state: task.state,
    workspace: task.workspace,
    thread_id: task.thread_id,
    thread_url: task.thread_id ? `codex://threads/${task.thread_id}` : null,
    turn_id: task.turn_id,
    report: task.report,
    detail: task.detail,
    bound_thread_id: binding?.thread_id ?? null,
    can_follow_up: Boolean(task.thread_id && task.thread_id === binding?.thread_id),
    ...(watchState && { watch_state: watchState }),
  });
}

async function readThread(threadId) {
  const { thread } = await reader.read("thread/read", { threadId, includeTurns: false });
  if (thread?.id !== threadId || !thread.cwd) throw new Error("找不到带本机工作目录的 Codex 会话。");
  return { directory: workspacePath(thread.cwd), name: thread.name ?? null };
}

function createTask(owner, prompt, newChat, target) {
  const id = randomUUID();
  const message = `[AGY Codex task: ${id}]\n\n${prompt}`;
  let uri;
  if (newChat) {
    const parameters = new URLSearchParams({ path: workspace, prompt: message });
    uri = `codex://threads/new?${parameters}`;
    if (uri.length > 8000) throw new Error("首单超过桌面链接的长度上限。请压缩工单，把长材料留在工作目录并引用文件。");
  }
  transaction(database, () => {
    database.prepare(`
      INSERT INTO tasks (id, owner, workspace, thread_id, state)
      VALUES (?, ?, ?, ?, 'dispatching')
    `).run(id, owner, target.directory, target.threadId);
    if (newChat) {
      database.prepare(`
        INSERT INTO bindings (owner, pending_task_id) VALUES (?, ?)
        ON CONFLICT(owner) DO UPDATE SET thread_id = NULL, pending_task_id = excluded.pending_task_id
      `).run(owner, id);
    }
  });
  return { id, message, uri };
}

async function observeResult(task) {
  if (!task.thread_id) {
    const { data: threads } = await reader.read("thread/list", {
      cwd: task.workspace, limit: 12, modelProviders: [], sourceKinds: ["cli", "vscode", "appServer", "unknown"],
    });
    const marker = `[AGY Codex task: ${task.id}]`;
    const matchingThreads = threads.filter((thread) => thread.preview?.startsWith(marker));
    if (matchingThreads.length !== 1) return;
    task = { ...task, thread_id: matchingThreads[0].id };
  }
  const { data: turns } = await reader.read("thread/turns/list", {
    threadId: task.thread_id, limit: 20, sortDirection: "desc", itemsView: "full",
  });
  const turn = turns.find(({ id, items }) => task.turn_id ? id === task.turn_id :
    items.some((item) => item.type === "userMessage" && item.content.some((input) =>
      input.type === "text" && taskMarker.exec(input.text)?.[1]?.toLowerCase() === task.id)));
  if (!turn) return;

  const final = turn.items.findLast((item) => item.type === "agentMessage" && item.phase === "final_answer");
  const unphased = turn.status === "completed" && turn.items.findLast(
    (item) => item.type === "agentMessage" && item.phase == null,
  );
  transaction(database, () => {
    markAccepted(database, task.id, task.thread_id, turn.id);
    if (turn.status === "failed") {
      recordResult(database, task.id, "failed", null, turn.error?.message ?? "Codex 回合失败。");
    } else if (final?.text?.trim() || unphased?.text?.trim()) {
      recordResult(database, task.id, "reported", (final ?? unphased).text);
    } else if (turn.status === "completed") {
      recordResult(database, task.id, "no_report", null, "Codex 回合已完成，记录中没有最终文字回复。");
    }
  });
}

async function waitForResult(owner, taskId, waitSeconds, interval, signal) {
  const deadline = Date.now() + waitSeconds * 1000;
  do {
    signal.throwIfAborted();
    let task = taskById(owner, taskId);
    if (!task) throw new Error("当前 Antigravity 对话没有这条桥接任务。");
    if (!ongoing.has(task.state)) return task;
    if (task.state !== "dispatching") {
      await observeResult(task);
      task = taskById(owner, taskId);
    }
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
  },
}, async ({ prompt, new_chat: newChat }, context) => {
  const owner = conversationOwner(context);
  const binding = database.prepare("SELECT * FROM bindings WHERE owner = ?").get(owner);
  const threadId = newChat ? null : binding?.thread_id ?? null;
  if (!newChat && binding?.pending_task_id) {
    const pending = taskById(owner, binding.pending_task_id);
    if (pending && ongoing.has(pending.state)) return reportStatus(pending);
  }
  const actualWorkspace = threadId ? (await readThread(threadId)).directory : workspace;
  if (threadId && database.prepare("SELECT thread_id FROM bindings WHERE owner = ?").get(owner)?.thread_id !== threadId) {
    throw new Error("当前绑定在派单前发生了变化，请确认目标会话。");
  }
  const task = createTask(owner, prompt, !threadId, { directory: actualWorkspace, threadId });
  let state = threadId ? "queued" : "awaiting_send";
  let detail = threadId ? "已入队，等待 Codex App 领取。" : "请在 Codex App 审核预填工单并点发送。";
  try {
    if (threadId) await queueTask(codex, actualWorkspace, threadId, task.message);
    else await startDesktop(task.uri);
  } catch (error) {
    state = threadId || error.killed ? "dispatch_unknown" : "dispatch_failed";
    const reason = error.killed ? "本机调度超时。" : error.stderr?.trim().slice(0, 500) || error.code;
    detail = `调度未确认：${reason ?? "进程返回错误"}。请先查看原任务，避免重复派单。`;
  }
  database.prepare(`
    UPDATE tasks SET state = ?, detail = ? WHERE id = ? AND state = 'dispatching'
  `).run(state, detail, task.id);
  return reportStatus(taskById(owner, task.id));
});

server.registerTool("status", {
  description: "查询当前 Antigravity 对话的指定任务或最近任务，返回派单状态和 Codex 报告。可等待至多 25 秒。",
  inputSchema: {
    task_id: z.string().uuid().optional(),
    wait_seconds: z.number().int().min(0).max(25).optional(),
  },
}, async ({ task_id: taskId, wait_seconds: waitSeconds = 0 }, context) => {
  const owner = conversationOwner(context);
  taskId ??= database.prepare("SELECT id FROM tasks WHERE owner = ? ORDER BY rowid DESC LIMIT 1").get(owner)?.id;
  if (!taskId) {
    const binding = database.prepare("SELECT thread_id FROM bindings WHERE owner = ?").get(owner);
    return reply({
      state: "no_task",
      thread_id: binding?.thread_id ?? null,
      bound_thread_id: binding?.thread_id ?? null,
      new_chat_workspace: workspace,
      detail: "当前对话还没有派单。",
    });
  }
  return reportStatus(await waitForResult(owner, taskId, waitSeconds, 2000, context.signal));
});

server.registerTool("watch", {
  description: "后台等待当前 Antigravity 对话的指定 Codex 工单有最终回执，供 Gemini 验收并汇报。每个尚未完成的工单调用一次。",
  inputSchema: { task_id: z.string().uuid() },
}, async ({ task_id: taskId }, context) => {
  const owner = conversationOwner(context);
  const task = taskById(owner, taskId);
  if (!task) throw new Error("当前 Antigravity 对话没有这条桥接任务。");
  if (!ongoing.has(task.state)) return reportStatus(task);
  if (watching.has(taskId)) return reportStatus(task, "already_watching");
  watching.add(taskId);
  try {
    const result = await waitForResult(owner, taskId, 3600, 5000, context.signal);
    return reportStatus(result, ongoing.has(result.state) ? "timed_out" : undefined);
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
