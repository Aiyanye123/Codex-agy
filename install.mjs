import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const script = fileURLToPath(import.meta.url);
const root = path.dirname(script);
const warningFlag = "--disable-warning=ExperimentalWarning";
const toolNames = ["bind", "unbind", "submit", "steer", "interrupt", "approve", "resume_draft", "dismiss",
  "list_tasks", "recent_replies", "status", "watch"];
const windows = process.platform === "win32";
const usage = `Usage: node install.mjs [--global | --workspace <path>]
                        [--state-directory <path>] [--default-mode <desktop|direct>]`;

function options(argv) {
  const { values } = parseArgs({ args: argv, options: {
    global: { type: "boolean" }, workspace: { type: "string" },
    "state-directory": { type: "string" }, "default-mode": { type: "string" }, help: { type: "boolean" },
  } });
  const { global, workspace, "state-directory": stateDirectory, "default-mode": mode, help } = values;
  if (global && workspace !== undefined) throw new Error("--global cannot be combined with --workspace.");
  if (mode !== undefined && !["desktop", "direct"].includes(mode)) throw new Error("--default-mode must be desktop or direct.");
  if (workspace === "" || stateDirectory === "") throw new Error("Workspace and state directory paths must be nonempty.");
  return { global, workspace, stateDirectory, mode: mode ?? "desktop", help };
}

