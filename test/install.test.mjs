import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import core from "../core.cjs";
import { hookCommand, isManagedHookCommand } from "../install.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const tempRoot = realpathSync.native(tmpdir());
const isWindows = process.platform === "win32";
const warning = "--disable-warning=ExperimentalWarning";
const pwsh = isWindows && execFileSync("pwsh", ["-NoProfile", "-Command", "[Console]::Write((Get-Process -Id $PID).Path)"], { encoding: "utf8" });
let scratch, bridge, invocation, bin, env, sourceAgent, codex, queueProbe, serverProbe;

const json = file => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value));
const sha512 = value => createHash("sha512").update(value, "utf8").digest("hex");
const tools = ["bind", "unbind", "submit", "steer", "interrupt", "approve", "resume_draft", "dismiss",
  "list_tasks", "recent_replies", "status", "watch"];
const validQueue = 'console.log("--thread <id> --message <text>");';
const validServer = 'console.log("--listen <url>");';

before(() => {
  scratch = mkdtempSync(path.join(tempRoot, "agy-install-test-"));
  bridge = path.join(scratch, "bridge ' 中文 & files");
  invocation = path.join(scratch, "invocation");
  bin = path.join(scratch, "native-bin");
  sourceAgent = path.join(bridge, "src", "agent.md");
  for (const directory of [path.dirname(sourceAgent), invocation, bin]) mkdirSync(directory, { recursive: true });
  copyFileSync(path.join(repo, "src", "agent.md"), sourceAgent);
  for (const file of ["install.mjs", "Install.ps1", "mcp.cjs", "core.cjs", "hook.cjs"]) {
    copyFileSync(path.join(repo, file), path.join(bridge, file));
  }
  codex = path.join(bin, isWindows ? "codex.exe" : "codex");
  queueProbe = path.join(invocation, "queue");
  serverProbe = path.join(invocation, "app-server");
  if (isWindows) {
    copyFileSync(process.execPath, codex);
    linkSync(codex, path.join(bin, "agy.exe"));
    linkSync(codex, path.join(bin, "node.exe"));
    writeFileSync(queueProbe, validQueue);
    writeFileSync(serverProbe, validServer);
  } else {
    writeFileSync(path.join(bin, "agy"), "#!/bin/sh\nprintf '1.5.17\\n'\n", { mode: 0o700 });
    writeFileSync(codex, "#!/bin/sh\ncase \"$1\" in\nqueue) printf '%s\\n' '--thread --message';;\napp-server) printf '%s\\n' '--listen';;\n*) exit 1;;\nesac\n", { mode: 0o700 });
  }
  const profile = path.join(scratch, "test-profile");
  env = { ...process.env, USERPROFILE: profile, HOME: profile,
    PATH: [bin, ...(isWindows ? [path.dirname(pwsh)] : [])].join(path.delimiter) };
});

after(() => {
  if (!scratch) return;
  assert.equal(path.dirname(realpathSync.native(scratch)), tempRoot);
  assert.ok(path.basename(scratch).startsWith("agy-install-test-"));
  if (isWindows) {
    execFileSync(pwsh, ["-NoProfile", "-Command",
      "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:BRIDGE_TEST_DIR,'OnlyErrorDialogs','SendToRecycleBin')"],
      { env: { ...process.env, BRIDGE_TEST_DIR: scratch } });
  } else {
    // Keep the fixture together for recycling on the host.
    process.stdout.write(`Installer fixture directory: ${scratch}\n`);
  }
});

function install(args, { wrapper = false, cwd = invocation, testEnv = env, error } = {}) {
  const command = wrapper ? pwsh : process.execPath;
  const prefix = wrapper ? ["-NoProfile", "-File", path.join(bridge, "Install.ps1")] : [warning, path.join(bridge, "install.mjs")];
  const result = spawnSync(command, [...prefix, ...args], { encoding: "utf8", cwd, env: testEnv, timeout: 20000 });
  assert.ifError(result.error);
  if (error) {
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, error);
  } else {
    assert.equal(result.status, 0, result.stderr);
  }
  return result.stdout;
}

