# dry-run-windows.ps1 — Windows dry-run test for prior setup
# Creates stub platform dirs matching real-world config formats,
# runs prior setup --dry-run, validates detection and planned actions.
#
# Safe: creates temp dirs, never modifies real configs.
# Usage: powershell -ExecutionPolicy Bypass -File dry-run-windows.ps1

param(
    [switch]$Verbose,
    [switch]$Cleanup  # Remove temp dirs after test
)

$ErrorActionPreference = "Stop"
$script:passed = 0
$script:failed = 0
$script:errors = @()

function Test-Assert($name, $condition, $detail) {
    if ($condition) {
        Write-Host "  PASS  $name" -ForegroundColor Green
        $script:passed++
    } else {
        Write-Host "  FAIL  $name" -ForegroundColor Red
        if ($detail) { Write-Host "        $detail" -ForegroundColor Yellow }
        $script:failed++
        $script:errors += $name
    }
}

# ─── Setup temp home directory ────────────────────────────────

$tempHome = Join-Path $env:TEMP "prior-dryrun-test-$(Get-Random)"
New-Item -ItemType Directory -Path $tempHome -Force | Out-Null
Write-Host "`nDry-run test home: $tempHome`n" -ForegroundColor Cyan

# ─── Create Claude Code stubs ────────────────────────────────
# Official: ~/.claude.json for MCP (user scope), ~/.claude/CLAUDE.md for rules
# Format per code.claude.com/docs/en/mcp:
#   { "mcpServers": { "server-name": { "url": "...", "headers": {...} } }, ...other settings... }
# .claude.json also contains non-MCP settings (numStartups, theme, etc.)

$claudeDir = Join-Path $tempHome ".claude"
New-Item -ItemType Directory -Path (Join-Path $claudeDir "skills") -Force | Out-Null

$claudeJson = @{
    numStartups = 42
    autoUpdaterStatus = "enabled"
    hasCompletedOnboarding = $true
    mcpServers = @{
        "existing-server" = @{
            url = "https://example.com/mcp"
            headers = @{ "X-Custom" = "value" }
        }
    }
} | ConvertTo-Json -Depth 5
Set-Content -Path (Join-Path $tempHome ".claude.json") -Value $claudeJson -Encoding UTF8

$claudeRules = @"
# My Project Rules

Always write tests.
Use TypeScript for all new code.
"@
Set-Content -Path (Join-Path $claudeDir "CLAUDE.md") -Value $claudeRules -Encoding UTF8

# Mock claude CLI — bat file that prints version string
$claudeBat = @"
@echo off
echo Claude Code v2.1.63
"@
$mockBinDir = Join-Path $tempHome "mock-bin"
New-Item -ItemType Directory -Path $mockBinDir -Force | Out-Null
Set-Content -Path (Join-Path $mockBinDir "claude.bat") -Value $claudeBat -Encoding ASCII

# ─── Create Cursor stubs ─────────────────────────────────────
# Official: ~/.cursor/mcp.json for global MCP
# Format per cursor.com/docs/context/mcp:
#   { "mcpServers": { "name": { "url": "...", "headers": {...} } } }  (HTTP)
#   { "mcpServers": { "name": { "command": "...", "args": [...], "env": {...} } } }  (stdio)
# No "type" field in Cursor configs.

$cursorDir = Join-Path $tempHome ".cursor"
New-Item -ItemType Directory -Path $cursorDir -Force | Out-Null

$cursorJson = @{
    mcpServers = @{
        "github" = @{
            url = "https://api.githubcopilot.com/mcp/"
            headers = @{ Authorization = "Bearer ghp_fake123" }
        }
        "filesystem" = @{
            command = "npx"
            args = @("-y", "@modelcontextprotocol/server-filesystem", "/tmp")
            env = @{}
        }
    }
} | ConvertTo-Json -Depth 5
Set-Content -Path (Join-Path $cursorDir "mcp.json") -Value $cursorJson -Encoding UTF8

