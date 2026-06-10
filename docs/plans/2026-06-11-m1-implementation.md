# ClashNova v2 — M1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可构建为 Windows exe/MSI 的 ClashNova v2 M1：mihomo 内核管理、订阅 Profile、代理切换/测速、系统代理/TUN、连接/日志/规则、托盘。

**Architecture:** Tauri 2（Rust）+ React 18 + TS + Vite + Tailwind 不使用——改用**纯 CSS 设计令牌**（直接移植设计稿 shell-head.html 的 token/组件样式，避免引入 Tailwind 与设计稿样式系统的双轨制）。前端经 `services/ipc.ts` 适配层与 Rust 通信；流量/日志/连接由前端直连 mihomo WebSocket。纯逻辑放 `crates/nova-core`（Linux 可测），Windows 专属代码放 `src-tauri`（CI windows-latest 构建）。

**Tech Stack:** Tauri 2.x, Rust 2021, React 18, TypeScript 5, Vite 6, zustand, ECharts(M3 再引入), serde/serde_yaml, reqwest, tokio, sysproxy crate。

**环境事实（已探明）：**
- WSL：node v24 ✓ npm ✓ cargo 1.96 ✓（无 webkit2gtk → `src-tauri` 在 WSL 只写不编，由 CI 验证）
- Windows 侧无 cargo/node → 最终 exe 由 GitHub Actions（windows-latest）产出，或用户装 Rust+Node 后本机 `npm run tauri build`
- UI 验证：`VITE_MOCK=1` 模拟模式下用无头 Chrome 截图比对设计稿（设计稿 = `design/mockup.html`，唯一视觉基准）

---

## 文件地图（全量）

```
ClashNova-v2/
├─ package.json  vite.config.ts  tsconfig.json  index.html
├─ src/                                  # 前端
│  ├─ main.tsx  App.tsx  router.tsx
│  ├─ styles/tokens.css                  # 设计令牌(从 design/shell-head.html 移植, 明暗双主题)
│  ├─ styles/base.css                    # 全局组件类(card/seg/btn/badge/tbl/toggle/input/set-row)
│  ├─ types/clash.ts                     # 全部领域类型(契约, 见下)
│  ├─ services/ipc.ts                    # Tauri invoke 适配层(VITE_MOCK 时走 mock)
│  ├─ services/api.ts                    # mihomo REST(fetch 直连 127.0.0.1:9097)
│  ├─ services/ws.ts                     # mihomo WS(traffic/logs/connections), mock 下用定时器造数
│  ├─ services/mock.ts                   # 模拟数据(与设计稿数据一致)
│  ├─ stores/app.ts                      # zustand: settings/coreStatus/mode/theme
│  ├─ stores/live.ts                     # zustand: traffic 环形缓冲/connections/logs
│  ├─ components/ui/{Card,Seg,Toggle,Badge,Button,Input,Spark,Icon}.tsx
│  ├─ components/layout/{Sidebar,Topbar}.tsx
│  └─ pages/{Dashboard,Proxies,Profiles,Connections,Logs,Rules,Settings,Placeholder}.tsx
├─ crates/nova-core/                     # 纯逻辑 crate(Linux 可测)
│  ├─ Cargo.toml
│  └─ src/{lib.rs,subscription.rs,merge.rs,config_gen.rs}
├─ src-tauri/                            # Tauri 应用(Windows)
│  ├─ Cargo.toml  tauri.conf.json  build.rs  capabilities/default.json
│  ├─ icons/(icon.ico 等, 由 scripts/gen-icons 生成)
│  └─ src/{main.rs,commands.rs,core.rs,profiles.rs,sysproxy_win.rs,tray.rs,state.rs}
├─ scripts/{fetch-mihomo.mjs,gen-icons.mjs}
├─ .github/workflows/build.yml           # windows-latest 构建 exe/MSI 工件
└─ BUILD.md
```

## 锁定契约（双方各自实现时以此为准，不得擅改）

