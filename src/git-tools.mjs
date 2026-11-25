import { execFile } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import core from "../core.cjs";

const { workspacePath } = core;
const exec = promisify(execFile);
const windows = process.platform === "win32";
const outputBytes = 16 * 1024;
const outputLines = 240;
const activeStates = ["awaiting_send", "dispatching", "queued", "dispatch_unknown", "running",
  "waiting_approval", "waiting_user_input"];
const inspectOptions = {
  status: [], diff: ["staged", "stat", "base", "target", "paths", "context_lines"],
  log: ["limit", "ref", "paths", "stat"], show: ["ref", "stat", "paths"],
  branches: [], worktrees: [], stash_list: [],
};
const writeOptions = {
  stage: ["paths", "all"], unstage: ["paths", "all"], commit: ["message"],
  create_branch: ["branch", "start_point"], switch_branch: ["branch"],
  fetch: ["remote", "branch"], pull_ff: ["remote", "branch"], merge_ff: ["ref"],
  stash_push: ["message", "include_untracked", "paths"], stash_pop: ["stash_ref"],
  push: ["remote", "branch", "set_upstream"],
};
export const gitInspectActions = Object.keys(inspectOptions);
export const gitWriteActions = Object.keys(writeOptions);

function within(directory, path) {
  const from = relative(directory, path);
  return !isAbsolute(from) && from !== ".." && !from.startsWith(`..${sep}`);
}

function findGit(workspace) {
  let boundary = workspace;
  for (let directory = workspace; ; directory = dirname(directory)) {
    if (lstatSync(join(directory, ".git"), { throwIfNoEntry: false })) {
      boundary = directory;
      break;
    }
    if (dirname(directory) === directory) break;
  }
  const name = windows ? "git.exe" : "git";
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(directory) || within(boundary, directory)) continue;
    const candidate = join(directory, name);
    if (!lstatSync(candidate, { throwIfNoEntry: false })) continue;
    const executable = realpathSync.native(candidate);
    if (!within(boundary, executable) && lstatSync(executable).isFile()) return executable;
  }
  throw new Error("找不到工作区外的 Git，请将 git 加入 PATH。");
}

function boundOutput(bytes, truncated = false) {
  const decoder = new StringDecoder("utf8");
  const prefix = bytes.subarray(0, outputBytes);
  const lines = decoder.write(prefix).replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return { output: lines.slice(0, outputLines).join("\n"),
    truncated: truncated || bytes.length > outputBytes || lines.length > outputLines };
}

function gitRunner(workspace, signal) {
  const executable = findGit(workspace);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:GIT_|GCM_INTERACTIVE$|LC_ALL$|SSH_ASKPASS_REQUIRE$)/i.test(key)));
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", SSH_ASKPASS_REQUIRE: "never",
    GIT_ALLOW_PROTOCOL: "file:https:http:ssh:git", LC_ALL: "C" });
  const noHooks = windows ? "NUL" : "/dev/null";
  const flags = ["--no-pager", "--literal-pathspecs", "-c", `core.hooksPath=${noHooks}`, "-c", "core.fsmonitor=false",
    "-c", "core.askPass=", "-c", "maintenance.auto=false", "-c", "log.showSignature=false",
    "-c", "submodule.recurse=false", "-c", "color.ui=false", "-c", "core.quotePath=false"];
  return async (cwd, args, { write = false, inspect = false, allow = [] } = {}) => {
    signal?.throwIfAborted();
    // Do not launch a Git executable from a parent of a nested Antigravity workspace.
    if (within(cwd, executable)) throw new Error("不能执行 Git 工作树内的 git。");
    try {
      const { stdout, stderr } = await exec(executable, [...flags, ...args], {
        cwd, signal, shell: false, windowsHide: true, encoding: "buffer", timeout: write ? 60_000 : 10_000,
        maxBuffer: inspect ? 48 * 1024 : 1024 * 1024,
        env: write ? env : { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
      });
      if (inspect) return boundOutput(stdout);
      if (write) return boundOutput(Buffer.concat([stdout, stderr]));
      return stdout.toString("utf8").replace(/\r?\n$/, "");
    } catch (error) {
      signal?.throwIfAborted();
      if (allow.includes(error.code)) return null;
      if (inspect && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && error.stdout?.length) {
        return boundOutput(error.stdout, true);
      }
      const detail = error.stderr?.toString().trim() || error.stdout?.toString().trim();
      if (error.killed) throw new Error("Git 命令超时，请检查当前 Git 状态。", { cause: error });
      throw new Error(detail?.slice(0, 1800) || "Git 命令未完成。", { cause: error });
    }
  };
}

