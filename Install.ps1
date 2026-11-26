#Requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'Workspace')]
param(
    [Parameter(ParameterSetName = 'Workspace')]
    [string]$Workspace = (Get-Location).Path,
    [Parameter(Mandatory, ParameterSetName = 'Global')]
    [switch]$Global,
    [Parameter(ParameterSetName = 'Workspace')]
    [switch]$HooksOnly,
    [ValidateNotNullOrEmpty()]
    [string]$StateDirectory,
    [ValidateSet('desktop', 'direct')]
    [string]$DefaultMode
)

$ErrorActionPreference = 'Stop'
$node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$node) { throw 'Cannot find node.exe on PATH. Install Node.js and open a new PowerShell window.' }

[string[]]$installerArgs = if ($Global) { @('--global') } else { @('--workspace', $Workspace) }
if ($HooksOnly) { $installerArgs += '--hooks-only' }
if ($PSBoundParameters.ContainsKey('StateDirectory')) {
    $state = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($StateDirectory)
    $installerArgs += @('--state-directory', $state)
}
if ($PSBoundParameters.ContainsKey('DefaultMode')) {
    $installerArgs += @('--default-mode', $DefaultMode.ToLowerInvariant())
}
$PSNativeCommandUseErrorActionPreference = $false
& $node.Source (Join-Path $PSScriptRoot 'install.mjs') @installerArgs
exit $LASTEXITCODE
