param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$protocolKey = 'Software\Classes\gongji-ai'
$ownerName = 'gongji-work-record'
$launchScript = Join-Path $PSScriptRoot 'start-ai.ps1'
$shellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$existing = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($protocolKey)
try {
    if ($existing -and $existing.GetValue('GongjiOwner') -ne $ownerName) {
        throw 'The gongji-ai protocol belongs to another application. No changes were made.'
    }
    if ($Uninstall -and $existing -and $existing.GetValue('GongjiProject') -ne $PSScriptRoot) {
        throw 'The web launcher belongs to another project folder. Run its uninstall command instead.'
    }
} finally {
    if ($existing) { $existing.Dispose() }
}

if ($Uninstall) {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($protocolKey, $false)
    Write-Host 'Gongji web launcher removed for the current user.'
    exit 0
}
if (-not (Test-Path -LiteralPath $launchScript -PathType Leaf)) {
    throw 'start-ai.ps1 is missing. Keep the launcher files together.'
}

# The URI is deliberately excluded from the command: links can only start this fixed script.
$command = '"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -NoBrowser' -f $shellPath, $launchScript
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($protocolKey)
try {
    $key.SetValue('', 'URL:Gongji AI')
    $key.SetValue('URL Protocol', '')
    $key.SetValue('GongjiOwner', $ownerName)
    $key.SetValue('GongjiProject', $PSScriptRoot)
    $commandKey = $key.CreateSubKey('shell\open\command')
    try { $commandKey.SetValue('', $command) }
    finally { $commandKey.Dispose() }
} finally {
    $key.Dispose()
}
Write-Host 'Gongji web launcher is ready for the current user.'