async function gitRoot(git, directory) {
  try {
    return workspacePath(await git(directory, ["rev-parse", "--show-toplevel"]));
  } catch (error) {
    if (/not a git repository|this operation must be run in a work tree/i.test(error.message)) return null;
    throw error;
  }
}

async function requireRoot(git, workspace) {
  const root = await gitRoot(git, workspace);
  if (!root || !within(root, workspace)) throw new Error("当前工作区不在 Git 工作树内。");
  return root;
}

function validateOptions(options, accepted) {
  if (!Object.hasOwn(accepted, options.action)) throw new Error("不支持此 Git 操作。");
  for (const key of Object.keys(options)) {
    if (key !== "action" && options[key] !== undefined && !accepted[options.action].includes(key)) {
      throw new Error(`${options.action} 不支持参数 ${key}。`);
    }
  }
}

function isGitPath(part) {
  return part.toLowerCase() === ".git";
}

function invalidWindowsPart(part) {
  return /[. ]$|[<>"|?*]/u.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part);
}

function pathspec(workspace, root, value) {
  const path = value.replaceAll("\\", "/");
  const parts = path.split("/").filter(part => part && part !== ".");
  if (path.startsWith("/") || path.startsWith("-") || parts[0]?.startsWith("-") || /[:\x00-\x1f\x7f]/u.test(path) ||
      parts.some(part => part === ".." || isGitPath(part) || (windows && invalidWindowsPart(part)))) {
    throw new Error("paths 必须是工作区内的字面相对路径，且不能以 - 开头或指向 Git 元数据。");
  }
  let current = workspace;
  for (const part of parts) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error("paths 不能穿过符号链接或目录联接。");
    const canonical = realpathSync.native(current);
    if (!within(workspace, canonical) || relative(workspace, canonical).split(sep).some(isGitPath)) {
      throw new Error("paths 超出工作区或指向 Git 元数据。");
    }
  }
  return relative(root, join(workspace, ...parts)).split(sep).join("/") || ".";
}

function scopePaths(workspace, root, paths) {
  if (paths) return paths.map(path => pathspec(workspace, root, path));
  if (relative(root, workspace)) return [pathspec(workspace, root, ".")];
  return [];
}

function assertNoWorktreeLinks(root, paths) {
  if (!windows) return;
  // Git for Windows treats directory junctions as directories during traversal and checkout.
  const pending = (paths.length ? paths : ["."]).map(path => join(root, path));
  while (pending.length) {
    const path = pending.pop();
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) {
      throw new Error(`Git 操作范围含符号链接或目录联接 ${relative(root, path)}。请缩小操作范围。`);
    }
    if (!info?.isDirectory()) continue;
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (!isGitPath(item.name) && (item.isDirectory() || item.isSymbolicLink())) pending.push(join(path, item.name));
    }
  }
}

function requireName(value, field) {
  if (!value || /^[-+:]/u.test(value) || /[\s:\x00-\x1f\x7f]/u.test(value)) {
    throw new Error(`${field} 必须是有效名称，不能以 -、+ 或 : 开头，也不能传入 refspec。`);
  }
  return value;
}

async function commitId(git, root, value, field = "ref") {
  const ref = requireName(value, field);
  if (ref.includes("..")) throw new Error(`${field} 必须指向单个提交。`);
  const oid = await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(oid)) throw new Error(`${field} 必须指向单个提交。`);
  return oid;
}

async function branchName(git, root, value) {
  const branch = requireName(value, "branch");
  if (branch.includes("@{")) throw new Error("branch 必须是实际分支名称。");
  const checked = await git(root, ["check-ref-format", "--branch", branch]);
  if (checked !== branch) throw new Error("branch 必须是实际分支名称。");
  return branch;
}

async function remoteName(git, root, value) {
  const remote = requireName(value, "remote");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(remote) ||
      !(await git(root, ["remote"])).split(/\r?\n/u).includes(remote)) {
    throw new Error("remote 必须是已配置的远程名称。");
  }
  if (await git(root, ["config", "--get-all", `remotes.${remote}`], { allow: [1] })) {
    throw new Error("remote 必须指向单个远程，不能使用同名远程组。");
  }
  return remote;
}

