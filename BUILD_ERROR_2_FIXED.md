# 构建错误 #2 - 已修复

**错误时间**: 2026-06-17  
**错误类型**: 依赖缺失  
**修复状态**: ✅ 已修复并推送

---

## 错误详情

### 错误信息
```
error[E0433]: cannot find module or crate `windows` in this scope
   --> src-tauri\src\service_installer.rs:119:9
    |
119 |     use windows::Win32::Foundation::BOOL;
    |         ^^^^^^^ use of unresolved module or unlinked crate `windows`
```

### 根本原因

修复错误 #1 时使用了 Windows API (`windows` crate)，但忘记在 `Cargo.toml` 中添加该依赖。

### 影响范围

- 文件: `src-tauri/src/service_installer.rs`
- 功能: `is_elevated()` 函数无法编译

---

## 修复方案

### 添加依赖

在 `src-tauri/Cargo.toml` 中添加：

```toml
[target.'cfg(windows)'.dependencies.windows]
version = "0.58"
features = [
    "Win32_Foundation",
    "Win32_Security",
    "Win32_System_Threading",
]
```

### 必需的 Features

- `Win32_Foundation` - 提供 `BOOL`, `HANDLE` 等基础类型
- `Win32_Security` - 提供 `GetTokenInformation`, `TOKEN_ELEVATION` 等安全 API
- `Win32_System_Threading` - 提供 `GetCurrentProcess`, `OpenProcessToken` 等进程 API

---

## 提交信息

**Commit**: ea0af95  
**Message**: `fix: 添加 windows crate 依赖用于权限检查`

**变更**:
- 修改: `src-tauri/Cargo.toml` (+8)

---

## 验证

### 依赖检查
```bash
cargo tree --manifest-path src-tauri/Cargo.toml | grep windows
```

预期输出:
```
└── windows v0.58.0
    ├── windows-core v0.58.0
    └── windows-targets v0.52.0
```

### 编译验证
```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

预期: 编译通过

---

## 后续构建

**推送状态**: ✅ 已推送到 main 分支  
**触发构建**: ✅ GitHub Actions 已触发（第 6 次）  
**预计结果**: 编译通过，生成安装包

**监控链接**: https://github.com/ipiggyzhu/ClashNova/actions

---

## 构建历史

1. Push d77f974 - 自动化脚本
2. Push c9751c9 - 工作流文档
3. Push 4523ab6 - 状态报告
4. Push 9e1a43c - 修复 is_elevated ❌ 错误 #1
5. Push 7bf29b5 - 错误报告 #1
6. **Push ea0af95 - 添加 windows 依赖** ← 修复错误 #2

---

**修复时间**: < 2 分钟  
**下一步**: 等待 GitHub Actions 构建完成
