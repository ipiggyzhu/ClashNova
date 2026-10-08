# ClashNova 构建指南

ClashNova 使用 Tauri 2 + React，Windows 发行包为 NSIS 安装程序，Linux 发行包为
`.deb` / `.AppImage`。本文件描述当前构建流程；`docs/plans`、`docs/specs`
及版本完成记录保留历史背景，不是当前依赖或验证结果清单。

## 当前技术栈

| 部分 | 当前实现 |
|---|---|
| 桌面与后端 | Tauri 2、Rust 2021、Tokio、SQLite（rusqlite）、Boa JavaScript 增强脚本 |
| 前端 | React 18、TypeScript、Vite、React Router |
| 状态与通信 | Zustand；Tauri IPC；mihomo REST / WebSocket |
| 样式 | 纯 CSS 与设计令牌，未引入 TailwindCSS |
| 编辑器 | CodeMirror 6（`@uiw/react-codemirror`，YAML / JavaScript），不是 Monaco |
| 图表 | SVG / CSS、Spark、定制桑基布局；地图使用 D3 / world-atlas，球面按需加载 globe.gl / Three.js |
| 未使用的历史方案 | ECharts、TanStack Query、Monaco、TailwindCSS |

JavaScript 与 Rust 依赖的实际版本分别以 `package-lock.json`、`Cargo.lock` 为准；
内核版本与完整性摘要单独锁定在 `scripts/mihomo.lock.json`。

## 途径一：GitHub Actions 发行包

在仓库的 **Actions → build** 查看或手动触发工作流。构建触发条件、Windows / Linux
测试及打包步骤以 [build.yml](.github/workflows/build.yml) 为准。
成功的安装包发布到仓库 **Releases**，不是名为 `ClashNova-nsis-setup` 的 Actions 工件。
文件名中的版本来自项目版本配置，例如 `ClashNova_<版本>_x64-setup.exe`。

CI 会生成图标、校验锁定的 mihomo 资产、编译服务助手并打包；这些步骤不需要在目标用户机器上执行。

## 途径二：Windows 本机构建

### 1. 工具链

- **Rust**：CI 锁定 `1.99.0`；使用 <https://rustup.rs> 的对应 MSVC 工具链，并安装 Visual Studio
  Build Tools 的「使用 C++ 的桌面开发」组件及 Windows SDK。
- **Node.js**：CI 锁定 `24.19.0`，从 <https://nodejs.org> 安装。
- PowerShell 下使用 `npm.cmd`，避免本机脚本执行策略拦截 `npm.ps1`。

### 2. 准备资源并打包

在仓库根目录执行，依赖按锁文件安装：

```powershell
npm.cmd ci
node scripts/gen-icons.mjs
node scripts/fetch-mihomo.mjs

# 第一次编译助手时允许生成临时服务资源占位；最终打包前必须换成真实 exe。
$env:CLASHNOVA_ALLOW_PLACEHOLDER_SERVICE_RESOURCES = '1'
try {
  cargo build --locked --release --bin clashnova-service --bin clashnova-service-install --bin clashnova-service-uninstall
  if ($LASTEXITCODE -ne 0) { throw '服务助手构建失败' }
} finally {
  Remove-Item Env:\CLASHNOVA_ALLOW_PLACEHOLDER_SERVICE_RESOURCES -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force src-tauri/resources | Out-Null
Copy-Item -Path target/release/clashnova-service*.exe -Destination src-tauri/resources/ -Force

npm.cmd run tauri build -- --bundles nsis
```

默认 Cargo workspace 的产物路径为：

```text
target/release/bundle/nsis/ClashNova_<版本>_x64-setup.exe
```

如设置了 `CARGO_TARGET_DIR`，助手复制路径与最终产物路径也要相应调整。
`src-tauri/build.rs` 会拒绝缺失或仍为占位内容的正式服务资源。
Windows 签名流程见 `scripts/sign-windows.ps1` 及 CI；签名在内核完整性校验之后进行。

### 3. 开发模式

完成图标、内核与服务助手准备后：

```powershell
npm.cmd run tauri dev
```

前端改动热更新；Rust 改动会重新编译。原生服务、代理和 TUN 的行为需要在实际 Windows
环境单独验证，前端 mock 测试不覆盖这些副作用。

## 途径三：前端 mock 与回归

Windows：

```powershell
npm.cmd ci
npm.cmd run mock
```

Linux / macOS：

```bash
npm ci
VITE_MOCK=1 npm run dev
```

浏览器地址以终端输出为准（开发默认 `http://localhost:5173`）。mock 模式通过
`src/services/mock.ts` 替代 IPC / REST / WebSocket 数据，适合页面和交互回归，
不代表真实网络、内核或服务安装已验证。