function workspace(name) {
  const dir = path.join(scratch, name);
  mkdirSync(dir);
  return dir;
}

function files(configRoot) {
  return { agent: path.join(configRoot, "agents/agydex/agent.md"), mcp: path.join(configRoot, "mcp_config.json") };
}

test("isolated global install uses five arguments and keeps unchanged files and managed receipt", () => {
  const { agent, mcp } = files(path.join(env.HOME, ".gemini/config"));
  const state = path.join(bridge, ".state");
  const testEnv = { ...env, PATH: bin };
  assert.match(install(["--global"], { testEnv }), /default mode desktop/);
  const server = json(mcp).mcpServers.codex_bridge;
  assert.deepEqual(server.args, [warning, path.join(bridge, "mcp.cjs"), ".", path.join(state, "bridge.sqlite"), codex]);
  assert.equal(server.command, process.execPath);
  assert.equal(server.timeoutSeconds, 3700);
  assert.equal(server.tools.watch.background, "always");
  assert.deepEqual(Object.keys(server.tools).sort(), [...tools].sort());
  assert.ok(Object.values(server.tools).every(tool => tool.eager === true));
  const receiptDir = path.join(state, "managed-agents");
  const receipts = readdirSync(receiptDir);
  assert.equal(receipts.length, 1);
  assert.match(receipts[0], /^[a-f0-9]{128}\.sha512$/);
  const paths = [agent, mcp, path.join(receiptDir, receipts[0])];
  const times = paths.map(file => statSync(file).mtimeMs);
  install(["--global"], { testEnv });
  assert.deepEqual(paths.map(file => statSync(file).mtimeMs), times);
  assert.equal(existsSync(path.join(state, "bridge.sqlite")), false);
});

test("legacy custom state and SHA-512 receipt support desktop/direct switching and preserve user fields", async () => {
  const dir = workspace("Legacy 中文");
  const configRoot = path.join(dir, ".agents");
  const { agent: folderAgent, mcp } = files(configRoot);
  const agent = path.join(configRoot, "agents/agydex.md");
  const legacyAgent = path.join(configRoot, "agents/codex-agy/agent.md");
  const legacyFlat = path.join(configRoot, "agents/codex-agy.md");
  const state = path.join(scratch, "existing-state");
  const receipts = path.join(state, "managed-agents");
  const oldAgent = "name: agydex\n\nOriginal managed coordinator\n";
  mkdirSync(path.dirname(legacyAgent), { recursive: true });
  mkdirSync(receipts, { recursive: true });
  writeFileSync(legacyAgent, "original legacy folder");
  writeFileSync(legacyFlat, "original legacy flat");
  writeFileSync(agent, "\uFEFF" + oldAgent.replaceAll("\n", "\r\n"));
  const pathKey = isWindows ? agent.toUpperCase() : agent;
  const receipt = path.join(receipts, sha512(pathKey) + ".sha512");
  writeFileSync(receipt, sha512(oldAgent));
  const thirdParty = { command: "unrelated-tool", args: ["--example"], env: { TEST: "untouched" } };
  writeJson(mcp, { mcpServers: { other: thirdParty, codex_bridge: {
    command: isWindows ? "C:\\old\\node.exe" : "/old/node",
    args: [warning, path.join(bridge, "mcp.cjs"), dir, path.join(state, "bridge.sqlite"), codex],
    timeoutSeconds: 45, disabled: true, tools: { search_workspace: {} },
  } } });

  assert.match(install(["--workspace", dir, "--default-mode", "direct"]), /Existing codex-agy agent files were preserved/);
  const content = readFileSync(sourceAgent, "utf8");
  assert.equal(readFileSync(agent, "utf8"), content);
  assert.equal(existsSync(folderAgent), false);
  assert.equal(readFileSync(legacyAgent, "utf8"), "original legacy folder");
  assert.equal(readFileSync(legacyFlat, "utf8"), "original legacy flat");
  assert.equal(readFileSync(receipt, "utf8"), sha512(content.replaceAll("\r\n", "\n")));
  assert.deepEqual(readdirSync(receipts), [path.basename(receipt)]);
  const { codex_bridge: direct, other } = json(mcp).mcpServers;
  assert.deepEqual(other, thirdParty);
  assert.equal(direct.disabled, true);
  assert.equal(direct.args[3], path.join(state, "bridge.sqlite"));
  assert.equal(direct.args[5], "direct");

  install(["--workspace", dir, "--default-mode", "desktop"]);
  const desktop = json(mcp).mcpServers.codex_bridge;
  assert.deepEqual(desktop.args, direct.args.slice(0, 5));
  assert.equal(desktop.disabled, true);
  const config = json(mcp);
  config.mcpServers.codex_bridge.args.push("desktop"); // Also accept explicitly stored six-argument desktop entries.
  writeJson(mcp, config);
  install(["--workspace", dir, "--default-mode", "direct"]);
  assert.equal(json(mcp).mcpServers.codex_bridge.args[5], "direct");

  const client = new Client({ name: "install-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: direct.command,
    args: direct.args.map((arg, index) => index === 3 ? ":memory:" : arg), cwd: dir }));
  try {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [...tools].sort());
    const status = await client.callTool({ name: "status", arguments: {}, _meta: { "antigravity.google/root_conversation_id": "test" } });
    assert.equal(status.structuredContent.execution_mode, "direct");
  } finally { await client.close(); }
});