### A. TypeScript 领域类型（`src/types/clash.ts` 全文）

```ts
export interface ProxyNode { name: string; type: string; udp?: boolean;
  history: { time: string; delay: number }[]; delay?: number }
export interface ProxyGroup { name: string;
  type: 'Selector' | 'URLTest' | 'Fallback' | 'LoadBalance' | string;
  now: string; all: string[] }
export interface ProxiesPayload { proxies: Record<string, ProxyNode & Partial<ProxyGroup>> }
export interface ConnMeta { host: string; destinationIP: string; destinationPort: string;
  sourceIP: string; sourcePort: string; network: 'tcp' | 'udp'; process?: string; processPath?: string }
export interface ConnItem { id: string; metadata: ConnMeta; rule: string; rulePayload: string;
  chains: string[]; upload: number; download: number; start: string;
  curUp?: number; curDown?: number }
export interface ConnectionsPayload { downloadTotal: number; uploadTotal: number; connections: ConnItem[] }
export interface RuleItem { type: string; payload: string; proxy: string }
export interface LogItem { type: 'info' | 'warning' | 'error' | 'debug'; payload: string; time: string }
export interface TrafficPoint { up: number; down: number }
export interface CoreStatus { running: boolean; version: string; uptimeSec: number; memoryBytes: number }
export interface ProfileQuota { used: number; total: number; expireAt?: number }
export interface ProfileMeta { id: string; name: string; kind: 'remote' | 'local'; url?: string;
  updatedAt: number; autoUpdateMin?: number; sizeBytes?: number; quota?: ProfileQuota; current: boolean }
export type OutboundMode = 'rule' | 'global' | 'direct'
export type Theme = 'dark' | 'light' | 'system'
export interface AppSettings { sysProxy: boolean; guard: boolean; guardIntervalSec: number;
  bypass: string; tun: boolean; autostart: boolean; silentStart: boolean;
  mixedPort: number; externalController: string; secret: string;
  allowLan: boolean; ipv6: boolean; logLevel: LogItem['type'] | 'silent';
  mode: OutboundMode; theme: Theme }
```

### B. Tauri 命令契约（`commands.rs` 实现 / `ipc.ts` 调用，名称参数完全一致）

| 命令 | 参数 | 返回 |
|---|---|---|
| `get_settings` | – | `AppSettings` |
| `save_settings` | `settings: AppSettings` | `()`（落盘 + 按差异应用：sysproxy/tun/mode/端口热重载） |
| `core_status` | – | `CoreStatus` |
| `start_core` / `stop_core` / `restart_core` | – | `Result<(), String>` |
| `list_profiles` | – | `ProfileMeta[]` |
| `import_profile` | `url: String` | `ProfileMeta`（下载/解析/落盘） |
| `update_profile` | `id: String` | `ProfileMeta` |
| `select_profile` | `id: String` | `()`（生成运行时配置并热重载） |
| `delete_profile` | `id: String` | `()` |
| `read_profile` | `id: String` | `String`（YAML 原文） |
| `save_profile_content` | `id: String, content: String` | `()`（校验 YAML 后写回） |
| `set_system_proxy` | `enable: bool` | `Result<(), String>` |
| `set_tun` | `enable: bool` | `Result<(), String>` |
| `set_mode` | `mode: String` | `()`（PATCH /configs + 持久化） |
| `open_app_dir` | `kind: 'config'\|'core'\|'logs'` | `()` |

### C. mihomo REST/WS（`api.ts`/`ws.ts`，base = `http://127.0.0.1:9097`，header `Authorization: Bearer {secret}`）

GET `/version` `/proxies` `/rules`; PUT `/proxies/{group}` body `{name}`;
GET `/proxies/{name}/delay?timeout=5000&url=https://www.gstatic.com/generate_204`;
PATCH `/configs` body `{mode}`; DELETE `/connections/{id}`; DELETE `/connections`;
WS `/traffic` → `TrafficPoint`/s; WS `/connections` → `ConnectionsPayload`/s; WS `/logs?level=info` → `LogItem`。

