# 凌霄剑域 - 手动强制更新脚本 (Windows PowerShell)
# 使用方法：右键 PowerShell 以管理员身份运行，然后执行：
#   powershell -ExecutionPolicy Bypass -File C:\tmp\lingxiao-upgrade-windows.ps1

$ErrorActionPreference = "Stop"  # 遇到错误立即退出

Write-Host "======================================"
Write-Host "凌霄剑域 - 强制更新脚本"
Write-Host "======================================"
Write-Host ""

# 1. 检测安装目录
Write-Host "▸ 检测安装目录..." -ForegroundColor Cyan
$LingxiaoBin = (Get-Command lingxiao -ErrorAction SilentlyContinue).Source
if (-not $LingxiaoBin) {
    Write-Host "✗ 未找到 lingxiao 命令，请手动指定安装目录：" -ForegroundColor Red
    Write-Host "  cd C:\path\to\lingxiao-coding"
    Write-Host "  然后手动执行本脚本中的命令"
    exit 1
}

# 追踪符号链接到真实路径
$LingxiaoReal = $LingxiaoBin
if (Test-Path $LingxiaoBin -PathType Leaf) {
    # 如果是 .cmd 文件，读取内容找到真实路径
    if ($LingxiaoBin -match '\.cmd$') {
        $Content = Get-Content $LingxiaoBin -Raw
        if ($Content -match '"([^"]+node\.exe)"') {
            $NodePath = $Matches[1]
            $InstallDir = Split-Path (Split-Path $NodePath -Parent) -Parent
        } else {
            $InstallDir = Split-Path (Split-Path $LingxiaoBin -Parent) -Parent
        }
    } else {
        $InstallDir = Split-Path (Split-Path $LingxiaoBin -Parent) -Parent
    }
} else {
    $InstallDir = Split-Path (Split-Path $LingxiaoBin -Parent) -Parent
}

Write-Host "  安装目录: $InstallDir" -ForegroundColor Gray
Write-Host ""

# 2. 进入安装目录
Set-Location $InstallDir

# 3. 检查是否是 git 仓库
if (-not (Test-Path ".git" -PathType Container)) {
    Write-Host "✗ 当前目录不是 git 仓库，无法自动更新" -ForegroundColor Red
    exit 1
}

# 4. 强制拉取最新代码
Write-Host "▸ 拉取最新代码..." -ForegroundColor Cyan
git fetch --all --tags --prune
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ git fetch 失败" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ 拉取完成" -ForegroundColor Green
Write-Host ""

# 5. 强制重置到最新版本
Write-Host "▸ 强制重置到 origin/main（将丢弃所有本地修改）..." -ForegroundColor Cyan
git reset --hard origin/main
# 如果要重置到指定版本，取消下面一行的注释：
# git reset --hard v1.0.4
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ git reset 失败" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ 重置完成" -ForegroundColor Green
Write-Host ""

# 6. 清理未追踪文件
Write-Host "▸ 清理未追踪文件..." -ForegroundColor Cyan
git clean -fd
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ⚠ git clean 失败（可忽略）" -ForegroundColor Yellow
}
Write-Host "  ✓ 清理完成" -ForegroundColor Green
Write-Host ""

# 7. 删除旧的构建产物
Write-Host "▸ 清理旧的构建产物..." -ForegroundColor Cyan
if (Test-Path "dist" -PathType Container) {
    Remove-Item -Recurse -Force "dist"
}
Write-Host "  ✓ dist/ 已删除" -ForegroundColor Green
Write-Host ""

# 8. 强制重新安装依赖
Write-Host "▸ 安装依赖（强制重新安装）..." -ForegroundColor Cyan
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = "1"
npm install --force
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ npm install 失败" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ 依赖安装完成" -ForegroundColor Green
Write-Host ""

# 9. 重新构建
Write-Host "▸ 构建项目..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ npm run build 失败" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ 构建完成" -ForegroundColor Green
Write-Host ""

# 10. 刷新全局链接
Write-Host "▸ 刷新全局链接..." -ForegroundColor Cyan
npm link
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ 链接刷新完成" -ForegroundColor Green
} else {
    Write-Host "  ⚠ npm link 失败，可能需要管理员权限" -ForegroundColor Yellow
    Write-Host "    请以管理员身份运行 PowerShell 后执行: npm link"
}
Write-Host ""

# 11. 验证版本
Write-Host "======================================"
Write-Host "✓ 更新完成！" -ForegroundColor Green
Write-Host "======================================"
Write-Host ""
$NewVersion = & lingxiao --version 2>$null
if ($NewVersion) {
    Write-Host "当前版本: $NewVersion"
} else {
    Write-Host "当前版本: 未知"
}
Write-Host "安装目录: $InstallDir"
Write-Host ""
Write-Host "如需回滚到旧版本，执行："
Write-Host "  cd $InstallDir"
Write-Host "  git log --oneline -10"
Write-Host "  git reset --hard <commit-hash>"
Write-Host "  npm install && npm run build"
Write-Host ""
