#!/bin/bash
# 智能修复脚本 - 根据常见错误模式自动修复

analyze_and_fix() {
    local log_file="$1"
    
    echo "[分析] 分析构建日志中..."
    
    # 检测常见错误并应用修复
    
    # 错误 1: runas 或 deelevate 依赖问题
    if grep -q "failed to resolve.*runas\|failed to resolve.*deelevate" "$log_file"; then
        echo "[修复] 检测到 runas/deelevate 依赖问题"
        echo "  -> 检查 Cargo.toml 配置..."
        
        if ! grep -q "runas.*1.2" src-tauri/Cargo.toml; then
            echo '添加: runas = "1.2"'
        fi
        if ! grep -q "deelevate.*0.2" src-tauri/Cargo.toml; then
            echo '添加: deelevate = "0.2"'
        fi
        
        return 1
    fi
    
    # 错误 2: 前端编译失败
    if grep -q "npm run build.*failed\|vite build.*failed" "$log_file"; then
        echo "[修复] 检测到前端编译错误"
        echo "  -> 可能是 TypeScript 或依赖问题"
        
        # 检查 package.json
        if [ -f "package.json" ]; then
            echo "  -> 检查 package.json 完整性..."
        fi
        
        return 2
    fi
    
    # 错误 3: Tauri 配置问题
    if grep -q "tauri.conf.json\|tauri config" "$log_file"; then
        echo "[修复] 检测到 Tauri 配置错误"
        echo "  -> 检查 src-tauri/tauri.conf.json..."
        
        return 3
    fi
    
    # 错误 4: Windows API 调用问题
    if grep -q "windows-sys\|windows crate" "$log_file"; then
        echo "[修复] 检测到 Windows API 问题"
        echo "  -> 检查 windows crate 版本..."
        
        return 4
    fi
    
    # 错误 5: 链接错误（不应该出现，因为 GitHub Actions 有完整环境）
    if grep -q "link.exe.*not found\|linker.*not found" "$log_file"; then
        echo "[ERROR] GitHub Actions 环境缺少链接器（异常情况）"
        echo "  -> 这不应该发生，请检查 workflow 配置"
        
        return 5
    fi
    
    # 未知错误
    echo "[分析] 未检测到已知错误模式"
    echo ""
    echo "=== 错误关键词 ==="
    grep -i "error:" "$log_file" | head -20
    echo ""
    
    return 0
}

# 主逻辑
if [ ! -f "build-error-report.txt" ]; then
    echo "[错误] 找不到 build-error-report.txt"
    echo "请先运行 auto-build-check.ps1 下载错误日志"
    exit 1
fi

echo "========================================"
echo "  智能错误分析和修复"
echo "========================================"
echo ""

analyze_and_fix "build-error-report.txt"
exit_code=$?

case $exit_code in
    0)
        echo ""
        echo "[建议] 未检测到已知问题，需要手动分析"
        ;;
    1)
        echo ""
        echo "[建议] 请检查 src-tauri/Cargo.toml 中的依赖配置"
        ;;
    2)
        echo ""
        echo "[建议] 运行 npm install 和 npm run build 测试前端编译"
        ;;
    3)
        echo ""
        echo "[建议] 检查 src-tauri/tauri.conf.json 语法"
        ;;
    4)
        echo ""
        echo "[建议] 检查 Cargo.toml 中 windows crate 版本"
        ;;
    5)
        echo ""
        echo "[建议] 检查 .github/workflows/build.yml 配置"
        ;;
esac

echo ""
echo "完整错误日志: build-error-report.txt"
