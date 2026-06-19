<#
.SYNOPSIS
  凌霄剑域 — 便携版一键安装脚本 (Windows)
.DESCRIPTION
  自动检测平台 → 下载对应 release → 解压 → 添加到 PATH → 验证
.EXAMPLE
  # 一键安装（PowerShell）
  irm https://raw.githubusercontent.com/hexian2001/lingxiao-coding/main/scripts/install.ps1 | iex
.EXAMPLE
  # 指定版本和安装目录
  .\install.ps1 -Version "v0.3.9" -InstallDir "C:\lingxiao"
#>

param(
  [string]$Version = "",
  [string]$InstallDir = "C:\lingxiao",
  [string]$Repo = "hexian2001/lingxiao-coding"
)

$ErrorActionPreference = "Stop"

# ── 平台检测 ──────────────────────────────────────────────────────────────────
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
if ($arch -ne "x64") {
  Write-Host "✗ 仅支持 x64 架构" -ForegroundColor Red
  exit 1
}
$target = "win32-$arch"
Write-Host "★ 检测到平台: $target" -ForegroundColor Cyan

# ── 获取版本 ──────────────────────────────────────────────────────────────────
if ([string]::IsNullOrEmpty($Version)) {
  Write-Host "▸ 获取最新版本..."
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
  $Version = $release.tag_name
  if ([string]::IsNullOrEmpty($Version)) {
    Write-Host "✗ 无法获取最新版本，请用 -Version 指定" -ForegroundColor Red
    exit 1
  }
}
Write-Host "★ 版本: $Version" -ForegroundColor Cyan

# ── 下载 ──────────────────────────────────────────────────────────────────────
$archiveName = "lingxiao-$Version-$target.zip"
$downloadUrl = "https://github.com/$Repo/releases/download/$Version/$archiveName"
$tempDir = New-Item -ItemType Directory -Force -Path "$env:TEMP\lingxiao-install-$(Get-Random)"
$archivePath = Join-Path $tempDir.FullName $archiveName

Write-Host "▸ 下载: $downloadUrl"
try {
  Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -UseBasicParsing
} catch {
  # 尝试不带 v 前缀
  $versionNoV = $Version -replace '^v', ''
  $archiveNameAlt = "lingxiao-$versionNoV-$target.zip"
  $downloadUrlAlt = "https://github.com/$Repo/releases/download/$Version/$archiveNameAlt"
  Write-Host "▸ 重试: $downloadUrlAlt"
  Invoke-WebRequest -Uri $downloadUrlAlt -OutFile (Join-Path $tempDir.FullName $archiveNameAlt) -UseBasicParsing
  $archivePath = Join-Path $tempDir.FullName $archiveNameAlt
}
Write-Host "  ✓ 下载完成" -ForegroundColor Green

# ── 解压 + 安装 ───────────────────────────────────────────────────────────────
Write-Host "▸ 解压到 $InstallDir..."
if (Test-Path $InstallDir) {
  $backup = "$InstallDir.bak"
  Write-Host "  ⚠ $InstallDir 已存在，备份到 $backup" -ForegroundColor Yellow
  if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
  Move-Item $InstallDir $backup
}

Expand-Archive -Path $archivePath -DestinationPath $InstallDir -Force

# 如果解压出来多一层 lingxiao/ 目录，提上来
$innerDir = Join-Path $InstallDir "lingxiao"
if (Test-Path $innerDir) {
  Get-ChildItem $innerDir | ForEach-Object { Move-Item $_.FullName $InstallDir -Force }
  Remove-Item $innerDir -Recurse -Force
}
Write-Host "  ✓ 解压完成" -ForegroundColor Green

# ── 添加到 PATH ───────────────────────────────────────────────────────────────
Write-Host "▸ 添加到用户 PATH..."
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
  Write-Host "  ✓ 已添加 $InstallDir 到用户 PATH" -ForegroundColor Green
  Write-Host "  ℹ 请重新打开终端使 PATH 生效" -ForegroundColor Yellow
} else {
  Write-Host "  ✓ $InstallDir 已在 PATH 中" -ForegroundColor Green
}

# ── 验证 ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  ✓ 凌霄剑域安装完成                                          ║" -ForegroundColor Green
Write-Host "║  版本: $Version"
Write-Host "║  路径: $InstallDir"
Write-Host "║  命令: lingxiao (重新打开终端后生效)"
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "运行 \`lingxiao doctor\` 验证环境"
Write-Host ""
Write-Host "首次使用浏览器功能时会自动下载 Chromium（约 300MB）"

# 清理临时文件
Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
