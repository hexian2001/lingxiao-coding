#!/bin/sh
# 凌霄剑域 — 便携版一键安装脚本 (macOS / Linux)
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/hexian2001/lingxiao-coding/main/scripts/install.sh | sh
#
# 或先下载再执行：
#   sh install.sh [--version v1.0.0] [--install-dir ~/.lingxiao]
#
# 功能：自动检测平台 → 下载对应 release → 解压 → 创建 symlink → 验证

set -e

# ── 默认配置 ──────────────────────────────────────────────────────────────────
REPO="hexian2001/lingxiao-coding"
INSTALL_DIR="${HOME}/.lingxiao"
BIN_DIR="${HOME}/.local/bin"
VERSION=""  # 空字符串 = 自动获取最新 release tag

# ── 参数解析 ──────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --help|-h)
      echo "凌霄剑域便携版安装脚本"
      echo ""
      echo "用法: sh install.sh [选项]"
      echo ""
      echo "选项:"
      echo "  --version <tag>      指定版本 (如 v1.0.0)，默认最新"
      echo "  --install-dir <path> 安装目录 (默认: ~/.lingxiao)"
      echo "  --bin-dir <path>     symlink 目录 (默认: ~/.local/bin)"
      echo "  --help               显示帮助"
      exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# ── 平台检测 ──────────────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux" ;;
  *) echo "✗ 不支持的操作系统: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "✗ 不支持的架构: $ARCH"; exit 1 ;;
esac

TARGET="${PLATFORM}-${ARCH}"
echo "★ 检测到平台: ${TARGET}"

# 检查是否有对应的 release 产物
VALID_TARGETS="linux-x64 linux-arm64 darwin-arm64 win32-x64"
if ! echo " $VALID_TARGETS " | grep -q " ${TARGET} "; then
  echo "✗ 当前平台 ${TARGET} 暂无预编译包"
  echo "  支持的平台:"
  echo "    linux-x64    (Ubuntu / Debian / CentOS 等 x86_64 Linux)"
  echo "    linux-arm64  (树莓派 / ARM 服务器)"
  echo "    darwin-arm64 (macOS Apple Silicon M1/M2/M3/M4)"
  echo "    win32-x64    (Windows x64 — 请使用 PowerShell 脚本安装)"
  exit 1
fi

# ── 获取版本 ──────────────────────────────────────────────────────────────────
if [ -z "$VERSION" ]; then
  echo "▸ 获取最新版本..."
  # 用 HTTP 302 重定向拿版本号，不走 GitHub API，避免 rate limit
  VERSION=$(curl -sS -o /dev/null -w '%{redirect_url}' "https://github.com/${REPO}/releases/latest" 2>/dev/null | sed 's|.*/tag/||')
  if [ -z "$VERSION" ]; then
    echo "✗ 无法获取最新版本，请用 --version 指定"
    exit 1
  fi
fi
echo "★ 版本: ${VERSION}"

# 版本号去掉 v 前缀
VERSION_NO_V="${VERSION#v}"

# ── 下载 ──────────────────────────────────────────────────────────────────────
# 尝试多种文件名 + 两种归档格式（tar.gz 优先，zip 兼容旧 release）
DOWNLOAD_CANDIDATES=""
for NAME in \
  "lingxiao-${TARGET}.tar.gz" \
  "lingxiao-${VERSION}-${TARGET}.tar.gz" \
  "lingxiao-${VERSION_NO_V}-${TARGET}.tar.gz" \
  "lingxiao-${TARGET}.zip" \
  "lingxiao-${VERSION}-${TARGET}.zip" \
  "lingxiao-${VERSION_NO_V}-${TARGET}.zip"
do
  DOWNLOAD_CANDIDATES="${DOWNLOAD_CANDIDATES} https://github.com/${REPO}/releases/download/${VERSION}/${NAME}"
done

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

ARCHIVE_FILE=""
for URL in $DOWNLOAD_CANDIDATES; do
  FNAME="$(basename "$URL")"
  echo "▸ 尝试下载: ${FNAME}"
  if curl -fSL -o "${TMP_DIR}/${FNAME}" "$URL" 2>/dev/null; then
    ARCHIVE_FILE="${TMP_DIR}/${FNAME}"
    echo "  ✓ 下载完成"
    break
  fi
