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
const hookLabel = "AGY Codex Bridge";
const hookTimeouts = { UserPromptSubmit: 10, Stop: 10, Interrupt: 3 };
const toolNames = ["bind", "unbind", "submit", "steer", "interrupt", "approve", "resume_draft", "dismiss",
  "list_tasks", "recent_replies", "status", "watch"];
const windows = process.platform === "win32";
const usage = `Usage: node install.mjs [--global | --workspace <path>] [--hooks-only]
                        [--state-directory <path>] [--default-mode <desktop|direct>]`;

function options(argv) {
  const { values } = parseArgs({ args: argv, options: {
    global: { type: "boolean" }, workspace: { type: "string" }, "hooks-only": { type: "boolean" },
    "state-directory": { type: "string" }, "default-mode": { type: "string" }, help: { type: "boolean" },
  } });
  const { global, workspace, "hooks-only": hooksOnly, "state-directory": stateDirectory, "default-mode": mode, help } = values;
  if (global && (workspace !== undefined || hooksOnly)) throw new Error("--global cannot be combined with --workspace or --hooks-only.");
  if (hooksOnly && mode !== undefined) throw new Error("--default-mode configures MCP and cannot be combined with --hooks-only.");
  if (mode !== undefined && !["desktop", "direct"].includes(mode)) throw new Error("--default-mode must be desktop or direct.");
  if (workspace === "" || stateDirectory === "") throw new Error("Workspace and state directory paths must be nonempty.");
  return { global, workspace, hooksOnly, stateDirectory, mode: mode ?? "desktop", help };
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

const psPrefix = "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ";
const psHookStart = `$encoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $encoding
[Console]::OutputEncoding = $encoding
$OutputEncoding = $encoding
$payload = [Console]::In.ReadToEnd()
$payload | & `;
const psExit = "\nexit $LASTEXITCODE";
const psQuoteChars = "'‘’‚‛";
const psQuotes = new RegExp(`[${psQuoteChars}]`, "g");
const psDoubledQuotes = new RegExp(`([${psQuoteChars}])\\1`, "g");
const psLiteral = value => `'${value.replace(psQuotes, "$&$&")}'`;
const posixLiteral = value => `'${value.replaceAll("'", "'\\''")}'`;

export function hookCommand(node, hook, state, platform = process.platform) {
  if (platform !== "win32") return `${posixLiteral(node)} ${warningFlag} ${posixLiteral(hook)} ${posixLiteral(state)}`;
  const source = `${psHookStart}${psLiteral(node)} ${warningFlag} ${psLiteral(hook)} ${psLiteral(state)}${psExit}`;
  return psPrefix + Buffer.from(source, "utf16le").toString("base64");
}

const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const posixArg = /'(?:[^']|'\\'')*'/.source;
const psArg = `'(?:[^${psQuoteChars}\\r\\n]|[${psQuoteChars}]{2})*'`;
const posixHookPattern = new RegExp(`^(${posixArg}) ${warningFlag} (${posixArg}) (${posixArg})$`);
const psHookPattern = new RegExp(`^${escapePattern(psHookStart)}(${psArg}) ${warningFlag} (${psArg}) (${psArg})(?: (${psArg}))?${escapePattern(psExit)}$`);

