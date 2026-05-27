# Kora Windows Installer
# Usage: irm https://raw.githubusercontent.com/korabot/korabot/main/install/install.ps1 | iex

$ErrorActionPreference = "Stop"

function Write-Banner {
    Write-Host @"
    _       _ _       ____        _   
   / \   __| (_) __ _| __ )  ___ | |_ 
  / _ \ / _` | |/ _` |  _ \ / _ \| __|
 / ___ \ (_| | | (_| | |_) | (_) | |_ 
/_/   \_\__,_|_|\__,_|____/ \___/ \__|
"@ -ForegroundColor Cyan
    Write-Host "  Local-first multi-channel AI Agent runtime" -ForegroundColor White
    Write-Host ""
}

function Test-Command($Command) {
    try { Get-Command $Command -ErrorAction Stop; return $true }
    catch { return $false }
}

function Check-Dependencies {
    if (-not (Test-Command "node")) {
        Write-Host "[ERROR] Node.js is required. Install from https://nodejs.org (v20+)" -ForegroundColor Red
        Write-Host "  Or: winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
        exit 1
    }

    $nodeVersion = (node -v).TrimStart("v").Split(".")[0]
    if ([int]$nodeVersion -lt 20) {
        Write-Host "[ERROR] Node.js v20+ required (found v$nodeVersion)" -ForegroundColor Red
        exit 1
    }
    Write-Host "[INFO] Node.js $(node -v) detected" -ForegroundColor Green

    if (-not (Test-Command "npm")) {
        Write-Host "[ERROR] npm is required" -ForegroundColor Red
        exit 1
    }
    Write-Host "[INFO] npm $(npm -v) detected" -ForegroundColor Green

}

function Install-Kora {
    Write-Host "[INFO] Installing Kora..." -ForegroundColor Green

    try {
        npm install -g korabot@latest 2>$null
    } catch {
        Write-Host "[INFO] Installing from source..." -ForegroundColor Green
        $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
        $projectDir = Split-Path -Parent $scriptDir
        Push-Location $projectDir
        npm install
        npm run build
        npm link
        Pop-Location
    }

    Write-Host "[INFO] Kora installed successfully" -ForegroundColor Green
}

Write-Banner
Check-Dependencies
Install-Kora

Write-Host ""
Write-Host "[INFO] Installation complete!" -ForegroundColor Green
Write-Host ""

$runSetup = Read-Host "  Run setup wizard now? [Y/n]"
if ($runSetup -notmatch "^[Nn]$") {
    kora setup
} else {
    Write-Host ""
    Write-Host "[INFO] Run 'kora setup' when you're ready to configure." -ForegroundColor Green
    Write-Host "[INFO] Run 'kora doctor' to check your environment." -ForegroundColor Green
}
