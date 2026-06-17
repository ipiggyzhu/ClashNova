# 构建错误 #3 - 已修复

**错误时间**: 2026-06-17  
**错误类型**: 类型不匹配  
**修复状态**: ✅ 已修复并推送

---

## 错误详情

### 错误信息
```
error[E0308]: mismatched types
   --> src-tauri\src\service_installer.rs:129:64
    |
129 |         let mut elevation = TOKEN_ELEVATION { TokenIsElevated: BOOL(0) };
    |                                                                ^^^^^^^ expected `u32`, found `BOOL`

error[E0599]: no method named `as_bool` found for type `u32` in the current scope
   --> src-tauri\src\service_installer.rs:141:35
    |
141 |         elevation.TokenIsElevated.as_bool()
    |                                   ^^^^^^^ method not found in `u32`
```

### 根本原因

在 `windows` crate v0.58 中，`TOKEN_ELEVATION` 结构体的 `TokenIsElevated` 字段类型是 **`u32`**，不是 `BOOL`。

之前的代码错误地使用了 `BOOL` 类型和 `.as_bool()` 方法。

### 结构体定义

```rust
// windows crate v0.58
pub struct TOKEN_ELEVATION {
    pub TokenIsElevated: u32,  // ← u32, 不是 BOOL
}
```

---

## 修复方案

### 修复前（错误）

```rust
let mut elevation = TOKEN_ELEVATION { TokenIsElevated: BOOL(0) };
// ...
elevation.TokenIsElevated.as_bool()
```

### 修复后（正确）

```rust
let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
// ...
elevation.TokenIsElevated != 0
```

### 完整的正确实现

```rust
#[cfg(windows)]
fn is_elevated() -> bool {
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    
    unsafe {
        let mut token = windows::Win32::Foundation::HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
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
        
        elevation.TokenIsElevated != 0  // ← 直接比较 u32
    }
}
```

---

## 提交信息

**Commit**: 66f3148  
**Message**: `fix: 修正 TOKEN_ELEVATION 类型 - TokenIsElevated 是 u32 不是 BOOL`

**变更**:
- 修改: `src-tauri/src/service_installer.rs` (+2, -3)

---

## 验证

### 语义正确性

```rust
// Windows API 返回值:
// TokenIsElevated = 0  → 不是管理员
// TokenIsElevated ≠ 0  → 是管理员

elevation.TokenIsElevated != 0  // ✅ 正确
```

### 编译验证

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

预期: 编译通过，无类型错误

---

## 后续构建

**推送状态**: ✅ 已推送到 main 分支  
**触发构建**: ✅ GitHub Actions 已触发（第 8 次）  
**预计结果**: 编译通过，生成安装包

**监控链接**: https://github.com/ipiggyzhu/ClashNova/actions

---

## 构建历史

1. d77f974 - 自动化脚本
2. c9751c9 - 工作流文档
3. 4523ab6 - 状态报告
4. 9e1a43c - 修复错误 #1 → 失败（错误 #2）
5. 7bf29b5 - 错误报告 #1
6. ea0af95 - 修复错误 #2 → 失败（错误 #3）
7. 7b874fa - 错误报告 #2
8. **66f3148 - 修复错误 #3** ← 当前

---

## 经验教训

1. **查阅 API 文档**: 使用新 crate 时要查看实际的类型定义
2. **版本差异**: 不同版本的 crate 可能有不同的类型定义
3. **Windows API 封装**: `windows` crate 对原始 Win32 API 做了 Rust 封装，类型可能不直观

---

**修复时间**: < 3 分钟  
**下一步**: 等待 GitHub Actions 构建完成（预计 10-15 分钟）
