#!/bin/bash
# 完整的自动化循环：等待构建 -> 检查结果 -> 如果失败则需要手动修复 -> 推送 -> 重复

REPO_URL="https://github.com/ipiggyzhu/ClashNova"
MAX_ATTEMPTS=10
WAIT_SECONDS=300  # 每次等待 5 分钟后检查

attempt=1

echo "========================================"
echo "  自动编译循环脚本"
echo "========================================"
echo ""
echo "仓库: $REPO_URL"
echo "最大尝试次数: $MAX_ATTEMPTS"
echo ""

while [ $attempt -le $MAX_ATTEMPTS ]; do
    echo ""
    echo "========================================"
    echo "  尝试 $attempt/$MAX_ATTEMPTS"
    echo "========================================"
    echo ""
    
    echo "[等待] 等待 $WAIT_SECONDS 秒让构建完成..."
    sleep $WAIT_SECONDS
    
    echo ""
    echo "[检查] 请打开以下链接检查构建状态:"
    echo "$REPO_URL/actions"
    echo ""
    echo "如果构建成功："
    echo "  - 输入 'success' 并按 Enter"
    echo ""
    echo "如果构建失败："
    echo "  1. 下载失败的 workflow 日志"
    echo "  2. 在项目中修复错误"
    echo "  3. 输入 'fixed' 并按 Enter（脚本将自动提交和推送）"
    echo ""
    echo "如果还在构建中："
    echo "  - 输入 'wait' 并按 Enter（继续等待）"
    echo ""
    read -p "状态 (success/fixed/wait): " status
    
    case $status in
        success)
            echo ""
            echo "✓✓✓ 构建成功！✓✓✓"
            echo ""
            echo "发布页面: $REPO_URL/releases/latest"
            echo ""
            echo "预期产物:"
            echo "  - ClashNova-xxx-x64-setup.exe (NSIS)"
            echo "  - ClashNova-xxx-x64-en-US.msi (MSI)"
            echo ""
            exit 0
            ;;
        fixed)
            echo ""
            echo "[提交] 提交修复并推送..."
            git add -A
            git commit -m "fix: 修复编译错误 (尝试 $attempt)" --no-verify
            git push origin main
            echo ""
            echo "[完成] 已推送，将在下一轮检查构建状态"
            attempt=$((attempt + 1))
            ;;
        wait)
            echo ""
            echo "[继续等待] 保持当前尝试计数..."
            ;;
        *)
            echo ""
            echo "[错误] 无效输入，请输入 success/fixed/wait"
            ;;
    esac
done

echo ""
echo "[停止] 已达到最大尝试次数 ($MAX_ATTEMPTS)"
echo "请手动检查: $REPO_URL/actions"
exit 1