# Mock cursor CLI
$cursorBat = @"
@echo off
echo 0.48.7
"@
Set-Content -Path (Join-Path $mockBinDir "cursor.bat") -Value $cursorBat -Encoding ASCII

# ─── Create Windsurf stubs ───────────────────────────────────
# Official: ~/.codeium/windsurf/mcp_config.json
# Format per docs.windsurf.com/windsurf/cascade/mcp:
#   HTTP: { "mcpServers": { "name": { "serverUrl": "https://..../mcp", "headers": {...} } } }
#   stdio: { "mcpServers": { "name": { "command": "...", "args": [...], "env": {...} } } }
# NOTE: Windsurf uses "serverUrl" for HTTP, NOT "url"
# Supports ${env:VAR} interpolation in command, args, env, serverUrl, url, headers

$windsurfDir = Join-Path (Join-Path $tempHome ".codeium") "windsurf"
$windsurfMemDir = Join-Path $windsurfDir "memories"
New-Item -ItemType Directory -Path $windsurfMemDir -Force | Out-Null

$windsurfJson = @{
    mcpServers = @{
        "notion" = @{
            serverUrl = "https://mcp.notion.com/mcp"
            headers = @{ Authorization = 'Bearer ${env:NOTION_TOKEN}' }
        }
    }
} | ConvertTo-Json -Depth 5
Set-Content -Path (Join-Path $windsurfDir "mcp_config.json") -Value $windsurfJson -Encoding UTF8

$windsurfRules = @"
# Windsurf Global Rules

Prefer functional programming style.
Always use meaningful variable names.
"@
Set-Content -Path (Join-Path $windsurfMemDir "global_rules.md") -Value $windsurfRules -Encoding UTF8

# ─── Verify stub structure before running ─────────────────────

Write-Host "=== Verifying stub file structure ===" -ForegroundColor Cyan

Test-Assert "Claude .claude.json exists" (Test-Path (Join-Path $tempHome ".claude.json"))
Test-Assert "Claude .claude dir exists" (Test-Path $claudeDir)
Test-Assert "Claude CLAUDE.md exists" (Test-Path (Join-Path $claudeDir "CLAUDE.md"))
Test-Assert "Claude .claude.json has mcpServers" ((Get-Content (Join-Path $tempHome ".claude.json") | ConvertFrom-Json).mcpServers -ne $null)
Test-Assert "Claude .claude.json preserves non-MCP fields" ((Get-Content (Join-Path $tempHome ".claude.json") | ConvertFrom-Json).numStartups -eq 42)

Test-Assert "Cursor .cursor dir exists" (Test-Path $cursorDir)
Test-Assert "Cursor mcp.json exists" (Test-Path (Join-Path $cursorDir "mcp.json"))
Test-Assert "Cursor mcp.json has mcpServers" ((Get-Content (Join-Path $cursorDir "mcp.json") | ConvertFrom-Json).mcpServers -ne $null)
$cursorServers = (Get-Content (Join-Path $cursorDir "mcp.json") -Raw | ConvertFrom-Json).mcpServers.PSObject.Properties.Name
Test-Assert "Cursor has 2 existing servers" ($cursorServers.Count -eq 2) "Got: $($cursorServers.Count) ($($cursorServers -join ', '))"

Test-Assert "Windsurf dir exists" (Test-Path $windsurfDir)
Test-Assert "Windsurf mcp_config.json exists" (Test-Path (Join-Path $windsurfDir "mcp_config.json"))
Test-Assert "Windsurf uses serverUrl" ((Get-Content (Join-Path $windsurfDir "mcp_config.json") | ConvertFrom-Json).mcpServers.notion.serverUrl -eq "https://mcp.notion.com/mcp")
Test-Assert "Windsurf global_rules.md exists" (Test-Path (Join-Path $windsurfMemDir "global_rules.md"))

# ─── Run prior setup --dry-run ────────────────────────────────

