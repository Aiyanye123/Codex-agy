import { execFile, spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync,
  readdirSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter as pathSeparator, dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { promisify } from "node:util";
import { documentOutputLimit, documentSizeLimit, officeExtensions, openDocumentZip, readOffice, searchOffice } from "./office-doc.mjs";

const outputLimit = 14_000;
const timeoutMs = 5000;
const windows = process.platform === "win32";
const excluded = [
  "**/{.git,node_modules,.state}", "**/{.env,.env.*,id_rsa,id_dsa,id_ecdsa,id_ed25519}",
  "**/*.{pem,key,p12,pfx}", "**/{auth.json,credentials.json}", "**/.agents/**/mcp_config.json",
  "**/{package-lock.json,pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb,Cargo.lock,uv.lock,poetry.lock,Pipfile.lock,composer.lock,Gemfile.lock,flake.lock}",
];

function outsideWorkspace(workspace, file) {
  const fromWorkspace = relative(workspace, file);
  return fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace);
}

function resolveSearchExecutable(workspace, command) {
  const name = windows ? `${command}.exe` : command;
  const directories = (process.env.PATH ?? "").split(pathSeparator);
  for (const entry of directories) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (!existsSync(candidate)) continue;
    const executable = realpathSync.native(candidate);
    if (outsideWorkspace(workspace, executable) && lstatSync(executable).isFile()) return executable;
  }
}

function excludedPath(file) {
  let part = file.toLowerCase();
  while (part !== ".") {
    if (excluded.some(pattern => posix.matchesGlob(part, pattern.toLowerCase()))) return true;
    part = posix.dirname(part);
  }
  return false;
}

function searchScope(workspace, requested = ".", document = false) {
  const normalized = requested.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(part => part && part !== ".");
  const invalidWindowsPart = part => /[. ]$/.test(part) ||
    (document && (/[<>"|?*]/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)));
  if (normalized.startsWith("/") || normalized.includes(":") || parts.includes("..") ||
      (windows && parts.some(invalidWindowsPart))) {
    throw new Error("path 必须是工作区内的相对路径，不能包含上级目录。");
  }
  const scope = parts.join("/");
  if (document && scope && excludedPath(scope)) throw new Error("工作区路径属于敏感文件或排除项。");
  let current = workspace;
  for (const part of parts) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) throw new Error("指定的工作区路径不存在。");
    if (info.isSymbolicLink()) throw new Error("不能通过链接指定检索范围。");
  }
  if (!document || !scope) return scope;
  const canonical = realpathSync.native(current);
  if (outsideWorkspace(workspace, canonical)) throw new Error("工作区路径超出当前目录。");
  const canonicalPath = relative(workspace, canonical).split(sep).join("/");
  if (excludedPath(canonicalPath)) throw new Error("工作区路径属于敏感文件或排除项。");
  return canonicalPath;
}

const searchFlags = ["--no-config", "--no-follow", "--no-ignore-parent", "--no-ignore-global",
  "--no-require-git", "--color=never", "--hidden", ...excluded.map(pattern => `--iglob=!${pattern}`)];
const adapterExtensions = new Set([".docx", ".pdf", ".epub", ".odt"]);
const richExtensions = new Set([...officeExtensions, ...adapterExtensions]);
const runFile = promisify(execFile);

function documentFile(workspace, path) {
  const file = join(workspace, path);
  const info = lstatSync(file);
  if (!info.isFile()) throw new Error("请指定工作区内的普通文件。");
  if (info.size > documentSizeLimit) throw new Error("文档超过 20 MB 限制。");
  return file;
}

function readDocumentBytes(file) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("请指定工作区内的普通文件。");
    if (info.size > documentSizeLimit) throw new Error("文档超过 20 MB 限制。");
    const bytes = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== info.size) throw new Error("文档在读取期间发生变化，请重试。");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

export function readDocument(workspace, options) {
  const path = searchScope(workspace, options.path, true);
  const file = documentFile(workspace, path);
  const extension = posix.extname(path).toLowerCase();
  if (extension === ".pdf") throw new Error('PDF 请用 view_file 查看，或用 search_workspace 的 rich 模式搜词。');
  if ([".doc", ".xls", ".ppt"].includes(extension)) throw new Error("旧版二进制 Office 文档请交给 Codex 读取。");
  if (!officeExtensions.has(extension)) throw new Error("read_document 支持 .docx、.xlsx 和 .pptx。");
  if (options.sheet !== undefined && extension !== ".xlsx") throw new Error("sheet 仅适用于 .xlsx。");
  const zip = openDocumentZip(readDocumentBytes(file));
  zip.validate();
  return readOffice(zip, extension, path, options);
}

