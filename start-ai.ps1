param([switch]$NoBrowser, [switch]$RegisterWebLauncher)

$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
$bridgeUrl = 'http://127.0.0.1:17654/health'

function Test-AiBridge {
    try {
        $health = Invoke-RestMethod -Uri $bridgeUrl -TimeoutSec 2
        return $health.app -eq 'gongji-ai-bridge' -and $health.version -eq 1
    } catch {
        return $false
    }
}

try {
    if ($RegisterWebLauncher) {
        & (Join-Path $projectDir 'register-ai.ps1')
    }
    if (-not (Test-AiBridge)) {
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $nodeCommand) {
            throw 'Please install Node.js 22 or newer from https://nodejs.org, then run this launcher again.'
        }
        $nodeVersion = & $nodeCommand.Source --version
        if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) {
            throw 'Please upgrade to Node.js 22 or newer.'
        }
        $bridgeScript = Join-Path $projectDir 'ai-bridge.mjs'
        $bridgeProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList @("`"$bridgeScript`"") -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru
        $ready = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if (Test-AiBridge) { $ready = $true; break }
            if ($bridgeProcess.HasExited) { break }
            Start-Sleep -Milliseconds 250
        }
        if (-not $ready) {
            throw 'AI bridge did not start. Port 17654 may be in use by another application.'
        }
    }
    if (-not $NoBrowser) {
        $app = Get-ChildItem -LiteralPath $projectDir -Filter '*.html' | Select-Object -First 1
        if (-not $app) { throw 'The application HTML file is missing.' }
        Start-Process -FilePath $app.FullName
    }
    Write-Host 'AI bridge is ready.'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    if (-not $NoBrowser) { Read-Host 'Press Enter to close' }
    exit 1
}