Write-Host "`n=== Running prior setup --dry-run ===" -ForegroundColor Cyan

$priorNode = Join-Path (Join-Path (Join-Path $PSScriptRoot "..") "..") "bin"
$priorNode = Join-Path $priorNode "prior.js"
$priorNode = (Resolve-Path $priorNode).Path

# Override HOME and PATH so setup detects our stubs
$env:HOME = $tempHome
$env:USERPROFILE = $tempHome
$origPath = $env:PATH
$env:PATH = "$mockBinDir;$env:PATH"

$outputFile = Join-Path $tempHome "setup-output.txt"
$errFile = Join-Path $tempHome "setup-error.txt"
$proc = Start-Process -FilePath node -ArgumentList "$priorNode setup --dry-run --non-interactive --api-key ask_test_dryrun_key_1234567890abcdef" -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outputFile -RedirectStandardError $errFile
$output = ""
if (Test-Path $outputFile) { $output += Get-Content $outputFile -Raw }
if (Test-Path $errFile) { $output += Get-Content $errFile -Raw }

# Restore env
$env:HOME = $null
$env:USERPROFILE = [Environment]::GetFolderPath("UserProfile")
$env:PATH = $origPath

if ($Verbose) {
    Write-Host "`n--- Raw output ---" -ForegroundColor DarkGray
    Write-Host $output
    Write-Host "--- End output ---`n" -ForegroundColor DarkGray
}

# ─── Validate dry-run output ─────────────────────────────────

Write-Host "`n=== Validating dry-run results ===" -ForegroundColor Cyan

# Platform detection
Test-Assert "Detected Claude Code" ($output -match "claude.code|Claude Code")
Test-Assert "Detected Cursor" ($output -match "[Cc]ursor")
Test-Assert "Detected Windsurf" ($output -match "[Ww]indsurf")
Test-Assert "Dry-run banner shown" ($output -match "dry.run")

# Verify no files were modified
$claudeJsonAfter = Get-Content (Join-Path $tempHome ".claude.json") -Raw
Test-Assert "Claude .claude.json unchanged" ($claudeJsonAfter.Trim() -eq $claudeJson.Trim())

$cursorJsonAfter = Get-Content (Join-Path $cursorDir "mcp.json") -Raw
Test-Assert "Cursor mcp.json unchanged" ($cursorJsonAfter.Trim() -eq $cursorJson.Trim())

$windsurfJsonAfter = Get-Content (Join-Path $windsurfDir "mcp_config.json") -Raw
Test-Assert "Windsurf mcp_config.json unchanged" ($windsurfJsonAfter.Trim() -eq $windsurfJson.Trim())

$claudeRulesAfter = Get-Content (Join-Path $claudeDir "CLAUDE.md") -Raw
Test-Assert "Claude CLAUDE.md unchanged" ($claudeRulesAfter.Trim() -eq $claudeRules.Trim())

$windsurfRulesAfter = Get-Content (Join-Path $windsurfMemDir "global_rules.md") -Raw
Test-Assert "Windsurf global_rules.md unchanged" ($windsurfRulesAfter.Trim() -eq $windsurfRules.Trim())

# ─── Cleanup ──────────────────────────────────────────────────

if ($Cleanup) {
    Remove-Item -Recurse -Force $tempHome
    Write-Host "`nCleaned up $tempHome" -ForegroundColor DarkGray
}

# ─── Summary ──────────────────────────────────────────────────

Write-Host "`n=== Results ===" -ForegroundColor Cyan
Write-Host "  Passed: $($script:passed)" -ForegroundColor Green
if ($script:failed -gt 0) {
    Write-Host "  Failed: $($script:failed)" -ForegroundColor Red
    foreach ($e in $script:errors) { Write-Host "    - $e" -ForegroundColor Red }
    exit 1
} else {
    Write-Host "  All tests passed!" -ForegroundColor Green
    exit 0
}