### D. nova-core 公共 API（`lib.rs` re-export）

```rust
pub fn parse_subscription(content: &str) -> Result<Vec<serde_yaml::Value>, CoreError>;
// 支持: ① Clash YAML(取 proxies 数组) ② base64(URI 列表) ③ 裸 URI 列表
// URI 解析: ss:// vmess:// trojan:// vless:// → 等价 Clash proxy mapping
pub fn deep_merge(base: &mut serde_yaml::Value, patch: &serde_yaml::Value);
// 对象递归合并; `prepend-X`/`append-X` 键对 base.X 数组头/尾插入; 其余标量覆盖
pub struct RuntimeOverrides { pub mixed_port: u16, pub external_controller: String,
  pub secret: String, pub mode: String, pub allow_lan: bool, pub ipv6: bool,
  pub log_level: String, pub tun_enable: bool }
pub fn build_runtime_config(profile_yaml: &str, ov: &RuntimeOverrides) -> Result<String, CoreError>;
```

### E. 路由与导航（与设计稿一致）

`/dashboard /traffic /connections /logs /topology /routemap /proxies /rules /providers /profiles /settings`
M1 实装：dashboard, connections, logs, proxies, rules, profiles, settings；
traffic/topology/routemap/providers → `Placeholder.tsx`（卡片"M3 开发中"）。

### F. 视觉基准

每个页面组件以 `design/pages/NN-*.html` 为像素基准移植（类名/结构可 React 化，
token/层级/密度不得走样）。`styles/tokens.css` + `base.css` 直接取自
`design/shell-head.html` 的 `<style>`（拆分：令牌→tokens.css，组件类→base.css）。

---

## Task 0: 前端脚手架 + 设计系统 + 布局壳

**Files:** Create `package.json` `vite.config.ts` `tsconfig.json` `index.html`
`src/main.tsx` `src/App.tsx` `src/router.tsx` `src/styles/tokens.css` `src/styles/base.css`
`src/components/ui/*.tsx` `src/components/layout/{Sidebar,Topbar}.tsx` `src/pages/Placeholder.tsx`

- [ ] 依赖：react/react-dom/react-router-dom@7/zustand/@tauri-apps/api@2 + dev: vite@6/@vitejs/plugin-react/typescript。脚本：`dev` `build`(tsc -b && vite build) `mock`(VITE_MOCK=1 vite)
- [ ] tokens.css/base.css 从 `design/shell-head.html` 移植（`:root`+`[data-theme=light]` 全部变量、card/seg/btn/badge/chip/toggle/tbl/input/search-wrap/set-row/stat/spark 类）
- [ ] UI 组件：`Card`(head: icon/title/actions + body)、`Seg`(items/value/onChange)、`Toggle`(on/onChange)、`Badge`(tone)、`Button`(variant/size)、`Input`、`Spark`(pts/color/h/fill/dot → 移植 shell-tail 的 Catmull-Rom SVG 为 React)、`Icon`(name → 内联 SVG 集合，自绘 Lucide 风格，含侧边栏/卡片全部用到的 ~24 个)
- [ ] `Sidebar`：四组导航（概览/可视化/代理/配置）+ 品牌区 + 内核状态 chip（接 store）；`Topbar`：页面标题 + 出站模式 Seg（接 store `set_mode`）+ 主题切换 + 通知铃
- [ ] 验证：`npm install && npm run build` 零错误；`npm run mock` 起服务后无头 Chrome 截图首页壳层
- [ ] Commit: `feat(ui): 前端脚手架+设计系统+布局壳`

## Task 1: 服务层 + 状态层 + Mock

**Files:** Create `src/types/clash.ts` `src/services/{ipc,api,ws,mock}.ts` `src/stores/{app,live}.ts`

