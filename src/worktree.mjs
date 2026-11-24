import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import core from "../core.cjs";

const run = promisify(execFile);
const { sameWorkspace, workspacePath } = core;

async function git(cwd, args) {
  const { stdout } = await run("git", args, {
    cwd, windowsHide: true, timeout: 15000, env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function repository(directory) {
  let root;
  try {
    root = workspacePath((await git(directory, ["rev-parse", "--show-toplevel"])).trimEnd());
  } catch (error) {
    if (/not a git repository/i.test(error.stderr ?? "")) return null;
    throw error;
  }
  const listing = await git(root, ["worktree", "list", "--porcelain", "-z"]);
  const trees = listing.split("\0\0").filter(Boolean).map(record => {
    const fields = record.split("\0");
    return {
      path: fields[0].slice("worktree ".length),
      branch: fields.find(field => field.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length) ?? null,
    };
  });
  return { root, repoRoot: workspacePath(trees[0].path), trees };
}

function gitError(error) {
  return error.killed ? "Git 命令超时" : (error.stderr?.trim() || error.message);
}

export async function inspectWorktree(directory) {
  try {
    const repo = await repository(directory);
    if (!repo || sameWorkspace(repo.root, repo.repoRoot)) return null;
    const tree = repo.trees.find(tree => relative(tree.path, repo.root) === "");
    if (!tree) throw new Error("Git 未列出当前工作树。");
    return { repo_root: repo.repoRoot, path: repo.root, branch: tree.branch, base_commit: null };
  } catch (error) {
    if (error.code === "ENOENT" && error.path === "git") return null;
    throw new Error(`无法检查工作树。 ${gitError(error)}`);
  }
}

export async function planWorktree(directory, id) {
  try {
    const repo = await repository(directory);
    if (!repo) throw new Error("当前工作目录不在 Git 仓库中。");
    const path = join(dirname(repo.repoRoot), `${basename(repo.repoRoot).slice(0, 40)}-agy-${id}`);
    if (repo.trees.some(tree => {
      const location = relative(tree.path, path);
      return location === "" || (!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`));
    })) throw new Error("找不到仓库工作树之外的同级位置。");
    const baseCommit = (await git(repo.root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    return { repo_root: repo.repoRoot, path, branch: `agy/${id}`, base_commit: baseCommit };
  } catch (error) {
    throw new Error(`无法准备独立 Git 工作树。 ${gitError(error)}`);
  }
}

export async function addWorktree(worktree) {
  try {
    const noHooks = process.platform === "win32" ? "NUL" : "/dev/null";
    await git(worktree.repo_root, ["-c", `core.hooksPath=${noHooks}`, "worktree", "add", "-b",
      worktree.branch, "--", worktree.path, worktree.base_commit]);
  } catch (error) {
    throw new Error(`创建 Git 工作树失败。 ${gitError(error)}`);
  }
}
