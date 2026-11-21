import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { delimiter as pathSeparator, isAbsolute, join, posix, relative, sep } from "node:path";

const outputLimit = 14_000;
const timeoutMs = 5000;
const excluded = [
  "**/{.git,node_modules,.state}", "**/{.env,.env.*,id_rsa,id_dsa,id_ecdsa,id_ed25519}",
  "**/*.{pem,key,p12,pfx}", "**/{auth.json,credentials.json}", "**/.agents/**/mcp_config.json",
  "**/{package-lock.json,pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb,Cargo.lock,uv.lock,poetry.lock,Pipfile.lock,composer.lock,Gemfile.lock,flake.lock}",
];

function resolveRipgrep(workspace) {
  const name = process.platform === "win32" ? "rg.exe" : "rg";
  const directories = (process.env.PATH ?? "").split(pathSeparator);
  for (const entry of directories) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (!existsSync(candidate)) continue;
    const executable = realpathSync.native(candidate);
    const fromWorkspace = relative(workspace, executable);
    if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) {
      return executable;
    }
  }
  throw new Error("找不到工作区外的 rg。请将 ripgrep 加入 PATH。");
}

function searchScope(workspace, requested = ".") {
  const normalized = requested.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(part => part && part !== ".");
  if (normalized.startsWith("/") || normalized.includes(":") || parts.includes("..") ||
      (process.platform === "win32" && parts.some(part => /[. ]$/.test(part)))) {
    throw new Error("path 必须是工作区内的相对路径，不能包含上级目录。");
  }
  let current = workspace;
  for (const part of parts) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) throw new Error("指定的工作区路径不存在。");
    if (info.isSymbolicLink()) throw new Error("不能通过链接指定检索范围。");
  }
  return parts.join("/");
}

export function searchWorkspace(workspace, options, signal) {
  const { mode, query, glob, case_sensitive: caseSensitive, whole_word: wholeWord, regex,
    context_lines: contextLines = 0, per_file: perFile = 3 } = options;
  const files = mode === "files";
  if (!files && !query) throw new Error("搜索文档或代码时请提供关键词。");
  if (files && (regex || wholeWord || contextLines)) throw new Error("文件名模式使用路径片段和 glob 过滤。");
  const limit = options.limit ?? (files ? 40 : 16);
  if (!files && limit > 40) throw new Error("内容检索最多允许 40 条结果。");
  const scope = searchScope(workspace, options.path);
  const foldCase = value => caseSensitive ? value : value.toLowerCase();
  const filenameQuery = files ? foldCase(query?.replaceAll("\\", "/") ?? "") : "";
  const globPattern = glob?.replaceAll("\\", "/");
  const comparablePath = value => process.platform === "win32" ? value.toLowerCase() : value;
  const prefix = comparablePath(scope);
  const acceptsPath = file => {
    const comparable = comparablePath(file);
    if (prefix && comparable !== prefix && !comparable.startsWith(`${prefix}/`)) return false;
    const scoped = prefix && comparable.startsWith(`${prefix}/`) ? file.slice(scope.length + 1) : file;
    return !globPattern || posix.matchesGlob(globPattern.includes("/") ? scoped : posix.basename(scoped), globPattern);
  };
  // Walk from the root even for an explicit path. Passing a file directly to rg can bypass ignore rules.
  const args = ["--no-config", "--no-follow", "--no-ignore-parent", "--no-ignore-global",
    "--no-require-git", "--color=never", "--hidden", ...excluded.map(pattern => `--iglob=!${pattern}`)];
  if (files) {
    args.push("--files", "--null", "--", ".");
  } else {
    if (mode !== "text") {
      args.push("--type-add=bridgedoc:*.{md,markdown,txt,rst,adoc,org}", mode === "docs" ? "--type=bridgedoc" : "--type-not=bridgedoc");
    }
    args.push("--json", "--engine=default", "--max-filesize=2M", `--max-count=${perFile}`,
      `--context=${contextLines}`, caseSensitive ? "--case-sensitive" : "--ignore-case");
    if (!regex) args.push("--fixed-strings");
    if (wholeWord) args.push("--word-regexp");
    args.push(`--regexp=${query}`, "--", ".");
  }

  const executable = resolveRipgrep(workspace);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: workspace, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal,
    });
    const matches = [];
    const delimiter = files ? "\0" : "\n";
    let pending = "";
    let diagnostic = "";
    let limited = false;
    let previous = [];
    let recentMatches = [];
    const timeout = setTimeout(() => {
      stopReading();
      reject(new Error("工作区检索超时。请缩小关键词范围，或把定位工作交给 Codex。"));
    }, timeoutMs);

    function stopReading() {
      child.stdout.destroy();
      child.kill();
    }

    function finish(truncated) {
      while (JSON.stringify(matches).length > outputLimit) {
        matches.pop();
        truncated = true;
      }
      resolve({ matches, truncated });
    }

    function collect(record) {
      if (!record) return;
      if (files) {
        const path = record.replaceAll("\\", "/").replace(/^\.\//, "");
        if (acceptsPath(path) && foldCase(path).includes(filenameQuery)) matches.push({ path });
        return;
      }
      const { type, data } = JSON.parse(record);
      if (type === "begin") {
        previous = [];
        recentMatches = [];
      }
      if (type !== "match" && type !== "context") return;
      if (!data.path?.text || !data.lines?.text) return;
      const path = data.path.text.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!acceptsPath(path)) return;
      const hit = data.submatches?.[0]?.start ?? 0;
      const lineText = data.lines.text.replace(/\r?\n$/, "");
      const start = Math.max(0, Buffer.from(lineText).subarray(0, hit).toString().length - 100);
      const snippet = lineText.slice(start, start + 300);
      const line = { line: data.line_number,
        text: `${start ? "…" : ""}${snippet}${start + snippet.length < lineText.length ? "…" : ""}` };
      if (contextLines) {
        recentMatches = recentMatches.filter(match => line.line <= match.line + contextLines);
        for (const match of recentMatches) match.context.push(line);
      }
      if (type === "match") {
        const match = { path, ...line };
        if (contextLines) {
          match.context = previous.filter(item => item.line >= line.line - contextLines);
          recentMatches.push(match);
        }
        matches.push(match);
      }
      if (contextLines) previous = [...previous, line].slice(-contextLines);
    }

    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      const records = (pending + chunk).split(delimiter);
      pending = records.pop();
      for (const record of records) {
        try { collect(record); }
        catch (error) {
          clearTimeout(timeout);
          stopReading();
          reject(error);
          break;
        }
        if (matches.length <= limit) continue;
        matches.pop();
        limited = true;
        clearTimeout(timeout);
        stopReading();
        finish(true);
        break;
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-500); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (limited) return;
      if (code !== 0 && code !== 1) {
        reject(new Error(`工作区检索未完成（rg 退出码 ${code ?? "未知"}）。${diagnostic.trim()}`));
        return;
      }
      finish(false);
    });
  });
}