- [ ] `types/clash.ts` = 契约 A 全文
- [ ] `ipc.ts`：`isMock = import.meta.env.VITE_MOCK==='1' || !('__TAURI_INTERNALS__' in window)`；`call<T>(cmd, args)` → mock 时查 `mock.ts` 的 handler 表（延迟 80-200ms resolve），否则 `invoke`
- [ ] `mock.ts`：实现契约 B 全部命令的内存版（settings 可读写、profiles 两条与设计稿一致、core_status running）+ 导出 `mockProxies/mockRules/mockConnections` 造数器（数据沿用 `design/pages` 中的节点名/域名/进程）
- [ ] `api.ts`：契约 C 的 REST 封装（mock 时返回 mock 数据）；`ws.ts`：`subscribeTraffic/subscribeConnections/subscribeLogs`（mock 时 setInterval 1s 推造数；真实时 WebSocket + 断线 3s 重连）
- [ ] `stores/app.ts`：settings/coreStatus/mode/theme + `loadAll()`/`patchSettings()`（乐观更新 + ipc 持久化）；`stores/live.ts`：traffic 60 点环形缓冲、connections 快照、logs 1024 行环形缓冲 + pause
- [ ] 验证：`npm run build`；mock 模式控制台无错
- [ ] Commit: `feat(core-fe): 服务层/状态层/Mock`

## Task 2: M1 七页面（并行 ×7，文件互不重叠）

**Files:** Create `src/pages/{Dashboard,Proxies,Profiles,Connections,Logs,Rules,Settings}.tsx`（每页一个 agent）

- [ ] 各页以对应 `design/pages/*.html` 为基准移植为 React；数据一律走 services/stores（mock 下表现≈设计稿）；交互：Proxies 组切换(PUT)/单点+全组测延迟/搜索过滤；Connections 实时表+搜索+关闭单个/全部；Logs 等级过滤+暂停+清空；Profiles 导入 URL/更新/删除/切换/编辑(textarea 弹层即可，Monaco M2)；Settings 全部 set-row 接 `patchSettings`；Dashboard 接 traffic 环形缓冲实时曲线 + 连接数/内存(来自 core_status 轮询 5s)
- [ ] 验证：`npm run build`；mock 模式 7 页截图与设计稿逐页比对
- [ ] Commit: `feat(pages): M1 七页面`

## Task 3: nova-core 纯逻辑 crate（TDD，Linux 可测）

**Files:** Create `crates/nova-core/{Cargo.toml,src/lib.rs,src/subscription.rs,src/merge.rs,src/config_gen.rs}`

- [ ] 依赖：serde/serde_yaml/serde_json/base64/urlencoding/thiserror
- [ ] TDD 顺序（每个先写测试再实现）：
  `merge::deep_merge`：标量覆盖/嵌套对象递归/`prepend-rules`/`append-proxies` 数组插入 → 4 测试
  `subscription::parse_subscription`：Clash YAML 透传 / base64 解码 / ss URI(含 plugin 参数) / vmess base64-json / trojan / vless → 6 测试（样例 URI 写死在测试里）
  `config_gen::build_runtime_config`：覆写端口/控制器/secret/mode/tun/log-level、保留 profile 的 proxies/groups/rules、输出可被 serde_yaml 反序列化 → 3 测试
- [ ] 验证：`~/.cargo/bin/cargo test -p nova-core` 全绿
- [ ] Commit: `feat(nova-core): 订阅解析/深合并/运行时配置生成(13 tests)`

## Task 4: src-tauri 应用层（Windows 目标，CI 验证编译）

**Files:** Create `src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/default.json}`
`src-tauri/src/{main.rs,state.rs,commands.rs,core.rs,profiles.rs,sysproxy_win.rs,tray.rs}`

