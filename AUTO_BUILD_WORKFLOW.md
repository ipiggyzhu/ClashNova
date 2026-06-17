# GitHub Actions 自动编译工作流

## 概述

已配置完整的自动化编译检测和修复循环，直到 NSIS 和 MSI 安装包成功生成。

## 工作流程

```
1. 推送代码到 main 分支
   ↓
2. GitHub Actions 自动触发构建
   ↓
3. 等待构建完成（约 10-15 分钟）
   ↓
4. 检查构建状态
   ↓
5a. 成功 → 下载 Release 产物 ✓
   ↓
5b. 失败 → 下载日志 → 分析错误 → 修复 → 推送 → 回到步骤 2
```

## 脚本说明

### 1. wait-and-fix-loop.sh（推荐使用）

**功能**: 交互式自动化循环

**使用方法**:
```bash
./wait-and-fix-loop.sh
```

**工作流程**:
- 等待 5 分钟
- 提示你检查构建状态
- 根据你的输入执行相应操作：
  - `success`: 构建成功，退出
  - `fixed`: 已修复错误，自动提交推送
  - `wait`: 继续等待

**优点**: 
- 简单直观
- 避免 API 速率限制
- 你控制修复时机

### 2. auto-build-check.ps1（Windows PowerShell）

**功能**: 自动监控和分析错误

**使用方法**:
```powershell
powershell -ExecutionPolicy Bypass -File .\auto-build-check.ps1
```

**工作流程**:
- 自动获取最新 workflow run
- 等待构建完成
- 成功则显示下载链接
- 失败则下载日志并分析错误模式

**优点**:
- 全自动化
- 智能错误分析
- 生成详细报告

**限制**:
- 可能遇到 GitHub API 速率限制

### 3. smart-fix.sh

**功能**: 智能错误分析和修复建议

**使用方法**:
```bash
./smart-fix.sh
```

**前置条件**: 需要先有 `build-error-report.txt`

**检测的错误类型**:
1. runas/deelevate 依赖问题
2. 前端编译失败
3. Tauri 配置错误
4. Windows API 问题
5. 链接器错误

### 4. monitor-build.sh

**功能**: 简单的监控指南

**使用方法**:
```bash
./monitor-build.sh
```

## 当前状态

✓ 代码已推送到 main 分支
✓ GitHub Actions 已触发
⏳ 正在等待构建完成

**监控链接**: https://github.com/ipiggyzhu/ClashNova/actions

## 预期产物

构建成功后，将在 Releases 页面看到：

1. **ClashNova-xxx-x64-setup.exe**
   - NSIS 安装包
   - 标准 Windows 安装向导

2. **ClashNova-xxx-x64-en-US.msi**
   - MSI 安装包
   - 企业级安装包格式

## 常见错误和修复

### 错误 1: 依赖解析失败

**症状**: `error: failed to resolve dependencies`

**修复**: 检查 `src-tauri/Cargo.toml` 中的依赖版本

### 错误 2: 前端编译失败

**症状**: `npm run build failed`

**修复**: 
```bash
npm install
npm run build
```

### 错误 3: Tauri 配置错误

**症状**: `tauri.conf.json` 解析失败

**修复**: 检查 JSON 语法，验证所有路径存在

### 错误 4: Windows API 调用失败

**症状**: `windows-sys` 或 `windows` crate 错误

**修复**: 检查 Windows crate 版本兼容性

## 快速开始

**推荐方式（最简单）**:

```bash
# 启动交互式循环
./wait-and-fix-loop.sh
```

然后：
1. 等待脚本提示
2. 访问 https://github.com/ipiggyzhu/ClashNova/actions
3. 检查构建状态
4. 根据提示输入 success/fixed/wait

**自动化方式（Windows）**:

```powershell
powershell -ExecutionPolicy Bypass -File .\auto-build-check.ps1
```

## 成功标志

当你看到以下信息时，表示完成：

```
✓✓✓ 构建成功！✓✓✓

发布页面: https://github.com/ipiggyzhu/ClashNova/releases/latest

预期产物:
  - ClashNova-xxx-x64-setup.exe (NSIS)
  - ClashNova-xxx-x64-en-US.msi (MSI)
```

## 下一步测试

构建成功后：

1. 下载安装包
2. 安装到 Windows 系统
3. 测试 TUN 模式开关
4. 验证 Logo 显示
5. 检查路由地图（连接线和飞机图标）

---

**当前任务**: 等待第一次构建完成（约 10-15 分钟）
**脚本状态**: wait-and-fix-loop.sh 正在运行中