提交前运行：

```bash
npm run typecheck
npm test
npm run test:browser
npm run build
```

`test:browser` 使用 Playwright，需要可用的浏览器运行时；浏览器安装和启动失败时应保留
原始错误，不能把未执行的浏览器回归视为通过。准备好对应平台工具链、图标、sidecar 和服务资源后，
Windows / Linux 后端回归命令为：

```bash
cargo test --locked --workspace --all-targets
```

## 途径四：Linux 构建（SOCKS / HTTP 代理模式）

Linux 使用 sidecar 启动 mihomo，提供 mixed-port 的 SOCKS / HTTP 代理。
Windows 服务托管的 TUN 流程不适用于 Linux。

### 1. 系统依赖

Ubuntu / Debian 的构建依赖：

```bash
sudo apt-get update && sudo apt-get install -y \
  pkg-config build-essential curl wget file libssl-dev \
  libwebkit2gtk-4.1-dev libdbus-1-dev librsvg2-dev \
  libxdo-dev libayatana-appindicator3-dev
```

`libxdo-dev` 用于全局快捷键，`libayatana-appindicator3-dev` 用于托盘。
其他发行版的软件包名称以 [Tauri 2 官方前置条件](https://v2.tauri.app/start/prerequisites/) 为准。

### 2. 内核与构建

```bash
npm ci
node scripts/gen-icons.mjs
node scripts/fetch-mihomo-linux.mjs
npm run tauri build
# 或使用 scripts/build-linux.sh（每次先校验内核，再安装依赖和构建）
```

Linux sidecar 的精确路径是 `src-tauri/binaries/mihomo-x86_64-unknown-linux-gnu`；
脚本负责校验内容并设置可执行权限。平台配置 `src-tauri/tauri.linux.conf.json` 使用
`deb` / `appimage` 并排除 Windows 服务助手资源。默认产物目录为 `target/release/bundle/`。

## mihomo 版本与完整性

当前固定为 **v1.19.27**，沿用原下载脚本中记录的版本，选择两个官方资产：

- Windows：`mihomo-windows-amd64-v1.19.27.zip`
- Linux：`mihomo-linux-amd64-compatible-v1.19.27.gz`

来源：[官方 release](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.27)；
归档 SHA256 来自 [该 release 的 GitHub API](https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/v1.19.27)
中对应资产的 `digest`。锁文件的 `binarySha256` 是归档校验通过后计算的解包内容摘要。
这是下载完整性校验，不是可复现构建或代码签名验证。

两个下载入口都会校验已有二进制；仅当大小和 SHA256 均匹配时免下载。
`--force` 会重新下载但不跳过任何校验。下载器不查询 `latest`，不需要 GitHub API token。
下载或校验失败时保留旧文件；临时文件位于项目 `.tmp/`，全部验证通过后才用 rename 替换目标。
脚本只准备文件，不启动内核。

升级时应先选定官方 tag，核对两份归档的官方 SHA256，再计算并更新二进制大小、摘要与入口名称；
同时审查 `scripts/mihomo.lock.json` 的变更，不能仅更改版本字符串。

## 品牌图片

`public/logo.png` 是 1024×1024 的图标源，保留给桌面图标生成。
`scripts/gen-icons.mjs` 同时生成 96×96 的 `public/logo-brand.png`，供 30px 侧栏品牌图和 favicon
使用，避免每次页面加载都下载高分辨率源图。

## WebView2 运行时

Windows 应用依赖 Microsoft Edge WebView2 Runtime。当前 NSIS 配置使用
`downloadBootstrapper`，缺少运行时时由安装流程下载引导程序。手工安装入口：
<https://developer.microsoft.com/microsoft-edge/webview2/>。

## 常见问题

| 现象 | 检查 |
|---|---|
| 缺少 icons | 运行 `node scripts/gen-icons.mjs` |
| 找不到 sidecar | 运行对应平台的 `fetch-mihomo*.mjs` |
| 下载 HTTP 错误或超时 | 检查对锁文件中官方 URL 的网络访问；保留错误，不使用未校验镜像替代 |
| SHA256 / 大小不匹配 | 停止打包，核对官方资产和锁文件；不要删除校验逻辑 |
| 原子替换失败 | 检查目标目录权限、磁盘及文件占用；原文件保留，停止占用后重试 |
| 服务资源仍是 placeholder | 编译三份服务助手并复制到 `src-tauri/resources/` |
| `link.exe not found` | 检查 Visual Studio Build Tools C++ 组件、Windows SDK 和 MSVC 工具链 |