function readText(file) {
  try {
    const info = lstatSync(file);
    if (!info.isFile()) throw new Error(`Expected a regular file at ${file}.`);
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(file, previous) {
  if (previous === undefined) return {};
  let value;
  try { value = JSON.parse(previous.replace(/^\uFEFF/, "")); }
  catch { throw new Error(`Invalid JSON in ${file}.`); }
  if (!object(value)) throw new Error(`Expected a JSON object in ${file}.`);
  return value;
}

function fingerprint(text) {
  return createHash("sha512").update(text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n"), "utf8").digest("hex");
}

function samePath(first, second) {
  if (!path.isAbsolute(first)) return false;
  if (path.resolve(first) === path.resolve(second)) return true;
  try { return realpathSync.native(first) === realpathSync.native(second); }
  catch { return false; }
}

function findApplication(name) {
  const executable = windows ? `${name}.exe` : name;
  let shim = false;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const entry = windows ? directory.replace(/^"(.*)"$/, "$1") : directory;
    if (!entry || !path.isAbsolute(entry)) continue;
    const file = path.join(entry, executable);
    try {
      if (statSync(file, { throwIfNoEntry: false })?.isFile()) {
        accessSync(file, constants.X_OK);
        return file;
      }
      if (windows && !shim) {
        shim = [".cmd", ".bat"].some(ext => statSync(path.join(entry, name + ext), { throwIfNoEntry: false })?.isFile());
      }
    } catch { continue; }
  }
  if (shim) throw new Error(`Only a .cmd/.bat shim for ${name} was found on PATH. Install the native ${executable} and check PATH.`);
  throw new Error(`Cannot find ${executable} on PATH. Install it and check PATH.`);
}

function probe(command, args) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
}

function agentPathKey(file) {
  const resolved = path.resolve(file);
  return fingerprint(windows ? resolved.toUpperCase() : resolved);
}

function planAgent(configRoot, stateRoot, previousStateRoot) {
  const flat = path.join(configRoot, "agents/agydex.md");
  const flatFile = readText(flat);
  const file = flatFile === undefined ? path.join(configRoot, "agents/agydex/agent.md") : flat;
  const previous = file === flat ? flatFile : readText(file);
  const text = readText(path.join(root, "src/agent.md"));
  if (text === undefined) throw new Error("Bridge file missing: src/agent.md");
  const hash = fingerprint(text);
  const targetKey = agentPathKey(file);
  const receiptPath = directory => path.join(directory, "managed-agents", `${targetKey}.sha512`);
  const receipt = receiptPath(stateRoot);
  const receiptHash = readText(receipt)?.trim();
  const installedHash = previous === undefined ? null : fingerprint(previous);
  if (installedHash && installedHash !== hash && installedHash !== receiptHash) {
    const prior = previousStateRoot && previousStateRoot !== stateRoot ? readText(receiptPath(previousStateRoot))?.trim() : null;
    if (installedHash !== prior) {
      throw new Error(`Custom coordinator preserved at ${file}. Restore its managed version or merge it with src/agent.md before retrying.`);
    }
  }
  return [
    ...(installedHash !== hash ? [{ file, text }] : []),
    ...(receiptHash !== hash ? [{ file: receipt, text: hash }] : []),
  ];
}

function isManagedServer(entry, server) {
  if (!object(entry) || typeof entry.command !== "string" || !Array.isArray(entry.args)
    || entry.args.some(arg => typeof arg !== "string")) return false;
  const name = path.basename(entry.command);
  return (entry.command === process.execPath || (windows ? /^node(?:\.exe)?$/i.test(name) : ["node", "nodejs"].includes(name)))
    && (entry.args.length === 5 || (entry.args.length === 6 && ["desktop", "direct"].includes(entry.args[5])))
    && entry.args[0] === warningFlag && samePath(entry.args[1], server)
    && !["url", "serverUrl", "httpUrl"].some(key => Object.hasOwn(entry, key))
    && (!Object.hasOwn(entry, "type") || entry.type === "stdio");
}

function stateRootFrom(entry) {
  const file = entry?.args[3];
  return file && path.isAbsolute(file) && path.basename(file) === "bridge.sqlite" ? path.dirname(path.resolve(file)) : null;
}

async function install(argv) {
  const { global, workspace, stateDirectory, mode, help } = options(argv);
  if (help) { process.stdout.write(usage + "\n"); return; }
  try { await import("node:sqlite"); }
  catch { throw new Error("Use Node.js 22.13+ or 24 LTS with node:sqlite support."); }

  const node = process.execPath;
  const project = global ? "." : path.resolve(workspace ?? process.cwd());
  if (!global && !statSync(project, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Workspace must be a directory: ${project}`);
  const configRoot = global ? path.join(homedir(), ".gemini/config") : path.join(project, ".agents");
  const server = path.join(root, "mcp.cjs");
  if (!statSync(server, { throwIfNoEntry: false })?.isFile()) throw new Error(`Bridge file missing: ${server}`);
  let stateRoot = stateDirectory === undefined ? path.join(root, ".state") : path.resolve(stateDirectory);
  const writes = [];

  const mcpPath = path.join(configRoot, "mcp_config.json");
  const config = readJson(mcpPath, readText(mcpPath));
  if (!Object.hasOwn(config, "mcpServers")) config.mcpServers = {};
  if (!object(config.mcpServers)) throw new Error(`Expected an mcpServers object in ${mcpPath}.`);
  const entry = config.mcpServers.codex_bridge;
  if (Object.hasOwn(config.mcpServers, "codex_bridge") && !isManagedServer(entry, server)) {
    throw new Error(`Conflicting codex_bridge preserved in ${mcpPath}. Its launch command does not match this bridge installation.`);
  }
  const previousStateRoot = stateRootFrom(entry);
  if (entry && stateDirectory === undefined) {
    if (!previousStateRoot) throw new Error(`Cannot determine the existing bridge state directory in ${mcpPath}. Specify --state-directory.`);
    stateRoot = previousStateRoot;
  }

  const agy = findApplication("agy");
  const codex = findApplication("codex");
  if (probe(agy, ["--version"]).status !== 0) throw new Error("Antigravity version check failed: agy --version.");
  const queue = probe(codex, ["queue", "--help"]);
  const queueHelp = `${queue.stdout}\n${queue.stderr}`;
  if (queue.status !== 0 || !/(?:^|\s)--thread(?=\s|=|$)/.test(queueHelp) || !/(?:^|\s)--message(?=\s|=|$)/.test(queueHelp)) {
    throw new Error("Update Codex CLI: codex queue --help must support --thread and --message.");
  }
  if (probe(codex, ["app-server", "--help"]).status !== 0) throw new Error("Update Codex CLI: codex app-server --help failed.");

  const args = [warningFlag, server, project, path.join(stateRoot, "bridge.sqlite"), codex];
  if (mode === "direct") args.push(mode);
  const tools = Object.fromEntries(toolNames.map(name => [name, { eager: true, ...(name === "watch" && { background: "always" }) }]));
  const desired = { ...entry, command: node, args, timeoutSeconds: 3700, tools };
  if (!isDeepStrictEqual(entry, desired)) {
    config.mcpServers.codex_bridge = desired;
    writes.push({ file: mcpPath, text: JSON.stringify(config, null, 2) + "\n" });
  }
  writes.push(...planAgent(configRoot, stateRoot, previousStateRoot));

  const stateDirectoryInfo = statSync(stateRoot, { throwIfNoEntry: false });
  if (stateDirectoryInfo && !stateDirectoryInfo.isDirectory()) throw new Error(`State directory must be a directory: ${stateRoot}`);
  for (const { file, text } of writes) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
  }

  process.stdout.write(`Configured Antigravity ${global ? "for this user" : `in ${project}`} with default mode ${mode}.\n`);
  process.stdout.write("Start Antigravity in your working directory: agy --agent agydex\n");
  process.stdout.write(`Bridge state directory: ${stateRoot}\n`);
}

if (process.argv[1] && samePath(path.resolve(process.argv[1]), script)) {
  install(process.argv.slice(2)).catch(error => {
    process.stderr.write(`AGY Codex Bridge: ${error.message}\n`);
    process.exitCode = 1;
  });
}