const diffOptions = ["--no-ext-diff", "--no-textconv", "--submodule=short", "--ignore-submodules=dirty"];

export async function inspectGit(workspace, options, signal) {
  validateOptions(options, inspectOptions);
  const git = gitRunner(workspace, signal);
  const root = await requireRoot(git, workspace);
  const paths = scopePaths(workspace, root, options.paths);
  let args;
  switch (options.action) {
    case "status":
      assertNoWorktreeLinks(root, paths);
      args = ["status", "--porcelain=v2", "--branch", "--ahead-behind", "--untracked-files=normal", "--ignore-submodules=dirty", "--", ...paths];
      break;
    case "diff": {
      const { base, target, staged, stat, context_lines: context = 3 } = options;
      if (target && (!base || staged)) throw new Error("target 需要 base，且不能用于 staged 差异。");
      const commits = [];
      if (base) commits.push(await commitId(git, root, base, "base"));
      if (target) commits.push(await commitId(git, root, target, "target"));
      if (!target && !staged) assertNoWorktreeLinks(root, paths);
      args = ["diff", ...diffOptions, stat ? "--stat" : `--unified=${context}`];
      if (staged) args.push("--cached");
      args.push(...commits, "--", ...paths);
      break;
    }
    case "log": {
      const commits = options.ref ? [await commitId(git, root, options.ref)] : [];
      args = ["log", ...diffOptions, "--no-notes", "--date=short", "--format=%h %ad %s", `--max-count=${options.limit ?? 10}`];
      if (options.stat) args.push("--stat");
      args.push(...commits, "--", ...paths);
      break;
    }
    case "show": {
      const commit = await commitId(git, root, options.ref ?? "HEAD");
      args = ["show", ...diffOptions, "--no-notes", "--format=medium", options.stat ? "--stat" : "--patch", commit, "--", ...paths];
      break;
    }
    case "branches": args = ["branch", "--list", "--all", "--no-column"]; break;
    case "worktrees": args = ["worktree", "list", "--porcelain"]; break;
    case "stash_list": args = ["stash", "list", "--format=%gd %gs"]; break;
  }
  return { root, ...await git(root, args, { inspect: true }) };
}

async function assertIdleWorkspace(database, git, root) {
  const placeholders = activeStates.map(() => "?").join(", ");
  const tasks = database.prepare(`SELECT id, state, workspace FROM tasks WHERE state IN (${placeholders})`).all(...activeStates);
  const roots = new Map();
  for (const task of tasks) {
    let directory;
    try { directory = workspacePath(task.workspace); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      throw error;
    }
    if (!roots.has(directory)) roots.set(directory, relative(root, directory) ? await gitRoot(git, directory) : root);
    const taskRoot = roots.get(directory);
    if (taskRoot && !relative(root, taskRoot)) {
      throw new Error(`当前 Git 工作树有进行中的工单 ${task.id}（${task.state}）。请等待工单结束后再写入。`);
    }
  }
}

function stagePaths(workspace, root, { paths, all }) {
  if (paths && all) throw new Error("请在 paths 和 all: true 中选一项。");
  if (!paths && all !== true) throw new Error("请指定 paths，或显式传 all: true。");
  return (paths ?? ["."]).map(path => pathspec(workspace, root, path));
}

async function currentBranch(git, root) {
  const ref = await git(root, ["symbolic-ref", "--quiet", "HEAD"], { allow: [1] });
  if (!ref?.startsWith("refs/heads/")) throw new Error("当前是分离的 HEAD，请指定分支或先切换分支。");
  return ref.slice("refs/heads/".length);
}

async function pullDestination(git, root, options) {
  const current = await currentBranch(git, root);
  const upstream = await git(root, ["config", "--get", `branch.${current}.remote`], { allow: [1] });
  const remote = await remoteName(git, root, options.remote ?? upstream ?? "origin");
  let name = options.branch;
  if (name === undefined && remote === upstream) {
    const merge = await git(root, ["config", "--get-all", `branch.${current}.merge`], { allow: [1] });
    if (merge?.startsWith("refs/heads/") && !merge.includes("\n")) name = merge.slice("refs/heads/".length);
    else throw new Error("上游没有唯一的远程分支，请指定 branch。");
  }
  if (name === undefined && options.remote === undefined) throw new Error("当前分支没有上游，请指定 remote 和 branch。");
  return { current, remote, branch: await branchName(git, root, name ?? current) };
}

