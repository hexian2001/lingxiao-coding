#!/bin/sh
# 凌霄剑域 — 便携版一键安装脚本 (macOS / Linux)
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/hexian2001/lingxiao-coding/main/scripts/install.sh | sh
#
# 或先下载再执行：
#   sh install.sh [--version v0.3.9] [--install-dir /opt/lingxiao]
#
# 功能：自动检测平台 → 下载对应 release → 解压 → 创建 symlink → 验证

set -e

# ── 默认配置 ──────────────────────────────────────────────────────────────────
REPO="hexian2001/lingxiao-coding"
INSTALL_DIR="/opt/lingxiao"
BIN_DIR="/usr/local/bin"
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
      echo "  --version <tag>     指定版本 (如 v0.3.9)，默认最新"
      echo "  --install-dir <path> 安装目录 (默认: /opt/lingxiao)"
      echo "  --bin-dir <path>     symlink 目录 (默认: /usr/local/bin)"
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

# ── 获取版本 ──────────────────────────────────────────────────────────────────
if [ -z "$VERSION" ]; then
  echo "▸ 获取最新版本..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
  if [ -z "$VERSION" ]; then
    echo "✗ 无法获取最新版本，请用 --version 指定"
    exit 1
  fi
fi
echo "★ 版本: ${VERSION}"

# ── 下载 ──────────────────────────────────────────────────────────────────────
ARCHIVE_NAME="lingxiao-${VERSION}-${TARGET}.tar.gz"
# 去掉版本号前的 v 前缀用于文件名匹配（release 资产可能用 v0.3.9 或 0.3.9）
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ARCHIVE_NAME}"

echo "▸ 下载: ${DOWNLOAD_URL}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if ! curl -fSL -o "${TMP_DIR}/${ARCHIVE_NAME}" "$DOWNLOAD_URL" 2>&1; then
  # 尝试不带 v 前缀的版本号
  VERSION_NO_V="${VERSION#v}"
  ARCHIVE_NAME_ALT="lingxiao-${VERSION_NO_V}-${TARGET}.tar.gz"
  DOWNLOAD_URL_ALT="https://github.com/${REPO}/releases/download/${VERSION}/${ARCHIVE_NAME_ALT}"
  echo "▸ 重试: ${DOWNLOAD_URL_ALT}"
  curl -fSL -o "${TMP_DIR}/${ARCHIVE_NAME_ALT}" "$DOWNLOAD_URL_ALT"
  ARCHIVE_NAME="$ARCHIVE_NAME_ALT"
fi
echo "  ✓ 下载完成"

# ── 解压 + 安装 ───────────────────────────────────────────────────────────────
echo "▸ 解压到 ${INSTALL_DIR}..."
if [ -d "$INSTALL_DIR" ]; then
  echo "  ⚠ ${INSTALL_DIR} 已存在，备份到 ${INSTALL_DIR}.bak"
  rm -rf "${INSTALL_DIR}.bak"
  mv "$INSTALL_DIR" "${INSTALL_DIR}.bak"
fi

mkdir -p "$INSTALL_DIR"
tar xzf "${TMP_DIR}/${ARCHIVE_NAME}" -C "$INSTALL_DIR" --strip-components=1
echo "  ✓ 解压完成"

# ── 创建 symlink ──────────────────────────────────────────────────────────────
echo "▸ 创建命令链接..."
mkdir -p "$BIN_DIR"
ln -sf "${INSTALL_DIR}/lingxiao" "${BIN_DIR}/lingxiao"
echo "  ✓ ${BIN_DIR}/lingxiao → ${INSTALL_DIR}/lingxiao"

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