function* walkDocuments(workspace, scope, deadline, signal) {
  const pending = [scope];
  while (pending.length) {
    checkSearchTime(deadline, signal);
    const path = pending.pop();
    if (path && excludedPath(path)) continue;
    const info = lstatSync(join(workspace, path), { throwIfNoEntry: false });
    if (info?.isDirectory()) {
      for (const item of readdirSync(join(workspace, path), { withFileTypes: true })) {
        if (!item.isSymbolicLink()) pending.push(posix.join(path, item.name));
      }
    } else if (info?.isFile() && richExtensions.has(posix.extname(path).toLowerCase())) yield path;
  }
}

function checkSearchTime(deadline, signal) {
  signal?.throwIfAborted();
  if (Date.now() >= deadline) throw new Error("富文档检索超时，请用 path 或 glob 缩小范围。");
}

async function listDocuments(workspace, executable, signal) {
  const types = [...richExtensions].map(extension => {
    const pattern = [...extension.slice(1)].map(char => `[${char}${char.toUpperCase()}]`).join("");
    return `--type-add=bridgerich:*.${pattern}`;
  });
  try {
    const { stdout } = await runFile(executable,
      [...searchFlags, ...types, "--type=bridgerich", "--files", "--null", "--", "."],
      { cwd: workspace, windowsHide: true, signal, timeout: timeoutMs, maxBuffer: 512 * 1024 });
    return stdout.split("\0").filter(Boolean).map(path => path.replaceAll("\\", "/").replace(/^\.\//, ""));
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 1 && !error.stderr) return [];
    throw new Error("无法列举富文档，请用 path 或 glob 缩小范围。");
  }
}

function adapterEnvironment(workspace) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(path|rga_config|rust_log|nodefaultcurrentdirectoryinexepath)$/i.test(key)));
  const directories = [];
  for (const entry of (process.env.PATH ?? "").split(pathSeparator)) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(directory) || !existsSync(directory)) continue;
    const canonical = realpathSync.native(directory);
    if (!outsideWorkspace(workspace, canonical)) continue;
    const containsWorkspaceExecutable = ["rg", "pandoc", "pdftotext"].some(command => {
      const name = windows ? `${command}.exe` : command;
      const file = join(canonical, name);
      return existsSync(file) && !outsideWorkspace(workspace, realpathSync.native(file));
    });
    if (!containsWorkspaceExecutable) directories.push(canonical);
  }
  env.PATH = directories.join(pathSeparator);
  env.NoDefaultCurrentDirectoryInExePath = "1";
  return env;
}

async function searchWithRga(executable, scratch, file, options, env, deadline, signal, limit) {
  const config = join(scratch, "config.json");
  // rga 0.10.9 needs an SQLite cache handle even with caching disabled. A zero blob limit stores no text.
  const args = [`--rga-config-file=${config}`, `--rga-cache-path=${scratch}`, "--rga-cache-max-blob-len=0",
    "--rga-max-archive-recursion=3", "--rga-adapters=pandoc,poppler,postprocpagebreaks",
    "--no-config", "--no-follow", "--threads=1", "--pre-glob=*",
    "--json", "--line-number", "--fixed-strings", `--max-count=${limit}`,
    options.case_sensitive ? "--case-sensitive" : "--ignore-case", `--regexp=${options.query}`, "--", file];
  let stdout;
  try {
    const result = await runFile(executable, args, { cwd: dirname(executable), env, windowsHide: true, signal,
      timeout: Math.max(1, deadline - Date.now()), maxBuffer: 256 * 1024 });
    if (result.stderr.trim()) throw new Error("rga 文档适配器报错。");
    stdout = result.stdout;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 1 && !error.stderr?.trim()) return [];
    throw new Error("rga 无法提取文档，请检查 Pandoc 或 pdftotext 是否可用，也可用 view_file 或交 Codex 查看。");
  }
  const matches = [];
  for (const record of stdout.split("\n")) {
    if (!record) continue;
    const { type, data } = JSON.parse(record);
    if (type !== "match" || !data.lines?.text) continue;
    const line = data.lines.text.trimEnd();
    const hit = data.submatches?.[0]?.start ?? 0;
    const start = Math.max(0, Buffer.from(line).subarray(0, hit).toString().length - 100);
    matches.push({ line: data.line_number, text: `${start ? "…" : ""}${line.slice(start, start + 300)}${start + 300 < line.length ? "…" : ""}` });
  }
  return matches;
}

function acceptsSearchPath(path, scope, glob) {
  const comparable = value => windows ? value.toLowerCase() : value;
  const prefix = comparable(scope);
  const candidate = comparable(path);
  if (prefix && candidate !== prefix && !candidate.startsWith(`${prefix}/`)) return false;
  const scoped = prefix && candidate !== prefix ? path.slice(scope.length + 1) : path;
  return !glob || posix.matchesGlob(glob.includes("/") ? scoped : posix.basename(scoped), glob);
}

