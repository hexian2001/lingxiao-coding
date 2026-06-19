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

# ── TLS 兼容 ──────────────────────────────────────────────────────────────────
# PS 5.1 默认 TLS 1.0，GitHub 要求 TLS 1.2+
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

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
  # 优先用 GitHub API（最可靠），回退到跟随重定向
  try {
    $apiResp = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
    $Version = $apiResp.tag_name
  } catch {
    Write-Host "  ℹ GitHub API 不可用，尝试重定向方式..." -ForegroundColor Yellow
    try {
      $resp = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" -UseBasicParsing -MaximumRedirection 10
      $finalUrl = $resp.BaseResponse.ResponseUri.AbsoluteUri
      if ($finalUrl -match 'tag/(.+)$') {
        $Version = $Matches[1]
      }
    } catch {
      try {
        $resp = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" -MaximumRedirection 0 -UseBasicParsing
        $redirectUrl = $resp.Headers.Location
        if ($redirectUrl -match 'tag/(.+)$') { $Version = $Matches[1] }
      } catch {
        $redirectUrl = $_.Exception.Response.Headers.Location
        if ($redirectUrl -match 'tag/(.+)$') { $Version = $Matches[1] }
      }
    }
  }
  if ([string]::IsNullOrEmpty($Version)) {
    Write-Host "✗ 无法获取最新版本，请用 -Version 指定" -ForegroundColor Red
    exit 1
  }
}
Write-Host "★ 版本: $Version" -ForegroundColor Cyan

$versionNoV = $Version -replace '^v', ''

# ── 下载 ──────────────────────────────────────────────────────────────────────
# 尝试多种文件名 + 两种归档格式（tar.gz 优先，zip 兼容旧 release）
$downloadCandidates = @(
  "lingxiao-$target.tar.gz"
  "lingxiao-$Version-$target.tar.gz"
  "lingxiao-$versionNoV-$target.tar.gz"
  "lingxiao-$target.zip"
  "lingxiao-$Version-$target.zip"
  "lingxiao-$versionNoV-$target.zip"
)

$tempDir = New-Item -ItemType Directory -Force -Path "$env:TEMP\lingxiao-install-$(Get-Random)"

$archivePath = $null
foreach ($name in $downloadCandidates) {
  $url = "https://github.com/$Repo/releases/download/$Version/$name"
  $dest = Join-Path $tempDir.FullName $name
  Write-Host "▸ 尝试下载: $name"
  # 优先用 curl.exe（Windows 10+ 自带，比 Invoke-WebRequest 快很多）
  $curlExe = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curlExe) {
    & curl.exe -fSL -o "$dest" "$url" 2>$null
    if ($LASTEXITCODE -eq 0 -and (Test-Path $dest)) {
      $archivePath = $dest
      Write-Host "  ✓ 下载完成" -ForegroundColor Green
      break
    }
  } else {
    try {
      # 回退到 .NET WebClient（比 Invoke-WebRequest 快，无 HTML 解析开销）
      $wc = New-Object System.Net.WebClient
      $wc.DownloadFile($url, $dest)
      $archivePath = $dest
      Write-Host "  ✓ 下载完成" -ForegroundColor Green
      break
    } catch {
      Write-Host "  ✗ 未找到，尝试下一个..." -ForegroundColor Yellow
    }
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

# 自适应解压：tar.gz 直接解，zip 先解外层再看有没有内层 tar.gz
$staging = Join-Path $tempDir.FullName "staging"
New-Item -ItemType Directory -Force -Path $staging | Out-Null

if ($archivePath -match '\.tar\.gz$') {
  tar xzf "$archivePath" -C "$staging"
} elseif ($archivePath -match '\.zip$') {
  # 先尝试用内置 tar 解 zip（Windows 10 1803+ 支持），回退到 Expand-Archive
  try {
    tar xf "$archivePath" -C "$staging" 2>$null
  } catch {
    Expand-Archive -Path "$archivePath" -DestinationPath $staging -Force
  }
  # 检查是否有内层 tar.gz
  $innerTar = Get-ChildItem -Path $staging -Filter "*.tar.gz" -Recurse | Select-Object -First 1
  if ($innerTar) {
    Write-Host "  ℹ 检测到内层 tar.gz，二次解压..." -ForegroundColor Yellow
    $innerStaging = Join-Path $tempDir.FullName "inner_staging"
    New-Item -ItemType Directory -Force -Path $innerStaging | Out-Null
    tar xzf "$($innerTar.FullName)" -C "$innerStaging"
    $staging = $innerStaging
  }
} else {
  Write-Host "✗ 未知归档格式: $archivePath" -ForegroundColor Red
  exit 1
}

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

# ── npm link 全局注册 ──────────────────────────────────────────────────────────
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if ($npmCmd) {
  Write-Host "▸ npm link 全局注册..."
  Push-Location $InstallDir
  try {
    npm link 2>$null
    Write-Host "  ✓ npm link 完成，可直接使用 lingxiao 命令" -ForegroundColor Green
  } catch {
    Write-Host "  ⚠ npm link 失败，请手动运行: cd $InstallDir && npm link" -ForegroundColor Yellow
  } finally {
    Pop-Location
  }
} else {
  Write-Host ""
  Write-Host "  ⚠ 未检测到 npm，无法全局注册" -ForegroundColor Yellow
  Write-Host "  请安装 Node.js: https://nodejs.org/"
  Write-Host "  安装后手动运行: cd $InstallDir && npm link"
}