test("PowerShell wrapper forwards scope, relative state, defaults and failure exit code", { skip: !isWindows }, () => {
  const profile = path.join(scratch, "wrapper-profile");
  const target = files(path.join(profile, ".gemini/config"));
  const state = "wrapper-state";
  install(["-Global", "-StateDirectory", state, "-DefaultMode", "direct"], {
    wrapper: true, testEnv: { ...env, USERPROFILE: profile },
  });
  assert.deepEqual(json(target.mcp).mcpServers.codex_bridge.args.slice(2),
    [".", path.join(invocation, state, "bridge.sqlite"), codex, "direct"]);

  const implicit = workspace("wrapper-current-folder");
  copyFileSync(queueProbe, path.join(implicit, "queue"));
  copyFileSync(serverProbe, path.join(implicit, "app-server"));
  install([], { wrapper: true, cwd: implicit });
  const entry = json(files(path.join(implicit, ".agents")).mcp).mcpServers.codex_bridge;
  assert.equal(entry.args[2], implicit);
  assert.equal(entry.args[3], path.join(bridge, ".state", "bridge.sqlite"));

  const dir = workspace("wrapper-hooks-only");
  const noCli = path.join(scratch, "no-cli");
  mkdirSync(noCli);
  linkSync(codex, path.join(noCli, "node.exe"));
  const hooksArgs = ["-Workspace", dir, "-HooksOnly", "-StateDirectory", state];
  install(hooksArgs, { wrapper: true, testEnv: { ...env, PATH: noCli } });
  assert.deepEqual(readdirSync(dir), [".codex"]);
  install([...hooksArgs, "-DefaultMode", "desktop"], { wrapper: true, error: /cannot be combined with --hooks-only/ });
});