- [ ] `tauri.conf.json`：productName ClashNova、identifier `io.clashnova.app`、窗口 1280×800 min 980×640、`externalBin: ["binaries/mihomo"]`、bundle msi+nsis、systemTray
- [ ] 插件：tauri-plugin-{shell,autostart,single-instance,process,opener,log}
- [ ] `state.rs`：`AppState { settings: RwLock<AppSettings>, core: Mutex<CoreHandle>, dirs }`（config 目录 `%APPDATA%/ClashNova`：settings.json、profiles/*.yaml、profiles.json 索引、runtime.yaml、logs/）
- [ ] `core.rs`：sidecar 启动 `mihomo -d {dir} -f runtime.yaml`、stdout 转日志文件、退出码非 0 自动重启（3 次/30s 退避）、stop 杀进程树；`profiles.rs`：reqwest 下载(带 UA `clash-verge/compatible ClashNova/2.0`)、`subscription-userinfo` 响应头解析配额、调 nova-core 解析+生成、原子写盘
- [ ] `commands.rs`：契约 B 全部命令，串起 state/core/profiles/sysproxy；`sysproxy_win.rs`：`sysproxy` crate 设置/清除 + guard 线程(interval 检查恢复)；`tray.rs`：托盘图标 + 菜单（显示主窗口/系统代理✓/TUN✓/模式三选/退出），左键唤起主窗
- [ ] `main.rs`：插件注册、single-instance 聚焦旧窗、启动时恢复 settings 并按需自启 core、silent_start 时隐藏主窗
- [ ] 验证（WSL 无法编译 Windows 目标）：`cargo metadata --manifest-path src-tauri/Cargo.toml` 通过依赖解析；最终由 Task 5 CI 编译把关
- [ ] Commit: `feat(tauri): 应用层(内核/订阅/系统代理/托盘/命令)`

## Task 5: 构建链路（图标/内核脚本 + CI + 文档）

**Files:** Create `scripts/{gen-icons.mjs,fetch-mihomo.mjs}` `.github/workflows/build.yml` `BUILD.md` Modify `package.json`(scripts)

- [ ] `gen-icons.mjs`：用 canvas-free 纯 SVG→PNG（引 `sharp` devDep）由品牌 N 渐变方块生成 icons/{32x32,128x128,128x128@2x}.png + icon.ico(用 png-to-ico) + icon.icns 跳过
- [ ] `fetch-mihomo.mjs`：GitHub API 取 mihomo latest windows-amd64 zip → 解压为 `src-tauri/binaries/mihomo-x86_64-pc-windows-msvc.exe`
- [ ] `build.yml`：push tag `v*` 或手动触发；windows-latest；setup node20+rust stable；`npm ci` → `node scripts/fetch-mihomo.mjs` → `npm run tauri build`；上传 `src-tauri/target/release/bundle/{msi,nsis}/*` 工件；另起 ubuntu job 跑 `cargo test -p nova-core` + `npm run build`
- [ ] `BUILD.md`：Windows 本机构建三步（装 Rust/Node → fetch-mihomo → tauri build）+ CI 取包说明 + 常见问题(WebView2)
- [ ] 验证：`node --check` 两脚本；`npm run build` 仍绿
- [ ] Commit: `chore(build): 图标/内核脚本 + Windows CI + 构建文档`

## Task 6: 集成验收

- [ ] `npm install && npm run build` 零错误零警告(类型)
- [ ] `cargo test -p nova-core` 全绿
- [ ] mock 模式起服 → 无头 Chrome 七页截图，与 `design/shots/` 逐页对比无走样
- [ ] `git log` 整洁；推送后 CI 绿 → 工件含 `ClashNova_2.0.0_x64-setup.exe` 与 `.msi`
- [ ] Commit: `chore: M1 集成验收`

---

## 自检记录

- 规格覆盖：M1 清单（内核管理/订阅/代理页/系统代理/TUN/出站模式/连接/日志/规则/托盘）→ T4(内核/系统代理/TUN/托盘) T2(七页) T3+T4(订阅) ✓；M1 的"崩溃自启/版本切换 stable-alpha"中版本切换下放 M2（YAGNI，设置页已留 UI 占位）
- 类型一致性：契约 A/B/C/D 单一来源，任务均引用契约不重定义 ✓
- 占位符扫描：无 TBD/TODO；UI 细节以设计稿文件为基准属显式引用而非占位 ✓
