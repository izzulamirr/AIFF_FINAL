# Run this on the OTHER computer to pick up this project with the same
# context Claude Code has been using here.
#
# What actually carries the context across machines is CLAUDE.md at the repo
# root (committed to git) -- Claude Code auto-loads it into every session
# opened in this project, on any machine. This script just makes sure that
# file (and the rest of the repo) is present and current before you open it.
#
# Usage:
#   .\scripts\sync-on-new-machine.ps1 -RepoUrl "https://github.com/beau02/AIFF.git" -TargetDir "D:\AIFF"
#
# If the repo is already cloned at -TargetDir, this just pulls latest main
# and reinstalls dependencies; it will not overwrite uncommitted local changes.

param(
    [string]$RepoUrl = "https://github.com/beau02/AIFF.git",
    [string]$TargetDir = "D:\AIFF"
)

$ErrorActionPreference = "Stop"

if (Test-Path (Join-Path $TargetDir ".git")) {
    Write-Host "Repo already present at $TargetDir -- pulling latest main." -ForegroundColor Cyan
    Push-Location $TargetDir
    git fetch origin
    git status --short
    git pull origin main
    Pop-Location
} else {
    Write-Host "Cloning $RepoUrl into $TargetDir" -ForegroundColor Cyan
    git clone $RepoUrl $TargetDir
    Push-Location $TargetDir
    Pop-Location
}

Push-Location $TargetDir

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "pnpm not found -- enabling via corepack." -ForegroundColor Yellow
    corepack enable
}
corepack use pnpm@latest
pnpm install

Write-Host "`nDone. Now:" -ForegroundColor Green
Write-Host "  1. Copy apps/web/.env.local and apps/worker/.env from the original machine (or apps/*/.env.example if starting fresh -- these hold Supabase/Anthropic credentials and are gitignored, so they never transferred via git)."
Write-Host "  2. Open this folder ($TargetDir) in Claude Code -- CLAUDE.md at the repo root loads automatically and carries the project context documented there."
Write-Host "  3. Session-specific memory (user preferences, feedback from past sessions) lives per-machine under ~/.claude/projects/<hash>/memory/ and does not transfer automatically -- CLAUDE.md is the portable part."

Pop-Location