async function searchRich(workspace, options, signal) {
  if (options.regex || options.whole_word || options.context_lines) throw new Error("rich 支持字面搜词和大小写选项。");
  const limit = options.limit ?? 16;
  const perFile = options.per_file ?? 3;
  const scope = searchScope(workspace, options.path, true);
  const glob = options.glob?.replaceAll("\\", "/");
  const deadline = Date.now() + timeoutMs;
  const rga = resolveSearchExecutable(workspace, "rga");
  const rg = resolveSearchExecutable(workspace, "rg");
  const env = rga && adapterEnvironment(workspace);
  const paths = rg ? await listDocuments(workspace, rg, signal) : walkDocuments(workspace, scope, deadline, signal);
  const result = { matches: [], truncated: false };
  const notes = [];
  let skipped = 0;
  let adapterNeeded = false;
  let usedOfficeFallback = false;
  let scratch;
  try {
    for (const candidate of paths) {
      checkSearchTime(deadline, signal);
      if (!acceptsSearchPath(candidate, scope, glob) || excludedPath(candidate)) continue;
      try {
        const path = searchScope(workspace, candidate, true);
        if (!acceptsSearchPath(path, scope, glob)) continue;
        const extension = posix.extname(path).toLowerCase();
        if (!richExtensions.has(extension)) continue;
        const file = documentFile(workspace, path);
        if (!rga && !officeExtensions.has(extension)) {
          adapterNeeded = true;
          continue;
        }
        const zip = extension === ".pdf" ? undefined : openDocumentZip(readDocumentBytes(file));
        zip?.validate();
        let matches;
        if (rga && adapterExtensions.has(extension)) {
          try {
            if (!scratch) {
              const temp = realpathSync.native(tmpdir());
              if (!outsideWorkspace(workspace, temp)) throw new Error("rga 需要工作区外的系统临时目录。");
              scratch = mkdtempSync(join(temp, "agy-rga-"));
              writeFileSync(join(scratch, "config.json"), "{}", { flag: "wx" });
            }
            matches = await searchWithRga(rga, scratch, file, options, env, deadline, signal, perFile);
          } catch (error) {
            signal?.throwIfAborted();
            if (!officeExtensions.has(extension)) throw error;
            usedOfficeFallback = true;
          }
        }
        matches ??= searchOffice(zip, extension, options, perFile);
        for (const match of matches) {
          if (result.matches.length === limit) {
            result.truncated = true;
            break;
          }
          result.matches.push({ path, ...match });
        }
        if (result.truncated) break;
      } catch (error) {
        signal?.throwIfAborted();
        if (++skipped <= 3) notes.push(`${candidate.slice(0, 180)}：${error.message.slice(0, 240)}`);
      }
    }
  } finally {
    if (scratch && realpathSync.native(scratch) === scratch) rmSync(scratch, { recursive: true, force: true });
  }
  if (usedOfficeFallback) notes.push("rga 无法读取部分 Word 文档，已改用内置解析器。");
  if (adapterNeeded) notes.push("未找到工作区外的 rga；PDF、EPUB 和 ODT 请安装 ripgrep-all 后重试，或用 view_file 查看。");
  if (!rg) notes.push("未找到工作区外的 rg，本次使用目录扫描，未应用 Git 忽略规则。");
  if (skipped > 3) notes.push(`另有 ${skipped - 3} 个文档未能读取。`);
  if (notes.length) result.note = notes.join("\n");
  while (Buffer.byteLength(JSON.stringify(result)) > documentOutputLimit) {
    result.matches.pop();
    result.truncated = true;
  }
  return result;
}

export function searchWorkspace(workspace, options, signal) {
  const { mode, query, glob, case_sensitive: caseSensitive, whole_word: wholeWord, regex,
    context_lines: contextLines = 0, per_file: perFile = 3 } = options;
  const files = mode === "files";
  if (!files && !query) throw new Error("搜索文档或代码时请提供关键词。");
  if (files && (regex || wholeWord || contextLines)) throw new Error("文件名模式使用路径片段和 glob 过滤。");
  const limit = options.limit ?? (files ? 40 : 16);
  if (!files && limit > 40) throw new Error("内容检索最多允许 40 条结果。");
  if (mode === "rich") return searchRich(workspace, options, signal);
  const scope = searchScope(workspace, options.path);
  const foldCase = value => caseSensitive ? value : value.toLowerCase();
  const filenameQuery = files ? foldCase(query?.replaceAll("\\", "/") ?? "") : "";
  const globPattern = glob?.replaceAll("\\", "/");
  const acceptsPath = file => acceptsSearchPath(file, scope, globPattern);
  // Walk from the root even for an explicit path. Passing a file directly to rg can bypass ignore rules.
  const args = [...searchFlags];
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

  const executable = resolveSearchExecutable(workspace, "rg");
  if (!executable) throw new Error("找不到工作区外的 rg。请将 ripgrep 加入 PATH。");
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
