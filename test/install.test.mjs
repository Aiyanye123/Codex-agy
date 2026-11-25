import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const stateRoot = path.join(repo, ".state");
let scratch;
let sourceAgent;
let env;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data));
}

before(() => {
  mkdirSync(stateRoot, { recursive: true });
  scratch = mkdtempSync(path.join(stateRoot, "install-test-"));
  sourceAgent = path.join(scratch, "src", "agent.md");
  mkdirSync(path.dirname(sourceAgent));
  copyFileSync(path.join(repo, "src", "agent.md"), sourceAgent);
  for (const file of ["Install.ps1", "mcp.cjs", "core.cjs", "hook.cjs"]) {
    copyFileSync(path.join(repo, file), path.join(scratch, file));
  }
  // CLI probes use stand-ins. Even -Global below targets this run's private profile.
  writeFileSync(path.join(scratch, "agy.cmd"), "@echo off\r\nif not \"%1\"==\"--version\" exit /b 2\r\necho 1.5.13\r\n");
  writeFileSync(path.join(scratch, "codex.cmd"), "@echo off\r\nif not \"%1 %2\"==\"queue --help\" exit /b 2\r\necho --thread --message\r\n");
  env = { ...process.env, USERPROFILE: path.join(scratch, "profile"), BRIDGE_TEST_DIR: scratch };
});

after(() => {
  if (!scratch) return;
  assert.equal(path.dirname(scratch), stateRoot);
  assert.ok(path.basename(scratch).startsWith("install-test-"));
  execFileSync("pwsh", ["-NoProfile", "-Command",
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:BRIDGE_TEST_DIR,'OnlyErrorDialogs','SendToRecycleBin')"],
    { env: { ...process.env, BRIDGE_TEST_DIR: scratch } });
});

function install(workspace, { global = false, hooksOnly = false, expectedError } = {}) {
  if (!global) mkdirSync(workspace, { recursive: true });
  const command = `
    $ErrorActionPreference = 'Stop'
    function Get-Command($Name, $CommandType, $ErrorAction) {
      if ($Name -eq 'agy') { return @{ Source = Join-Path $env:BRIDGE_TEST_DIR 'agy.cmd' } }
      if ($Name -eq 'codex.exe') { return @{ Source = Join-Path $env:BRIDGE_TEST_DIR 'codex.cmd' } }
      Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters
    }
    $params = @{ StateDirectory = Join-Path $env:BRIDGE_TEST_DIR 'state' }
    if ($env:BRIDGE_TEST_SCOPE -eq 'global') { $params.Global = $true }
    else { $params.Workspace = $env:BRIDGE_TEST_WORKSPACE }
    if ($env:BRIDGE_TEST_HOOKS -eq 'yes') { $params.HooksOnly = $true }
    try { & (Join-Path $env:BRIDGE_TEST_DIR 'Install.ps1') @params }
    catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
  `;
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], {
    encoding: "utf8", cwd: scratch,
    env: { ...env, BRIDGE_TEST_SCOPE: global ? "global" : "workspace",
      BRIDGE_TEST_WORKSPACE: workspace, BRIDGE_TEST_HOOKS: hooksOnly ? "yes" : "no" },
  });
  assert.ifError(result.error);
  if (expectedError) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
  } else {
    assert.equal(result.status, 0, result.stderr);
  }
  return result.stdout;
}

function files(configRoot) {
  return { agent: path.join(configRoot, "agents/agydex/agent.md"), mcp: path.join(configRoot, "mcp_config.json") };
}

