#Requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'Workspace')]
param(
    [Parameter(ParameterSetName = 'Workspace')]
    [string]$Workspace = (Get-Location).Path,
    [Parameter(Mandatory, ParameterSetName = 'Global')]
    [switch]$Global,
    [string]$StateDirectory = (Join-Path $PSScriptRoot '.state')
)

$ErrorActionPreference = 'Stop'

function Read-JsonObject([string]$Path) {
    if (!(Test-Path -LiteralPath $Path)) { return @{} }
    $value = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable -Depth 100
    if ($value -isnot [System.Collections.IDictionary]) { throw "Expected a JSON object in $Path" }
    return $value
}

function PowerShellLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

if ($Global) {
    $project = '.'
    $configRoot = Join-Path $env:USERPROFILE '.gemini/config'
} else {
    $project = (Get-Item -LiteralPath $Workspace).FullName
    if (!(Test-Path -LiteralPath $project -PathType Container)) { throw "Workspace must be a directory: $project" }
    $configRoot = Join-Path $project '.agents'
}
$stateRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($StateDirectory)
$state = Join-Path $stateRoot 'bridge.sqlite'
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$codex = (Get-Command codex.exe -CommandType Application | Select-Object -First 1).Source
& $node --disable-warning=ExperimentalWarning -e "require('node:sqlite')"
if ($LASTEXITCODE -ne 0) { throw 'Use a Node.js release with node:sqlite support (22.13+ or 24 LTS).' }

$server = Join-Path $PSScriptRoot 'mcp.cjs'
$hook = Join-Path $PSScriptRoot 'hook.cjs'
$agent = Join-Path $PSScriptRoot 'agent.md'
foreach ($file in @($server, $hook, $agent)) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Bridge file missing: $file" }
}

$mcpPath = Join-Path $configRoot 'mcp_config.json'
$agentPath = Join-Path $configRoot 'agents/codex-agy/agent.md'
$flatAgentPath = Join-Path $configRoot 'agents/codex-agy.md'
if (Test-Path -LiteralPath $flatAgentPath -PathType Leaf) { $agentPath = $flatAgentPath }
$mcp = Read-JsonObject $mcpPath
$agentText = [IO.File]::ReadAllText($agent)
if ((Test-Path -LiteralPath $agentPath) -and [IO.File]::ReadAllText($agentPath) -cne $agentText) {
    throw "An existing coordinator differs from this release: $agentPath"
}

$mcpUpdate = [ordered]@{
    command = $node
    args = @('--disable-warning=ExperimentalWarning', $server, $project, $state, $codex)
    timeoutSeconds = 3700
    tools = [ordered]@{
        bind = @{ eager = $true }
        unbind = @{ eager = $true }
        submit = @{ eager = $true }
        status = @{ eager = $true }
        watch = @{ eager = $true; background = 'always' }
    }
}
if (!$mcp.Contains('mcpServers')) { $mcp['mcpServers'] = @{} }
if ($mcp['mcpServers'] -isnot [System.Collections.IDictionary]) { throw "Invalid mcpServers in $mcpPath" }
$writeMcp = !$mcp['mcpServers'].Contains('codex_bridge')
if ($writeMcp) {
    $mcp['mcpServers']['codex_bridge'] = $mcpUpdate
} else {
    $existingMcp = $mcp['mcpServers']['codex_bridge']
    if ($existingMcp -isnot [System.Collections.IDictionary] -or $existingMcp['command'] -cne $node -or (
        (ConvertTo-Json -InputObject $existingMcp['args'] -Compress) -cne
        (ConvertTo-Json -InputObject $mcpUpdate['args'] -Compress)
    )) {
        throw "A different codex_bridge MCP entry already exists in $mcpPath"
    }
    if (!$existingMcp.Contains('tools')) { $existingMcp['tools'] = @{} }
    if ($existingMcp['tools'] -isnot [System.Collections.IDictionary]) { throw "Invalid codex_bridge tools in $mcpPath" }
    foreach ($tool in @('unbind', 'watch')) {
        if (!$existingMcp['tools'].Contains($tool)) {
            $existingMcp['tools'][$tool] = $mcpUpdate.tools[$tool]
            $writeMcp = $true
        }
    }
    if (!$existingMcp.Contains('timeoutSeconds') -or $existingMcp['timeoutSeconds'] -eq 45) {
        $existingMcp['timeoutSeconds'] = $mcpUpdate.timeoutSeconds
        $writeMcp = $true
    }
}

if (!$Global) {
    $hooksPath = Join-Path $project '.codex/hooks.json'
    $hooks = Read-JsonObject $hooksPath
    $quotedArgs = @($node, $hook, $state, $project) | ForEach-Object { PowerShellLiteral $_ }
    $hookScript = @'
$encoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $encoding
[Console]::OutputEncoding = $encoding
$OutputEncoding = $encoding
$payload = [Console]::In.ReadToEnd()
'@
    $hookScript += "`n" + '$payload | & ' + $quotedArgs[0] + ' --disable-warning=ExperimentalWarning ' + ($quotedArgs[1..3] -join ' ')
    $hookScript += "`n" + 'exit $LASTEXITCODE'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($hookScript))
    $hookCommand = "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded"
    if (!$hooks.Contains('hooks')) { $hooks['hooks'] = @{} }
    if ($hooks['hooks'] -isnot [System.Collections.IDictionary]) { throw "Invalid hooks in $hooksPath" }
    $writeHooks = $false
    foreach ($event in @('UserPromptSubmit', 'Stop', 'Interrupt')) {
        $groups = @()
        if ($hooks['hooks'].Contains($event)) {
            if ($hooks['hooks'][$event] -isnot [array]) { throw "Expected an array for $event in $hooksPath" }
            $groups = $hooks['hooks'][$event]
        }
        $existing = @($groups | ForEach-Object { $_.hooks } | Where-Object { $_.statusMessage -eq 'AGY Codex Bridge' })
        if ($existing.Count -gt 0) {
            if ($existing.Count -ne 1 -or $existing[0].command -cne $hookCommand) {
                throw "A different AGY Codex Bridge hook already exists in $hooksPath"
            }
            continue
        }
        $timeout = if ($event -eq 'Interrupt') { 3 } else { 10 }
        $hooks['hooks'][$event] = $groups + @(@{
            hooks = @(@{ type = 'command'; command = $hookCommand; timeout = $timeout; statusMessage = 'AGY Codex Bridge' })
        })
        $writeHooks = $true
    }
}

foreach ($path in @($stateRoot, (Split-Path $mcpPath), (Split-Path $agentPath))) {
    [void][IO.Directory]::CreateDirectory($path)
}
if ($writeMcp) { [IO.File]::WriteAllText($mcpPath, ($mcp | ConvertTo-Json -Depth 100) + "`n") }
if (!(Test-Path -LiteralPath $agentPath)) { [IO.File]::WriteAllText($agentPath, $agentText) }

if ($Global) {
    Write-Output 'Configured Antigravity for this Windows user.'
    Write-Output 'Start Antigravity from the folder you want Codex to work in: agy --agent codex-agy'
    return
}
if ($writeHooks) {
    [void][IO.Directory]::CreateDirectory((Split-Path $hooksPath))
    [IO.File]::WriteAllText($hooksPath, ($hooks | ConvertTo-Json -Depth 100) + "`n")
}
Write-Output "Configured workspace: $project"
Write-Output 'Start Antigravity in this workspace: agy --agent codex-agy'
Write-Output 'Optional: review AGY Codex Bridge in Codex App Settings > Hooks for immediate task receipts.'