done

if [ -z "$ARCHIVE_FILE" ]; then
  echo "✗ 下载失败，请检查版本号或网络"
  exit 1
fi

# ── 解压 ──────────────────────────────────────────────────────────────────────
echo "▸ 解压..."
STAGING="${TMP_DIR}/staging"
mkdir -p "$STAGING"

case "$ARCHIVE_FILE" in
  *.tar.gz)
    tar xzf "$ARCHIVE_FILE" -C "$STAGING"
    ;;
  *.zip)
    # 外层 zip：先解 zip，再看里面有没有 tar.gz
    unzip -q "$ARCHIVE_FILE" -d "$STAGING" 2>/dev/null || tar xf "$ARCHIVE_FILE" -C "$STAGING" 2>/dev/null || {
      echo "✗ 无法解压 zip 文件"
      exit 1
    }
    # 检查是否有内层 tar.gz
    INNER_TAR=$(find "$STAGING" -name '*.tar.gz' -print -quit 2>/dev/null)
    if [ -n "$INNER_TAR" ]; then
      echo "  ℹ 检测到内层 tar.gz，二次解压..."
      INNER_STAGING="${TMP_DIR}/inner_staging"
      mkdir -p "$INNER_STAGING"
      tar xzf "$INNER_TAR" -C "$INNER_STAGING"
      STAGING="$INNER_STAGING"
    fi
    ;;
  *)
    echo "✗ 未知归档格式: $ARCHIVE_FILE"
    exit 1
    ;;
esac

# 找到 lingxiao 目录
PKG_DIR="$STAGING"
if [ -d "$STAGING/lingxiao" ]; then
  PKG_DIR="$STAGING/lingxiao"
fi

# 验证包内有关键文件
if [ ! -f "$PKG_DIR/node" ] && [ ! -f "$PKG_DIR/node.exe" ]; then
  echo "✗ 解压后未找到 node 二进制，包可能损坏"
  exit 1
fi

# ── 安装 ──────────────────────────────────────────────────────────────────────
echo "▸ 安装到 ${INSTALL_DIR}..."
if [ -d "$INSTALL_DIR" ]; then
  echo "  ⚠ ${INSTALL_DIR} 已存在，备份到 ${INSTALL_DIR}.bak"
  rm -rf "${INSTALL_DIR}.bak"
  mv "$INSTALL_DIR" "${INSTALL_DIR}.bak"
fi

mkdir -p "$(dirname "$INSTALL_DIR")"
cp -a "$PKG_DIR" "$INSTALL_DIR"
echo "  ✓ 安装完成"

# ── 创建 symlink ──────────────────────────────────────────────────────────────
echo "▸ 创建命令链接..."
mkdir -p "$BIN_DIR"
ln -sf "${INSTALL_DIR}/lingxiao" "${BIN_DIR}/lingxiao"
echo "  ✓ ${BIN_DIR}/lingxiao → ${INSTALL_DIR}/lingxiao"

# 检查 BIN_DIR 是否在 PATH 中
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    echo ""
    echo "  ⚠ ${BIN_DIR} 不在 PATH 中，请添加以下内容到你的 shell 配置："
    echo "    export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac

# ── 验证 ──────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✓ 凌霄剑域安装完成                                         ║"
echo "║  版本: ${VERSION}"
echo "║  路径: ${INSTALL_DIR}"
echo "║  命令: ${BIN_DIR}/lingxiao"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "运行 \`lingxiao doctor\` 验证环境"
echo ""
echo "首次使用浏览器功能时会自动下载 Chromium（约 300MB）"

# ── npm link 全局注册 ──────────────────────────────────────────────────────────
if command -v npm &>/dev/null; then
  echo "▸ npm link 全局注册..."
  (cd "$INSTALL_DIR" && npm link 2>/dev/null && echo "  ✓ npm link 完成，可直接使用 lingxiao 命令") || \
    echo "  ⚠ npm link 失败，请手动运行: cd $INSTALL_DIR && npm link"
else
  echo ""
  echo "  ⚠ 未检测到 npm，无法全局注册"
  echo "  请安装 Node.js: https://nodejs.org/"
  echo "  安装后手动运行: cd $INSTALL_DIR && npm link"
fi
