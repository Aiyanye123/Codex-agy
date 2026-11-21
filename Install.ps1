#Requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'Workspace')]
param(
    [Parameter(ParameterSetName = 'Workspace')]
    [string]$Workspace = (Get-Location).Path,
    [Parameter(Mandatory, ParameterSetName = 'Global')]
    [switch]$Global,
    [Parameter(ParameterSetName = 'Workspace')]
    [switch]$HooksOnly,
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

function Test-ManagedHook([string]$Command, [string]$ExpectedScript, [string]$QuotedNode, [string]$QuotedState) {
    if ($Command -notmatch '^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$') { return $false }
    try { $scriptText = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1])) }
    catch [FormatException] { return $false }
    # Only the Node executable and state directory may vary in an older installed command.
    $pattern = [regex]::Escape($ExpectedScript.Replace("`r`n", "`n"))
    $pattern = $pattern.Replace([regex]::Escape($QuotedNode), "'(?:[^'`r`n]|'')+[\\/]node\.exe'")
    $pattern = $pattern.Replace([regex]::Escape($QuotedState), "'(?:[^'`r`n]|'')+[\\/]bridge\.sqlite'")
    return $scriptText.Replace("`r`n", "`n") -match ("\A" + $pattern + "\z")
}

function Get-TextFingerprint([string]$Text) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text.Replace("`r`n", "`n"))
    $algorithm = [Security.Cryptography.SHA512]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Require-Application([string]$Name) {
    $app = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$app) { throw "Cannot find $Name on PATH. Install it and open a new PowerShell window." }
    return $app.Source
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
$node = Require-Application node.exe
& $node --disable-warning=ExperimentalWarning -e "require('node:sqlite')"
if ($LASTEXITCODE -ne 0) { throw 'Use a Node.js release with node:sqlite support (22.13+ or 24 LTS).' }
$server = Join-Path $PSScriptRoot 'mcp.cjs'
$hook = Join-Path $PSScriptRoot 'hook.cjs'
if (!$Global -and !(Test-Path -LiteralPath $hook -PathType Leaf)) { throw "Bridge file missing: $hook" }

$writeHooks = $false
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
    foreach ($event in @('UserPromptSubmit', 'Stop', 'Interrupt')) {
        $groups = @()
        if ($hooks['hooks'].Contains($event)) {
            if ($hooks['hooks'][$event] -isnot [array]) { throw "Expected an array for $event in $hooksPath" }
            $groups = $hooks['hooks'][$event]
        }
        $timeout = if ($event -eq 'Interrupt') { 3 } else { 10 }
        $existing = @($groups | ForEach-Object { $_.hooks } | Where-Object { $_.statusMessage -eq 'AGY Codex Bridge' })
        if ($existing.Count -gt 0) {
            if ($existing.Count -ne 1 -or $existing[0].type -ne 'command') {
                throw "A different AGY Codex Bridge hook already exists in $hooksPath"
            }
            if ($existing[0].command -cne $hookCommand) {
                if (!(Test-ManagedHook $existing[0].command $hookScript $quotedArgs[0] $quotedArgs[2])) {
                    throw "Custom AGY Codex Bridge hook preserved in $hooksPath."
                }
                $existing[0].command = $hookCommand
                $writeHooks = $true
            }
            if ($existing[0].timeout -ne $timeout) {
                $existing[0].timeout = $timeout
                $writeHooks = $true
            }
            continue
        }
        $hooks['hooks'][$event] = $groups + @(@{
            hooks = @(@{ type = 'command'; command = $hookCommand; timeout = $timeout; statusMessage = 'AGY Codex Bridge' })
        })
        $writeHooks = $true
    }
}

