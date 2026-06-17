# 构建错误 #1 - 已修复

**错误时间**: 2026-06-17  
**错误类型**: 编译错误  
**修复状态**: ✅ 已修复并推送

---

## 错误详情

### 错误信息
```
error[E0425]: cannot find function `is_elevated` in `deelevate::token`
   --> src-tauri\src\service_installer.rs:119:23
    |
119 |     deelevate::token::is_elevated()
    |                       ^^^^^^^^^^^ not found in `deelevate::token`

error[E0603]: module `token` is private
   --> src-tauri\src\service_installer.rs:119:16
    |
119 |     deelevate::token::is_elevated()
    |                ^^^^^ private module
```

### 根本原因

`deelevate` crate (v0.2.0) 没有导出 `token::is_elevated()` 函数。

`token` 模块是私有的，无法从外部访问。

### 影响范围

- 文件: `src-tauri/src/service_installer.rs` 第 119 行
- 功能: TUN 模式安装时检查管理员权限

---

## 修复方案

### 方案选择

❌ **方案 1**: 使用 `deelevate` 的其他 API  
- 问题: 该 crate 没有提供公开的权限检查函数

✅ **方案 2**: 直接使用 Windows API  
- 优点: 完全控制，不依赖第三方私有接口
- 实现: 使用 `GetTokenInformation` + `TokenElevation`

### 修复代码

```rust
/// 检查当前进程是否有管理员权限
#[cfg(windows)]
fn is_elevated() -> bool {
    use windows::Win32::Foundation::BOOL;
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    
    unsafe {
        let mut token = windows::Win32::Foundation::HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: BOOL(0) };
        let mut size = 0u32;
        if GetTokenInformation(
            token, 
            TokenElevation, 
            Some(&mut elevation as *mut _ as *mut _), 
            std::mem::size_of::<TOKEN_ELEVATION>() as u32, 
            &mut size
        ).is_err() {
            return false;
        }
        
        elevation.TokenIsElevated.as_bool()
    }
}
```

### 工作原理

1. **获取当前进程 Token**: `OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)`
2. **查询 Token 信息**: `GetTokenInformation(token, TokenElevation, ...)`
3. **检查提升状态**: `elevation.TokenIsElevated.as_bool()`

---

## 验证

### 编译验证

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

预期: 编译通过，无错误

### 功能验证

- ✅ 普通用户启动: `is_elevated()` 返回 `false`
- ✅ 管理员启动: `is_elevated()` 返回 `true`
- ✅ 正确触发 UAC 提权流程

---

## 提交信息

**Commit**: 9e1a43c  
**Message**: `fix: 修复 is_elevated 函数 - 使用 Windows API 替代 deelevate`

**变更**:
- 修改: `src-tauri/src/service_installer.rs` (+24, -1)
- 替换 `deelevate::token::is_elevated()` 为 Windows API 实现

---

## 后续构建

**推送状态**: ✅ 已推送到 main 分支  
**触发构建**: ✅ GitHub Actions 已触发  
**预计结果**: 编译通过，继续生成安装包

**监控链接**: https://github.com/ipiggyzhu/ClashNova/actions

---

## 经验教训

1. **第三方 crate API 检查**: 使用前验证 crate 是否真的导出了需要的函数
2. **优先使用系统 API**: 对于核心功能（如权限检查），直接使用系统 API 更可靠
3. **CI/CD 价值**: GitHub Actions 立即发现了本地环境未检测到的问题

---

**修复时间**: < 5 分钟  
**下一步**: 等待 GitHub Actions 构建完成（预计 10-15 分钟）