const fetchOptions = ["--refmap=", "--no-tags", "--no-prune", "--no-recurse-submodules", "--upload-pack=git-upload-pack"];
const trackingRef = (remote, branch) => `refs/heads/${branch}:refs/remotes/${remote}/${branch}`;

async function writeCommand(git, workspace, root, options) {
  switch (options.action) {
    case "stage": return ["add", "-A", "--", ...stagePaths(workspace, root, options)];
    case "unstage": return ["reset", "--quiet", "--", ...stagePaths(workspace, root, options)];
    case "commit": {
      if (!options.message?.trim()) throw new Error("commit 需要非空 message。");
      const diff = await git(root, ["diff", "--cached", "--quiet", ...diffOptions, "--"], { allow: [1] });
      if (diff !== null) throw new Error("没有暂存内容可提交。");
      return ["commit", "--no-gpg-sign", `--message=${options.message}`];
    }
    case "create_branch": {
      const branch = await branchName(git, root, options.branch);
      const args = ["switch", "--no-guess", "--no-overwrite-ignore", "--no-track", "-c", branch];
      if (options.start_point !== undefined) args.push("--", await commitId(git, root, options.start_point, "start_point"));
      return args;
    }
    case "switch_branch": {
      const branch = await branchName(git, root, options.branch);
      return ["switch", "--no-guess", "--no-overwrite-ignore", "--", branch];
    }
    case "fetch": {
      const remote = await remoteName(git, root, options.remote ?? "origin");
      const branch = options.branch === undefined ? "*" : await branchName(git, root, options.branch);
      return ["fetch", "--atomic", "--no-prune-tags", ...fetchOptions, "--", remote, trackingRef(remote, branch)];
    }
    case "pull_ff": {
      const { current, remote, branch } = await pullDestination(git, root, options);
      return ["-c", `branch.${current}.mergeOptions=--no-overwrite-ignore`, "pull", "--ff-only", "--no-rebase", "--no-autostash",
        ...fetchOptions, "--", remote, trackingRef(remote, branch)];
    }
    case "merge_ff": {
      const commit = await commitId(git, root, options.ref);
      return ["merge", "--ff-only", "--no-autostash", "--no-squash", "--no-edit", "--no-overwrite-ignore", "--", commit];
    }
    case "stash_push": {
      const args = ["stash", "push"];
      if (options.include_untracked) args.push("--include-untracked");
      if (options.message !== undefined) args.push(`--message=${options.message}`);
      return [...args, "--", ...scopePaths(workspace, root, options.paths)];
    }
    case "stash_pop": {
      if (options.stash_ref !== undefined && !/^stash@\{\d+\}$/u.test(options.stash_ref)) {
        throw new Error("stash_ref 只支持 stash@{N} 格式。");
      }
      return ["stash", "pop", "--", options.stash_ref ?? "stash@{0}"];
    }
    case "push": {
      const branch = await branchName(git, root, options.branch ?? await currentBranch(git, root));
      const remote = await remoteName(git, root, options.remote ?? "origin");
      const args = ["-c", `remote.${remote}.mirror=false`, "push", "--porcelain", "--no-follow-tags", "--no-prune",
        "--recurse-submodules=no", "--receive-pack=git-receive-pack"];
      if (options.set_upstream) args.push("--set-upstream");
      return [...args, "--", remote, `refs/heads/${branch}:refs/heads/${branch}`];
    }
  }
}

export async function actOnGit(workspace, database, options, signal) {
  validateOptions(options, writeOptions);
  const git = gitRunner(workspace, signal);
  const root = await requireRoot(git, workspace);
  const args = await writeCommand(git, workspace, root, options);
  switch (options.action) {
    case "stage":
    case "stash_push":
      assertNoWorktreeLinks(root, args.slice(args.indexOf("--") + 1));
      break;
    case "create_branch":
    case "switch_branch":
    case "pull_ff":
    case "merge_ff":
    case "stash_pop":
      assertNoWorktreeLinks(root, []);
      break;
  }
  await assertIdleWorkspace(database, git, root);
  return { root, ...await git(root, args, { write: true }) };
}
