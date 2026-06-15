#!/bin/bash
# 构建服务安装/卸载程序并复制到 binaries 目录

set -e

echo "构建服务安装程序..."
cargo build --release --bin clashnova-service-install

echo "构建服务卸载程序..."
cargo build --release --bin clashnova-service-uninstall

echo "创建 binaries 目录..."
mkdir -p src-tauri/binaries

echo "复制二进制文件..."
cp target/release/clashnova-service-install.exe src-tauri/binaries/ 2>/dev/null || \
   cp target/release/clashnova-service-install src-tauri/binaries/ 2>/dev/null || true

cp target/release/clashnova-service-uninstall.exe src-tauri/binaries/ 2>/dev/null || \
   cp target/release/clashnova-service-uninstall src-tauri/binaries/ 2>/dev/null || true

echo "完成！"