export function isManagedHookCommand(command, { node, hook, project, platform = process.platform }) {
  if (typeof command !== "string") return false;
  let args;
  if (platform === "win32") {
    if (!command.startsWith(psPrefix)) return false;
    const base64 = command.slice(psPrefix.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return false;
    const source = Buffer.from(base64, "base64").toString("utf16le").replaceAll("\r\n", "\n");
    const match = psHookPattern.exec(source);
    if (!match) return false;
    const unquote = value => value.slice(1, -1).replace(psDoubledQuotes, "$1");
    if (match[4] && !samePath(unquote(match[4]), project)) return false;
    args = match.slice(1, 4).map(unquote);
  } else {
    const match = posixHookPattern.exec(command);
    if (!match) return false;
    args = match.slice(1).map(value => value.slice(1, -1).replaceAll("'\\''", "'"));
    if (hookCommand(...args, platform) !== command) return false;
  }
  if (!args.every(path.isAbsolute)) return false;
  const name = path.basename(args[0]);
  return (samePath(args[0], node) || (platform === "win32" ? /^node\.exe$/i.test(name) : ["node", "nodejs"].includes(name)))
    && samePath(args[1], hook) && path.basename(args[2]) === "bridge.sqlite";
}

function planHooks(project, node, hook, state) {
  const file = path.join(project, ".codex/hooks.json");
  const config = readJson(file, readText(file));
  const original = JSON.stringify(config);
  if (!Object.hasOwn(config, "hooks")) config.hooks = {};
  if (!object(config.hooks)) throw new Error(`Expected a hooks object in ${file}.`);
  const command = hookCommand(node, hook, state);
  for (const [event, timeout] of Object.entries(hookTimeouts)) {
    if (!Object.hasOwn(config.hooks, event)) config.hooks[event] = [];
    const groups = config.hooks[event];
    if (!Array.isArray(groups) || groups.some(group => !object(group) || !Array.isArray(group.hooks))) {
      throw new Error(`Expected hook groups for ${event} in ${file}.`);
    }
    const entries = groups.flatMap(group => group.hooks).filter(entry =>
      typeof entry?.statusMessage === "string" && entry.statusMessage.toLowerCase() === hookLabel.toLowerCase());
    if (entries.length > 1 || (entries.length === 1 && entries[0].type !== "command")) {
      throw new Error(`A different ${hookLabel} hook already exists in ${file}.`);
    }
    const [existing] = entries;
    if (existing) {
      if (existing.command !== command && !isManagedHookCommand(existing.command, { node, hook, project })) {
        throw new Error(`Custom ${hookLabel} hook preserved in ${file}.`);
      }
      existing.command = command;
      existing.timeout = timeout;
    } else {
      groups.push({ hooks: [{ type: "command", command, timeout, statusMessage: hookLabel }] });
    }
  }
  return JSON.stringify(config) === original ? [] : [{ file, text: JSON.stringify(config, null, 2) + "\n" }];
}

function requireFile(file) {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Bridge file missing: ${file}`);
}

async function install(argv) {
  const { global, workspace, hooksOnly, stateDirectory, mode, help } = options(argv);
  if (help) { process.stdout.write(usage + "\n"); return; }
  try { await import("node:sqlite"); }
  catch { throw new Error("Use Node.js 22.13+ or 24 LTS with node:sqlite support."); }

  const node = process.execPath;
  const project = global ? "." : path.resolve(workspace ?? process.cwd());
  if (!global && !statSync(project, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Workspace must be a directory: ${project}`);
  const configRoot = global ? path.join(homedir(), ".gemini/config") : path.join(project, ".agents");
  const server = path.join(root, "mcp.cjs");
  const hook = path.join(root, "hook.cjs");
  if (!global) requireFile(hook);
  let stateRoot = stateDirectory === undefined ? path.join(root, ".state") : path.resolve(stateDirectory);
  const writes = [];

  if (!hooksOnly) {
    requireFile(server);
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
  }

  const stateDirectoryInfo = statSync(stateRoot, { throwIfNoEntry: false });
  if (stateDirectoryInfo && !stateDirectoryInfo.isDirectory()) throw new Error(`State directory must be a directory: ${stateRoot}`);
  if (!global) writes.push(...planHooks(project, node, hook, path.join(stateRoot, "bridge.sqlite")));
  const legacyAgent = !hooksOnly && ["agents/codex-agy/agent.md", "agents/codex-agy.md"].some(file =>
    statSync(path.join(configRoot, file), { throwIfNoEntry: false })?.isFile());
  for (const { file, text } of writes) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
  }

  if (legacyAgent) process.stdout.write("Existing codex-agy agent files were preserved. Use agydex for the new coordinator.\n");
  if (hooksOnly) {
    process.stdout.write(`Configured only Codex hooks in ${project}. Review AGY Codex Bridge in Codex Settings > Hooks or /hooks.\n`);
  } else {
    process.stdout.write(`Configured Antigravity ${global ? "for this user" : `in ${project}`} with default mode ${mode}.\n`);
    process.stdout.write("Start Antigravity in your working directory: agy --agent agydex\n");
  }
  process.stdout.write(`Bridge state directory: ${stateRoot}\n`);
}

if (process.argv[1] && samePath(path.resolve(process.argv[1]), script)) {
  install(process.argv.slice(2)).catch(error => {
    process.stderr.write(`AGY Codex Bridge: ${error.message}\n`);
    process.exitCode = 1;
  });
}
