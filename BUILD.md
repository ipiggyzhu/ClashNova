# ClashNova v2 构建指南

ClashNova 是 Tauri 2 + React 的 Windows 代理客户端。最终产物是 Windows 安装包
(`.msi` 与 NSIS `-setup.exe`)。取得安装包有三种途径，按推荐顺序排列。

## 途径一：GitHub Actions 工件（推荐，无需本机环境）

1. 推送 tag（如 `v2.0.0`）或在 GitHub 仓库 **Actions → build → Run workflow** 手动触发。
2. 等待 `test`（Ubuntu，前端构建 + nova-core 测试）与 `release`（Windows 打包）两个 job 跑绿。
3. 在该次运行的 **Artifacts** 区下载：
   - `ClashNova-msi` — Windows Installer 包（`.msi`）
   - `ClashNova-nsis-setup` — NSIS 安装程序（`ClashNova_2.0.0_x64-setup.exe`）

CI 会自动执行图标生成（`scripts/gen-icons.mjs`）与 mihomo 内核拉取
（`scripts/fetch-mihomo.mjs`），无需手工准备。

## 途径二：Windows 本机构建

### 1. 安装工具链（一次性）

- **Rust**：到 <https://rustup.rs> 下载 `rustup-init.exe`，安装 stable 工具链
  （默认 `x86_64-pc-windows-msvc` 目标；需要 Visual Studio Build Tools 的
  「使用 C++ 的桌面开发」组件，rustup 安装时会提示）。
- **Node.js**：到 <https://nodejs.org> 安装 Node 20 LTS 或更高版本。

### 2. 构建

在仓库根目录执行：

```powershell
npm ci                          # 安装前端依赖(无 lock 文件时改用 npm install)
node scripts/gen-icons.mjs      # 生成 src-tauri/icons/ 品牌图标
node scripts/fetch-mihomo.mjs   # 下载 mihomo 内核到 src-tauri/binaries/
npm run tauri build             # 编译并打包
```

产物位置：

```
src-tauri/target/release/bundle/msi/ClashNova_2.0.0_x64_zh-CN.msi
src-tauri/target/release/bundle/nsis/ClashNova_2.0.0_x64-setup.exe
```

说明：

- `fetch-mihomo.mjs` 默认跳过已存在的内核文件，加 `--force` 强制重新下载；
  如遇 GitHub API 限流，可设置环境变量 `GITHUB_TOKEN` 后重试。
- 两个脚本依赖 devDependencies（`sharp` / `png-to-ico` / `adm-zip`），`npm ci` 已一并安装。

### 3. 开发模式（热重载调试）

完成上面第 1、2 步的图标与内核准备后：

```powershell
npm run tauri dev
```

前端改动即时热更新；Rust 侧改动会自动重新编译并重启窗口。

## 途径三：纯前端 mock 预览（无需 Rust / 内核 / Windows）

在任意平台（含 WSL）预览全部页面 UI：

```bash
npm install
npm run mock        # 即 VITE_MOCK=1 vite
```

浏览器打开终端提示的地址（默认 <http://localhost:5173>）。mock 模式下
IPC / REST / WebSocket 全部由 `src/services/mock.ts` 的模拟数据替代，
页面表现与设计稿一致，适合 UI 走查与截图比对。

## WebView2 运行时说明

Tauri 应用依赖 **Microsoft Edge WebView2 Runtime**：

- Windows 11 与近年更新过的 Windows 10 已内置（Evergreen 分发），无需处理。
- NSIS 安装包在目标机缺失 WebView2 时会自动引导下载安装。
- 如仍提示缺失，到微软官网手动安装 Evergreen Bootstrapper：
  <https://developer.microsoft.com/microsoft-edge/webview2/>

## 常见问题

| 现象 | 处理 |
|---|---|
| `tauri build` 报缺少 icons | 先执行 `node scripts/gen-icons.mjs` |
| `tauri build` 报找不到 sidecar `mihomo` | 先执行 `node scripts/fetch-mihomo.mjs` |
| mihomo 下载 403/限流 | 设置 `GITHUB_TOKEN` 环境变量，或配置代理后重试 |
| 链接错误 `link.exe not found` | 安装 Visual Studio Build Tools（C++ 桌面开发组件） |
| 想在 Linux/WSL 验证核心逻辑 | `cargo test -p nova-core --manifest-path crates/nova-core/Cargo.toml` |
