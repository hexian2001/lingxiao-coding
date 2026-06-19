<#
.SYNOPSIS
  凌霄剑域 — 便携版一键安装脚本 (Windows)
.DESCRIPTION
  自动检测平台 → 下载对应 release → 解压 → 添加到 PATH → 验证
.EXAMPLE
  # 一键安装（CMD / PowerShell）
  powershell -c "irm https://raw.githubusercontent.com/hexian2001/lingxiao-coding/main/scripts/install.ps1 | iex"
.EXAMPLE
  # 指定版本和安装目录
  .\install.ps1 -Version "v1.0.0" -InstallDir "$env:LOCALAPPDATA\lingxiao"
#>

param(
  [string]$Version = "",
  [string]$InstallDir = "$env:LOCALAPPDATA\lingxiao",
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
  # 用 HTTP 302 重定向拿版本号，不走 GitHub API，避免 rate limit
  # PowerShell 5.1 对 302 会抛异常，需要 catch 里拿 Location header
  try {
    $resp = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" -MaximumRedirection 0 -UseBasicParsing -ErrorAction Stop
    $redirectUrl = $resp.Headers.Location
  } catch {
    # PS 5.1 对 3xx 也抛异常，但 response 对象在异常里
    $redirectUrl = $_.Exception.Response.Headers.Location
  }
  if ($redirectUrl -match 'tag/(.+)$') {
    $Version = $Matches[1]
  }
  if ([string]::IsNullOrEmpty($Version)) {
    Write-Host "✗ 无法获取最新版本，请用 -Version 指定" -ForegroundColor Red
    exit 1
  }
}
Write-Host "★ 版本: $Version" -ForegroundColor Cyan

$versionNoV = $Version -replace '^v', ''

# ── 下载 ──────────────────────────────────────────────────────────────────────
# 尝试多种文件名：无版本号 → 带v前缀 → 不带v前缀
# tar.gz 全平台兼容，解压比 zip 快 3-5x
$downloadCandidates = @(
  "lingxiao-$target.tar.gz"
  "lingxiao-$Version-$target.tar.gz"
  "lingxiao-$versionNoV-$target.tar.gz"
)

$tempDir = New-Item -ItemType Directory -Force -Path "$env:TEMP\lingxiao-install-$(Get-Random)"

$archivePath = $null
foreach ($name in $downloadCandidates) {
  $url = "https://github.com/$Repo/releases/download/$Version/$name"
  $dest = Join-Path $tempDir.FullName $name
  Write-Host "▸ 尝试下载: $name"
  try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    $archivePath = $dest
    Write-Host "  ✓ 下载完成" -ForegroundColor Green
    break
  } catch {
    Write-Host "  ✗ 未找到，尝试下一个..." -ForegroundColor Yellow
  }
}

if (-not $archivePath) {
  Write-Host "✗ 下载失败，请检查版本号或网络" -ForegroundColor Red
  exit 1
}

# ── 解压 + 安装 ───────────────────────────────────────────────────────────────
Write-Host "▸ 解压到 $InstallDir..."
if (Test-Path $InstallDir) {
  $backup = "$InstallDir.bak"
  Write-Host "  ⚠ $InstallDir 已存在，备份到 $backup" -ForegroundColor Yellow
  if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
  Move-Item $InstallDir $backup
}

# Windows 10 1803+ 内置 tar，比 Expand-Archive 快很多
$staging = Join-Path $tempDir.FullName "staging"
New-Item -ItemType Directory -Force -Path $staging | Out-Null
tar xzf "$archivePath" -C "$staging"

# 找到 lingxiao 目录
$pkgDir = $staging
$innerLingxiaoDir = Join-Path $staging "lingxiao"
if (Test-Path $innerLingxiaoDir) {
  $pkgDir = $innerLingxiaoDir
}

# 验证包内有关键文件
$nodeExe = Join-Path $pkgDir "node.exe"
if (-not (Test-Path $nodeExe)) {
  Write-Host "✗ 解压后未找到 node.exe，包可能损坏" -ForegroundColor Red
  exit 1
}

# 移动到最终安装目录
New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
Move-Item $pkgDir $InstallDir
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
Write-Host "运行 `lingxiao` 启动"
Write-Host ""
Write-Host "首次使用浏览器功能时会自动下载 Chromium（约 300MB）"

# 清理临时文件
Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