test("fresh global install in a disposable profile; repeating it does not rewrite settings", async () => {
  const { agent, mcp } = files(path.join(env.USERPROFILE, ".gemini/config"));
  assert.match(install("", { global: true }), /agy --agent agydex\b/);
  assert.equal(readFileSync(agent, "utf8"), readFileSync(sourceAgent, "utf8"));
  assert.match(readFileSync(agent, "utf8"), /^name: agydex$/m);
  const server = readJson(mcp).mcpServers.codex_bridge;
  assert.equal(server.args[2], ".");
  assert.equal(server.timeoutSeconds, 3700);
  assert.equal(server.tools.watch.background, "always");
  const client = new Client({ name: "install-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", path.join(scratch, "mcp.cjs"), ".", ":memory:", "unused"],
    cwd: scratch,
  });
  await client.connect(transport);
  try {
    const { tools, nextCursor } = await client.listTools();
    assert.equal(nextCursor, undefined);
    assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(server.tools).sort());
    assert.ok(Object.values(server.tools).every(tool => tool.eager === true));
    assert.equal(client.getInstructions(), "Use bridge tools directly.");
    const properties = tools.find(tool => tool.name === "search_workspace").inputSchema.properties;
    for (const key of ["query", "path", "glob"]) assert.doesNotMatch(properties[key].pattern, /\\u[\da-f]{4}/i);
  } finally { await client.close(); }
  const receiptDir = path.join(scratch, "state/managed-agents");
  const paths = [agent, mcp, ...readdirSync(receiptDir).map(name => path.join(receiptDir, name))];
  assert.equal(paths.length, 3);
  const times = paths.map(file => statSync(file).mtimeMs);
  install("", { global: true });
  assert.deepEqual(paths.map(file => statSync(file).mtimeMs), times);
});

test("legacy workspace installs agydex, preserves old roles, and upgrades only the bridge MCP settings", () => {
  const workspace = path.join(scratch, "legacy");
  const configRoot = path.join(workspace, ".agents");
  const { agent, mcp } = files(configRoot);
  const legacyAgent = path.join(configRoot, "agents/codex-agy/agent.md");
  const legacyFlat = path.join(configRoot, "agents/codex-agy.md");
  mkdirSync(path.dirname(legacyAgent), { recursive: true });
  const oldAgent = execFileSync("git", ["show", "bbbe1b1:src/agent.md"], { cwd: repo, encoding: "utf8" })
    .replace(/\r?\n/g, "\r\n");
  const customLegacy = oldAgent + "\r\nCustom legacy instructions\r\n";
  writeFileSync(legacyAgent, oldAgent);
  writeFileSync(legacyFlat, customLegacy);
  const thirdParty = { command: "other.exe", args: ["--example"], env: { TEST: "untouched" } };
  writeJson(mcp, { mcpServers: { other: thirdParty, codex_bridge: {
    command: "C:\\old\\node.exe", args: ["--disable-warning=ExperimentalWarning", path.join(scratch, "mcp.cjs"),
      workspace, "old-state", "old-codex"], timeoutSeconds: 45, disabled: true,
    tools: { obsolete: {}, watch: { eager: false } },
  } } });
  assert.match(install(workspace), /Existing codex-agy agent files were preserved/);
  assert.equal(readFileSync(agent, "utf8"), readFileSync(sourceAgent, "utf8"));
  assert.equal(readFileSync(legacyAgent, "utf8"), oldAgent);
  assert.equal(readFileSync(legacyFlat, "utf8"), customLegacy);
  const servers = readJson(mcp).mcpServers;
  assert.deepEqual(servers.other, thirdParty);
  assert.equal(servers.codex_bridge.disabled, true);
  assert.equal(servers.codex_bridge.timeoutSeconds, 3700);
  assert.equal(servers.codex_bridge.args[3], path.join(scratch, "state/bridge.sqlite"));
  assert.deepEqual(servers.codex_bridge.tools, { bind: { eager: true }, unbind: { eager: true },
    submit: { eager: true }, steer: { eager: true }, interrupt: { eager: true }, approve: { eager: true },
    resume_draft: { eager: true }, dismiss: { eager: true }, list_tasks: { eager: true },
    search_workspace: { eager: true }, read_document: { eager: true }, recent_replies: { eager: true },
    status: { eager: true }, watch: { eager: true, background: "always" } });
  assert.ok(existsSync(path.join(workspace, ".codex/hooks.json")));
});

