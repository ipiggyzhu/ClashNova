#!/usr/bin/env bash
# ClashNova — Linux 构建脚本(非 TUN / SOCKS·HTTP 代理模式)。
#
# 前置(需 root,一次性 —— Tauri v2 官方 Linux 依赖全集):
#   sudo apt-get update && sudo apt-get install -y \
#     pkg-config build-essential curl wget file libssl-dev \
#     libwebkit2gtk-4.1-dev libdbus-1-dev librsvg2-dev \
#     libxdo-dev libayatana-appindicator3-dev
#   (libxdo-dev 供 global-shortcut 插件;libayatana-appindicator3-dev 供 tray-icon 特性,缺则链接失败)
#
# 说明:
#   - Linux 版走跨平台 sidecar 直接拉起 mihomo(app.shell().sidecar),
#     支持 mixed-port 的 SOCKS/HTTP 代理;TUN 模式仅 Windows 支持(依赖 Windows 服务)。
#   - bundle 产物:.deb 与 .AppImage,位于 src-tauri/target/release/bundle/。
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="x86_64-unknown-linux-gnu"
MIHOMO_BIN="src-tauri/binaries/mihomo-${TARGET}"

echo "==> 检查系统依赖"
missing=()
command -v pkg-config >/dev/null 2>&1 || missing+=("pkg-config")
if command -v pkg-config >/dev/null 2>&1; then
  # webkit/dbus/rsvg;global-shortcut 需要 libxdo;tray-icon 需要 ayatana-appindicator
  for pc in webkit2gtk-4.1 dbus-1 librsvg-2.0 xdo ayatana-appindicator3-0.1; do
    pkg-config --exists "$pc" 2>/dev/null || missing+=("$pc(-dev)")
  done
fi
if [ "${#missing[@]}" -ne 0 ]; then
  echo "缺少系统依赖: ${missing[*]}" >&2
  echo "请先运行:" >&2
  echo "  sudo apt-get update && sudo apt-get install -y pkg-config build-essential curl wget file libssl-dev libwebkit2gtk-4.1-dev libdbus-1-dev librsvg2-dev libxdo-dev libayatana-appindicator3-dev" >&2
  exit 1
fi

echo "==> 准备 mihomo Linux 内核"
if [ ! -x "$MIHOMO_BIN" ]; then
  node scripts/fetch-mihomo-linux.mjs
fi
if [ ! -x "$MIHOMO_BIN" ]; then
  echo "缺少 $MIHOMO_BIN(Tauri sidecar 需要 target-triple 后缀命名)。" >&2
  echo "手动: node scripts/fetch-mihomo-linux.mjs(可设 GITHUB_TOKEN 规避限流)" >&2
  exit 1
fi

echo "==> 安装前端依赖"
npm ci

echo "==> 构建(前端 + Tauri,deb/appimage)"
npm run tauri build

echo "==> 完成。产物:"
find src-tauri/target/release/bundle -maxdepth 2 -type f \( -name '*.deb' -o -name '*.AppImage' \) -printf '  %p\n' || true
