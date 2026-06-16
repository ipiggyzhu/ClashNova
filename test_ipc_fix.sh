#!/bin/bash
# IPC 修复测试脚本

set -e

echo "=========================================="
echo "测试 1: 编译 IPC 客户端"
echo "=========================================="
cargo build --package nova-service-ipc --features client

echo ""
echo "=========================================="
echo "测试 2: 编译 IPC 服务端"
echo "=========================================="
cargo build --package nova-service-ipc --features server

echo ""
echo "=========================================="
echo "测试 3: 编译 IPC 完整功能"
echo "=========================================="
cargo build --package nova-service-ipc --all-features

echo ""
echo "=========================================="
echo "测试完成！"
echo "=========================================="
echo ""
echo "所有 IPC 组件编译成功！"
echo ""
echo "下一步操作（在 Windows 环境下）："
echo "1. cargo build --release"
echo "2. 重装服务（如果已安装）"
echo "3. 测试 TUN 模式切换"
echo ""
echo "预期结果："
echo "- TUN 切换时不再出现 'IPC 调用失败' 错误"
echo "- 命名管道连接成功"
echo "- 服务能够正常启动/停止内核"