test("custom agent and unrelated same-name server both stop upgrades before writes", () => {
  const workspace = path.join(scratch, "custom");
  install(workspace);
  const { agent, mcp } = files(path.join(workspace, ".agents"));
  const config = readJson(mcp);
  config.mcpServers.codex_bridge.timeoutSeconds = 5;
  writeJson(mcp, config);
  const before = readFileSync(mcp, "utf8");
  writeFileSync(agent, "My coordinator\n");
  install(workspace, { expectedError: /Custom coordinator preserved/ });
  assert.equal(readFileSync(agent, "utf8"), "My coordinator\n");
  assert.equal(readFileSync(mcp, "utf8"), before);
  copyFileSync(sourceAgent, agent);
  config.mcpServers.codex_bridge.args[1] = "C:\\external\\mcp.cjs";
  writeJson(mcp, config);
  install(workspace, { expectedError: /Conflicting codex_bridge preserved/ });
  assert.deepEqual(readJson(mcp), config);
});

test("hooks-only creates only hooks and repeating it leaves the file untouched", () => {
  const workspace = path.join(scratch, "hooks-only");
  install(workspace, { hooksOnly: true });
  assert.deepEqual(readdirSync(workspace), [".codex"]);
  const hooks = path.join(workspace, ".codex/hooks.json");
  const config = readJson(hooks);
  assert.deepEqual(Object.keys(config.hooks).sort(), ["Interrupt", "Stop", "UserPromptSubmit"]);
  const time = statSync(hooks).mtimeMs;
  install(workspace, { hooksOnly: true });
  assert.equal(statSync(hooks).mtimeMs, time);
});

test("an existing flat agydex agent is tracked and upgraded in place", () => {
  const workspace = path.join(scratch, "later-release");
  const configRoot = path.join(workspace, ".agents");
  const flatAgent = path.join(configRoot, "agents/agydex.md");
  const original = readFileSync(sourceAgent, "utf8");
  try {
    mkdirSync(path.dirname(flatAgent), { recursive: true });
    writeFileSync(flatAgent, original);
    install(workspace);
    writeFileSync(sourceAgent, original + "\nNext synthetic release\n");
    install(workspace);
    assert.equal(readFileSync(flatAgent, "utf8"), readFileSync(sourceAgent, "utf8"));
    assert.equal(existsSync(files(configRoot).agent), false);
  } finally {
    writeFileSync(sourceAgent, original);
  }
});

test("hooks-only updates a known old hook while protecting a different command", () => {
  const workspace = path.join(scratch, "upgrade-hooks");
  install(workspace, { hooksOnly: true });
  const hooksFile = path.join(workspace, ".codex/hooks.json");
  const config = readJson(hooksFile);
  const stop = config.hooks.Stop[0].hooks[0];
  const current = stop.command;
  const prefix = current.slice(0, current.lastIndexOf(" ") + 1);
  const script = Buffer.from(current.slice(prefix.length), "base64").toString("utf16le");
  const previous = script.replace(path.join(scratch, "state/bridge.sqlite"), "C:\\older\\bridge.sqlite")
    .replace("\nexit $LASTEXITCODE", ` '${workspace}'\nexit $LASTEXITCODE`);
  assert.notEqual(previous, script);
  stop.command = prefix + Buffer.from(previous, "utf16le").toString("base64");
  stop.timeout = 5;
  writeJson(hooksFile, config);
  install(workspace, { hooksOnly: true });
  const updated = readJson(hooksFile).hooks.Stop[0].hooks[0];
  assert.equal(updated.command, current);
  assert.equal(updated.timeout, 10);
  stop.command = "my-custom-hook";
  writeJson(hooksFile, config);
  install(workspace, { hooksOnly: true, expectedError: /Custom AGY Codex Bridge hook preserved/ });
  assert.deepEqual(readJson(hooksFile), config);
  assert.equal(existsSync(path.join(workspace, ".agents")), false);
});

test("incomplete queue capabilities stop installation before config is written", () => {
  const workspace = path.join(scratch, "unsupported-cli");
  const cli = path.join(scratch, "codex.cmd");
  const original = readFileSync(cli);
  try {
    writeFileSync(cli, "@echo off\r\necho --thread only\r\n");
    install(workspace, { expectedError: /must support --thread and --message/ });
    assert.deepEqual(readdirSync(workspace), []);
  } finally {
    writeFileSync(cli, original);
  }
});