test("conflicts protect the agent, unrelated server and hand-edited hook before any writes", () => {
  const dir = workspace("conflicts");
  const { agent, mcp } = files(path.join(dir, ".agents"));
  const hookFile = path.join(dir, ".codex/hooks.json");
  const args = ["--workspace", dir, "--state-directory", path.join(scratch, "conflict-state")];
  install(args);
  const original = new Map([agent, mcp, hookFile].map(file => [file, readFileSync(file, "utf8")]));
  writeFileSync(agent, "My coordinator\n");
  install([...args, "--default-mode", "direct"], { error: /Custom coordinator preserved/ });
  assert.equal(readFileSync(agent, "utf8"), "My coordinator\n");
  assert.equal(readFileSync(mcp, "utf8"), original.get(mcp));
  writeFileSync(agent, original.get(agent));
  for (const remote of [false, true]) {
    const config = JSON.parse(original.get(mcp));
    const entry = config.mcpServers.codex_bridge;
    if (remote) entry.url = "https://mcp.example.invalid";
    else entry.args[1] = path.join(scratch, "other-bridge", "mcp.cjs");
    writeJson(mcp, config);
    install(args, { error: /Conflicting codex_bridge preserved/ });
    assert.deepEqual(json(mcp), config);
  }
  writeFileSync(mcp, original.get(mcp));
  const config = json(hookFile);
  config.hooks.Stop[0].hooks[0].command = "my-custom-hook";
  writeJson(hookFile, config);
  install([...args, "--default-mode", "direct"], { error: /Custom AGY Codex Bridge hook preserved/ });
  assert.deepEqual(json(hookFile), config);
  assert.equal(readFileSync(mcp, "utf8"), original.get(mcp));
  assert.equal(readFileSync(agent, "utf8"), original.get(agent));
});

test("CLI validates scope and app capabilities and skips relative PATH entries", { skip: !isWindows }, () => {
  const dir = workspace("invalid");
  const args = ["--workspace", dir];
  install([...args, "--global"], { error: /--global cannot be combined/ });
  install([...args, "--hooks-only", "--default-mode", "direct"], { error: /--default-mode configures MCP/ });
  install([...args, "--default-mode", "invalid"], { error: /must be desktop or direct/ });

  linkSync(codex, path.join(invocation, "codex.exe"));
  const shims = path.join(scratch, "shims");
  mkdirSync(shims);
  writeFileSync(path.join(shims, "codex.cmd"), "@echo NOT A NATIVE CODEX\r\n");
  linkSync(codex, path.join(shims, "agy.exe"));
  install(args, { testEnv: { ...env, PATH: [".", "", shims].join(path.delimiter) }, error: /Only a .cmd\/.bat shim for codex/ });
  try {
    writeFileSync(queueProbe, 'console.log("--thread");');
    install(args, { error: /must support --thread and --message/ });
    writeFileSync(queueProbe, validQueue);
    writeFileSync(serverProbe, "process.exitCode = 2;");
    install(args, { error: /app-server --help failed/ });
  } finally {
    writeFileSync(queueProbe, validQueue);
    writeFileSync(serverProbe, validServer);
  }
  assert.deepEqual(readdirSync(dir), []);
});

