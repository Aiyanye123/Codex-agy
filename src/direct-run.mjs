import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { finalMessage, excerpt } from "./receipt.mjs";

const requestTypes = new Map([
  ["item/commandExecution/requestApproval", "command"],
  ["item/fileChange/requestApproval", "file_change"],
  ["item/permissions/requestApproval", "permissions"],
  ["item/tool/requestUserInput", "user_input"],
]);
const toolTypes = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"]);
const decisions = ["accept", "decline", "cancel"];
const textInput = text => [{ type: "text", text, text_elements: [] }];

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => message ? reject(new Error(message)) : resolve(), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function desktopOwnsThread(error) {
  return error.method === "thread/resume" && error.code === -32600 && /already has an active writer/i.test(error.message);
}

export class DirectRun {
  constructor(codex, cwd, sandbox, onApprovalsChanged) {
    this.cwd = cwd;
    this.onApprovalsChanged = onApprovalsChanged;
    this.sequence = 0;
    this.requests = new Map();
    this.pending = new Map();
    this.tools = new Map();
    this.toolResults = [];
    this.final = null;
    const args = ["app-server", "--listen", "stdio://"];
    if (process.platform === "win32" && ["read-only", "workspace-write"].includes(sandbox)) {
      args.push("-c", 'windows.sandbox="mxc"');
    }
    const child = spawn(codex, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.exited = new Promise(resolve => child.once("close", (code, signal) => {
      const reason = this.connectionError ?? new Error(`Codex 执行连接已关闭（${code ?? signal}）。`);
      this.disconnect(reason);
      resolve();
    }));
    child.once("error", error => this.disconnect(error));
    child.stdin.on("error", error => this.disconnect(error));
    child.stderr.resume();
    createInterface({ input: child.stdout }).on("line", line => {
      try { this.receive(JSON.parse(line)); }
      catch (error) {
        this.disconnect(error);
        void this.close();
      }
    });
  }

  disconnect(error) {
    this.connectionError ??= error;
    for (const { reject } of this.requests.values()) reject(error);
    this.requests.clear();
    if (this.completed) this.finish();
    else this.resolveDone({ error });
    for (const request of this.pending.values()) request.resolve(false);
  }

  send(message) {
    if (this.connectionError || !this.child.stdin.writable) {
      throw this.connectionError ?? new Error("Codex 执行连接已关闭。");
    }
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  request(method, params) {
    const id = ++this.sequence;
    const response = new Promise((resolve, reject) => {
      this.requests.set(id, { method, resolve, reject });
      this.send({ id, method, params });
    });
    return withTimeout(response, 15000, `Codex ${method} 响应超时。`).finally(() => this.requests.delete(id));
  }

  async start({ threadId, taskId, message, sandbox, approvalPolicy, onThread }) {
    await this.request("initialize", {
      clientInfo: { name: "agy_codex_bridge_direct", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
    const config = { sandbox, approvalPolicy };
    const response = threadId
      ? await this.request("thread/resume", { threadId, excludeTurns: true, ...config })
      : await this.request("thread/start", { cwd: this.cwd, ...config });
    this.threadId = response.thread?.id;
    if (!this.threadId || (threadId && this.threadId !== threadId)) throw new Error("Codex 返回了无效的执行线程。");
    onThread(this.threadId);
    this.turnRequested = true;
    const started = await this.request("turn/start", {
      threadId: this.threadId, input: textInput(message), clientUserMessageId: taskId,
    });
    if (!started.turn?.id || (this.turnId && this.turnId !== started.turn.id)) throw new Error("Codex 返回了无效的执行回合。");
    this.turnId = started.turn.id;
    return this.turnId;
  }

  receive(message) {
    const { id, method, params = {}, result, error } = message;
    if (!method) {
      const request = this.requests.get(id);
      if (!request) return;
      if (error) request.reject(Object.assign(new Error(error.message), { code: error.code, method: request.method }));
      else request.resolve(result);
      return;
    }
    const ownThread = this.turnRequested && params.threadId === this.threadId;
    const turnId = params.turnId ?? params.turn?.id;
    if (ownThread && !this.turnId && method === "turn/started") this.turnId = turnId;
    if (id !== undefined) {
      if (ownThread && (!this.turnId || turnId === this.turnId) && requestTypes.has(method) && !this.completed) {
        this.turnId ??= turnId;
        this.addApproval(id, method, params);
      } else {
        this.send({ id, error: { code: -32601, message: "This bridge does not handle this server request." } });
      }
      return;
    }
    if (!ownThread) return;
    if (method === "serverRequest/resolved") {
      const request = this.pending.get(params.requestId);
      if (request) {
        this.pending.delete(params.requestId);
        request.resolve(true);
        this.onApprovalsChanged(this.approvals);
      }
      return;
    }
    if (!this.turnId || this.turnId !== turnId) return;
    const item = params.item;
    if (method === "item/started" && toolTypes.has(item?.type)) this.tools.set(item.id, item);
    if (method === "item/completed") {
      if (item?.type === "agentMessage" && item.phase === "final_answer") this.final = item.text;
      if (toolTypes.has(item?.type)) this.tools.delete(item.id);
      if (item?.type === "commandExecution" && this.toolResults.length < 10) {
        this.toolResults.push({
          command: excerpt(item.command ?? "", 500), status: item.status, exit_code: item.exitCode,
          output: excerpt(item.aggregatedOutput ?? "", 1000),
        });
      }
      if (this.completed && !this.tools.size) this.finish();
    }
    if (method === "turn/completed" && !this.completed) {
      this.completed = params.turn;
      if (this.completed.status === "completed" && this.tools.size) {
        this.settle = setTimeout(() => this.finish(), 4000);
      } else {
        this.finish();
      }
    }
  }

  finish() {
    clearTimeout(this.settle);
    const turn = this.completed;
    const final = this.final ?? finalMessage({ items: turn.items ?? [] })?.text;
    this.resolveDone({ turn, final, toolResults: this.toolResults, unsettledTools: this.tools.size });
  }

  addApproval(id, method, params) {
    const type = requestTypes.get(method);
    const choices = params.availableDecisions ?? decisions;
    const available = type === "user_input" ? ["answer"]
      : type === "permissions" ? ["accept", "decline"]
        : decisions.filter(decision => choices.includes(decision));
    const changes = this.tools.get(params.itemId)?.changes;
    const summary = {
      request_id: id, type, method, item_id: params.itemId, directory: params.cwd ?? this.cwd,
      reason: params.reason ?? null, available_decisions: available,
      ...(type === "command" && {
        command: params.command ?? null, network: params.networkApprovalContext ?? null,
        additional_permissions: params.additionalPermissions ?? null,
      }),
      ...(type === "file_change" && {
        grant_root: params.grantRoot ?? null,
        changes: changes?.slice(0, 30).map(({ path, kind, diff }) => ({ path, kind, diff: excerpt(diff ?? "", 800) })) ?? [],
        changes_truncated: (changes?.length ?? 0) > 30 || changes?.some(({ diff }) => diff?.length > 800) || false,
      }),
      ...(type === "permissions" && { permissions: params.permissions }),
      ...(type === "user_input" && { questions: params.questions }),
    };
    const request = { summary };
    request.resolved = new Promise(resolve => { request.resolve = resolve; });
    this.pending.set(id, request);
    this.onApprovalsChanged(this.approvals);
  }

  get approvals() {
    return [...this.pending.values()].map(({ summary }) => summary);
  }

  async approve(id, decision, answers) {
    const request = this.pending.get(id);
    if (!request || request.sent) throw new Error("这项请求已解决或正在提交答复，请查询工单状态。");
    const { type, available_decisions: available, permissions, questions } = request.summary;
    if (!available.includes(decision)) throw new Error("该审批请求不支持这个决定。");
    let result = { decision };
    if (type === "permissions") {
      result = { permissions: decision === "accept" ? permissions : {}, scope: "turn" };
    } else if (type === "user_input") {
      const ids = new Set(questions.map(question => question.id));
      if (!answers || Object.keys(answers).length !== ids.size ||
        Object.entries(answers).some(([key, values]) => !ids.has(key) || !values.length)) {
        throw new Error("请按问题 ID 提供每一道问题的答案。");
      }
      result = { answers: Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, { answers: values }])) };
    }
    this.send({ id, result });
    request.sent = true;
    const confirmed = await withTimeout(request.resolved, 5000, "答复已发送，但 Codex 尚未确认。请查询原工单，避免重复审批。");
    if (!confirmed) throw new Error("审批连接已关闭，未收到 Codex 的确认。");
  }

  steer(text) {
    return this.request("turn/steer", {
      threadId: this.threadId, expectedTurnId: this.turnId, input: textInput(text),
    });
  }

  interrupt() {
    return this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
  }

  async stop() {
    if (this.turnId && !this.completed && !this.closing && !this.connectionError) {
      try {
        await withTimeout(this.interrupt(), 500, "Codex 中断确认超时。");
        await withTimeout(this.done, 250);
      } catch {
        // Shutdown still closes the connection when interruption cannot be confirmed.
      }
    }
    await this.close(750);
  }

  close(grace = 1500) {
    if (!this.closing) {
      this.child.stdin.end();
      this.closing = withTimeout(this.exited, grace, "Codex 执行进程未退出。").catch(async () => {
        this.child.kill();
        await this.exited;
      });
    }
    return this.closing;
  }
}