if (!$HooksOnly) {
    $agy = Require-Application agy
    & $agy --version *> $null
    if ($LASTEXITCODE -ne 0) { throw "Antigravity version check failed: $agy --version" }
    $codex = Require-Application codex.exe
    $queueHelp = (& $codex queue --help 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $queueHelp -notmatch '(?m)(?:^|\s)--thread(?:\s|=|$)' -or
        $queueHelp -notmatch '(?m)(?:^|\s)--message(?:\s|=|$)') {
        throw "Update Codex CLI: $codex queue --help must support --thread and --message."
    }
    if (!(Test-Path -LiteralPath $server -PathType Leaf)) { throw "Bridge file missing: $server" }
    $agentText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'src/agent.md'))
    $agentPath = Join-Path $configRoot 'agents/codex-agy/agent.md'
    $flatPath = Join-Path $configRoot 'agents/codex-agy.md'
    if (Test-Path -LiteralPath $flatPath -PathType Leaf) { $agentPath = $flatPath }

    $templateHash = Get-TextFingerprint $agentText
    $targetKey = Get-TextFingerprint ([IO.Path]::GetFullPath($agentPath).ToUpperInvariant())
    $receipt = Join-Path $stateRoot "managed-agents/$targetKey.sha512"
    $lastInstalled = if (Test-Path -LiteralPath $receipt) { [IO.File]::ReadAllText($receipt).Trim() }
    $known = @(
        # Published bbbe1b1, P0 follow-up validation, and the subsequent reporting revision.
        'da197627bc8a202ad7198f8d4d29581c60ee943285cc4ae27b959d4ac00befdbfd440cb7c1dd63d7cdaf73c7b70756691e311fd773ff6d484d495d3f5fed077e'
        'cb0220faafd101436bab58dfcb1bf98639c2d9a8f50bb074f3e3afbe573204ad69741d4f573d31fea7c3c9016df32ea0545c990773438df6f013cb332a680be0'
        '5ea586f79c9be4507d845814b8c38413e76d443f35c943ddc30640c196dae7a39d8dc515fc2ae7971dd29c1b47349e601790d0eae6ca511c4b71fb4636216f19'
        $lastInstalled
    )
    $writeAgent = $true
    if (Test-Path -LiteralPath $agentPath) {
        $installed = Get-TextFingerprint ([IO.File]::ReadAllText($agentPath))
        $writeAgent = $installed -ne $templateHash
        if ($writeAgent -and $installed -notin $known) {
            throw "Custom coordinator preserved at $agentPath. Back it up and merge it with src/agent.md before retrying."
        }
    }

    $mcpPath = Join-Path $configRoot 'mcp_config.json'
    $mcp = Read-JsonObject $mcpPath
    if (!$mcp.Contains('mcpServers')) { $mcp['mcpServers'] = @{} }
    if ($mcp.mcpServers -isnot [System.Collections.IDictionary]) { throw "Invalid mcpServers in $mcpPath" }
    $servers = $mcp.mcpServers
    $desired = [ordered]@{
        command = $node
        args = @('--disable-warning=ExperimentalWarning', $server, $project, $state, $codex)
        timeoutSeconds = 3700
        tools = [ordered]@{
            bind = @{ eager = $true }
            unbind = @{ eager = $true }
            submit = @{ eager = $true }
            resume_draft = @{ eager = $true }
            dismiss = @{ eager = $true }
            list_tasks = @{ eager = $true }
            status = @{ eager = $true }
            watch = [ordered]@{ eager = $true; background = 'always' }
        }
    }
    $writeMcp = !$servers.Contains('codex_bridge')
    if ($writeMcp) {
        $servers['codex_bridge'] = $desired
    } else {
        $entry = $servers['codex_bridge']
        if ($entry -isnot [System.Collections.IDictionary] -or $entry.command -isnot [string] -or
            [IO.Path]::GetFileName($entry.command) -notin @('node', 'node.exe') -or
            $entry.args -isnot [array] -or $entry.args.Count -ne 5 -or
            $entry.args[0] -cne $desired.args[0] -or $entry.args[1] -ne $server -or
            $entry.url -or $entry.serverUrl -or $entry.httpUrl -or ($entry.type -and $entry.type -ne 'stdio')) {
            throw "Conflicting codex_bridge preserved in $mcpPath. Its launch command does not match this bridge installation."
        }
        foreach ($key in $desired.Keys) {
            if ((ConvertTo-Json -InputObject $entry[$key] -Depth 100 -Compress) -cne
                (ConvertTo-Json -InputObject $desired[$key] -Depth 100 -Compress)) {
                $entry[$key] = $desired[$key]
                $writeMcp = $true
            }
        }
    }

    foreach ($path in @((Split-Path $receipt), (Split-Path $agentPath))) {
        [void][IO.Directory]::CreateDirectory($path)
    }
    if ($writeMcp) { [IO.File]::WriteAllText($mcpPath, ($mcp | ConvertTo-Json -Depth 100) + "`n") }
    if ($writeAgent) { [IO.File]::WriteAllText($agentPath, $agentText) }
    if ($lastInstalled -ne $templateHash) { [IO.File]::WriteAllText($receipt, $templateHash) }
}

if ($writeHooks) {
    [void][IO.Directory]::CreateDirectory((Split-Path $hooksPath))
    [IO.File]::WriteAllText($hooksPath, ($hooks | ConvertTo-Json -Depth 100) + "`n")
}
if ($HooksOnly) {
    Write-Output "Configured only Codex hooks in $project. Review AGY Codex Bridge in Codex App Settings > Hooks."
    if (!(Test-Path -LiteralPath $stateRoot -PathType Container)) {
        Write-Output "Install the global bridge with the same state directory before using these hooks: $stateRoot"
    }
} elseif ($Global) {
    Write-Output 'Configured Antigravity for this Windows user.'
    Write-Output 'Start Antigravity from the folder you want Codex to work in: agy --agent codex-agy'
} else {
    Write-Output "Configured workspace: $project"
    Write-Output 'Start Antigravity in this workspace: agy --agent codex-agy'
    Write-Output 'Optional: review AGY Codex Bridge in Codex App Settings > Hooks for immediate task receipts.'
}