test("Windows reuses old hook registrations and executes all three events with UTF-8", { skip: !isWindows }, () => {
  const dir = workspace("hooks ' 中文 ＆");
  const state = path.join(scratch, "hooks state ' 中文 ＆ ‘ ’");
  const dbPath = path.join(state, "bridge.sqlite");
  const hook = path.join(bridge, "hook.cjs");
  const file = path.join(dir, ".codex/hooks.json");
  const args = ["--workspace", dir, "--hooks-only", "--state-directory", state];
  const runtime = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const hooksWithoutCli = { ...env, PATH: "" };
  install(args, { testEnv: hooksWithoutCli });
  const config = json(file);
  const current = config.hooks.Stop[0].hooks[0].command;
  const prefix = "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ";
  const ps = value => "'" + value.replaceAll("'", "''") + "'";
  const old = [
    '$encoding = [Text.UTF8Encoding]::new($false)', '[Console]::InputEncoding = $encoding',
    '[Console]::OutputEncoding = $encoding', '$OutputEncoding = $encoding', '$payload = [Console]::In.ReadToEnd()',
    '$payload | & ' + ["C:\\older\\node.exe", warning, hook, "C:\\older\\bridge.sqlite", dir]
      .map((arg, index) => index === 1 ? arg : ps(arg)).join(" "),
    'exit $LASTEXITCODE',
  ].join("\r\n");
  config.hooks.Stop[0].hooks[0].command = prefix + Buffer.from(old, "utf16le").toString("base64");
  config.hooks.Stop[0].hooks[0].timeout = 7;
  config.hooks.Stop[0].hooks.push({ type: "command", command: "echo third-party", statusMessage: "Other" });
  writeJson(file, config);
  install(args, { testEnv: hooksWithoutCli });
  const upgraded = json(file);
  assert.equal(upgraded.hooks.Stop[0].hooks[0].command, current);
  assert.deepEqual(upgraded.hooks.Stop[0].hooks[1], config.hooks.Stop[0].hooks[1]);
  const time = statSync(file).mtimeMs;
  install(args, { testEnv: hooksWithoutCli });
  assert.equal(statSync(file).mtimeMs, time);
  assert.deepEqual(readdirSync(dir), [".codex"]);
  assert.equal(existsSync(dbPath), false);

  mkdirSync(state);
  const database = core.openDatabase(dbPath);
  const stored = database.prepare("SELECT state, report FROM tasks WHERE id = ?");
  const thread = randomUUID();
  const execute = (name, record) => {
    const entry = upgraded.hooks[name][0].hooks[0];
    assert.equal(entry.timeout, name === "Interrupt" ? 3 : 10);
    assert.match(entry.command, /^powershell\.exe /);
    const result = spawnSync(runtime, entry.command.split(" ").slice(1), {
      cwd: dir, encoding: "utf8", input: "\uFEFF" + JSON.stringify({
        hook_event_name: name, session_id: thread, cwd: dir, ...record,
      }), timeout: 8000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  };
  try {
    for (const event of ["Stop", "Interrupt"]) {
      const id = randomUUID();
      const turn_id = randomUUID();
      database.prepare("INSERT INTO tasks(id, owner, workspace, state) VALUES (?, 'test', ?, 'awaiting_send')").run(id, dir);
      execute("UserPromptSubmit", { turn_id, prompt: `[AGY Codex task: ${id}]\r\n\r\n测试任务` });
      assert.equal(stored.get(id).state, "running");
      execute(event, { turn_id, last_assistant_message: "完成 ✓ 中文 ‘回执’" });
      assert.equal(stored.get(id).state, event === "Stop" ? "reported" : "interrupted");
      if (event === "Stop") assert.equal(stored.get(id).report, "完成 ✓ 中文 ‘回执’");
    }
  } finally { database.close(); }
});

test("POSIX quoting preserves every argv value and recognizes only the managed command shape", () => {
  const node = "/opt/Node ' \" 中文 $HOME/node";
  const hook = "/work/Folder ' \" 中文 $HOME; & $(echo injected) \\ script/hook.cjs";
  const oldState = "/var/Old ' \" 中文 $HOME; & $(echo injected)/bridge.sqlite";
  const expected = [node, warning, hook, oldState];
  let sh = "sh";
  if (isWindows) {
    const gitExecPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    sh = path.resolve(gitExecPath, "../../..", "usr", "bin", "sh.exe");
  }
  for (const platform of ["darwin", "linux"]) {
    const command = hookCommand(node, hook, oldState, platform);
    const result = spawnSync(sh, ["-s"], {
      input: `set -- ${command}\nprintf '%s\\0' "$@"\n`, encoding: "utf8", timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.split("\0").slice(0, -1), expected);
    const target = { node: "/replacement/node", hook, project: "/work", platform };
    assert.equal(isManagedHookCommand(command, target), true);
    assert.equal(isManagedHookCommand(command + "; echo custom", target), false);
    assert.equal(isManagedHookCommand(command, { ...target, hook: "/other/hook.cjs" }), false);
  }
});
