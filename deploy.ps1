$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Get-Command node -ErrorAction SilentlyContinue

if (-not $node) {
  Write-Host "Node.js 22+ is required. Install Node, then run this script again." -ForegroundColor Red
  exit 1
}

$nodeVersion = (node --version 2>$null).TrimStart("v")
$major = [int]($nodeVersion -split "\.")[0]
if ($major -lt 22) {
  Write-Host "Node.js 22+ is required for SQLite (node:sqlite) -- found v$nodeVersion. Upgrade: https://nodejs.org" -ForegroundColor Red
  exit 1
}

Write-Host "Starting AntiPsyc on http://127.0.0.1:8717" -ForegroundColor Cyan
Write-Host "Node.js v$nodeVersion" -ForegroundColor DarkGray
Write-Host "Use Ctrl+C to stop the server." -ForegroundColor DarkGray
Set-Location $root
node .\src\server.js --http --mcp
