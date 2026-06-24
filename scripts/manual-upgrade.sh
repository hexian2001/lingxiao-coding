#!/bin/bash
# 凌霄剑域 - 手动强制更新脚本 (Linux/macOS)
# 使用方法：bash /tmp/lingxiao-upgrade-linux.sh

set -e  # 遇到错误立即退出

echo "======================================"
echo "凌霄剑域 - 强制更新脚本"
echo "======================================"
echo ""

# 1. 检测安装目录
echo "▸ 检测安装目录..."
LINGXIAO_BIN=$(which lingxiao 2>/dev/null || echo "")
if [ -z "$LINGXIAO_BIN" ]; then
    echo "✗ 未找到 lingxiao 命令，请手动指定安装目录："
    echo "  cd /path/to/lingxiao-coding"
    echo "  然后执行本脚本中的命令"
    exit 1
fi

LINGXIAO_REAL=$(readlink -f "$LINGXIAO_BIN" 2>/dev/null || realpath "$LINGXIAO_BIN" 2>/dev/null || echo "$LINGXIAO_BIN")
INSTALL_DIR=$(dirname "$(dirname "$LINGXIAO_REAL")")

echo "  安装目录: $INSTALL_DIR"
echo ""

# 2. 进入安装目录
cd "$INSTALL_DIR"

# 3. 检查是否是 git 仓库
if [ ! -d ".git" ]; then
    echo "✗ 当前目录不是 git 仓库，无法自动更新"
    exit 1
fi

# 4. 强制拉取最新代码
echo "▸ 拉取最新代码..."
git fetch --all --tags --prune
echo "  ✓ 拉取完成"
echo ""

# 5. 强制重置到最新版本（可选：改成指定 tag，如 v1.0.4）
echo "▸ 强制重置到 origin/main（将丢弃所有本地修改）..."
git reset --hard origin/main
# 如果要重置到指定版本，取消下面一行的注释：
# git reset --hard v1.0.4
echo "  ✓ 重置完成"
echo ""

# 6. 清理未追踪文件
echo "▸ 清理未追踪文件..."
git clean -fd
echo "  ✓ 清理完成"
echo ""

# 7. 删除旧的构建产物
echo "▸ 清理旧的构建产物..."
rm -rf dist/
echo "  ✓ dist/ 已删除"
echo ""

# 8. 强制重新安装依赖
echo "▸ 安装依赖（强制重新安装）..."
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --force
echo "  ✓ 依赖安装完成"
echo ""

# 9. 重新构建
echo "▸ 构建项目..."
npm run build
echo "  ✓ 构建完成"
echo ""

# 10. 刷新全局链接
echo "▸ 刷新全局链接..."
if npm link; then
    echo "  ✓ 链接刷新完成"
else
    echo "  ⚠ npm link 失败，可能需要 sudo 权限："
    echo "    sudo npm link"
fi
echo ""

# 11. 验证版本
echo "======================================"
echo "✓ 更新完成！"
echo "======================================"
echo ""
NEW_VERSION=$(lingxiao --version 2>/dev/null || echo "未知")
echo "当前版本: $NEW_VERSION"
echo "安装目录: $INSTALL_DIR"
echo ""
echo "如需回滚到旧版本，执行："
echo "  cd $INSTALL_DIR"
echo "  git log --oneline -10"
echo "  git reset --hard <commit-hash>"
echo "  npm install && npm run build"
echo ""
