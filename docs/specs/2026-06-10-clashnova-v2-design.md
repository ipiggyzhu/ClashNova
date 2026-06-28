# ClashNova v2 设计文档

日期：2026-06-10 ｜ 状态：已经用户确认

## 目标

为 Windows 打造开源 Clash GUI 客户端：功能完整对齐 clash-verge-rev（不缺失），UI 复刻
ClashMac（macOS 控制中心质感），最终交付单个 exe/MSI 安装包。ClashMac 未开源，仅参考其
4 张官方截图（`design/reference/`）；图标一律不借用，使用 Lucide 风格自绘。

## 总体决策

| 项 | 决策 |
|---|---|
| 项目 | 全新工程 `/mnt/d/code/ClashNova-v2`，旧 ClashNova 仅作参考 |
| 技术栈 | Tauri 2 + Rust ｜ React 18 + TypeScript + Vite + TailwindCSS |
| 内核 | mihomo sidecar 打包，External Controller（REST + WebSocket）通信 |
| 图表 | ECharts（速率/趋势/桑基/geo 飞行地图）；编辑器 Monaco |
| 状态 | zustand + TanStack Query；流量/日志/连接由前端直连 mihomo WS |
| 许可 | MIT（仅借鉴 clash-verge-rev 思路；若移植其代码则需转 GPL-3.0） |

技术栈备选已否决：Electron（包体/内存过大）、WinUI 3 原生（开发慢、图表生态弱）。

## 功能里程碑

### M1 核心可用
- mihomo 进程管理：启停、崩溃自启、stable/alpha 版本切换
- Profiles：URL/本地/clash:// 导入、自动更新间隔、多 Profile 切换、Monaco 编辑 YAML
- 代理页：组切换、单点/批量延迟测试、节点搜索
- 系统代理（守卫模式 + bypass）、TUN 模式、出站模式（直连/规则/全局）
- 连接页（实时 WS 表格、过滤、断开）、日志页（WS 日志流、等级过滤）、规则页
- 托盘：图标 + 弹窗（迷你速率图、组快速切换、模式切换、系统代理/TUN 开关）

### M2 完整对齐 clash-verge-rev
- Merge / Script(JS) 配置增强链（Rust 侧 boa_engine）
- 服务模式（Windows 服务，TUN 免管理员）、开机自启、静默启动
- 全局热键、UWP 回环豁免、端口/DNS/IPv6/允许局域网/hosts 编辑
- 外部控制器配置、Web UI 跳转、主题（深/浅/系统 + 自定义 CSS）、中英双语
- 应用内更新器、Providers 页（代理/规则提供者）、测试页（网站连通性）

### M3 ClashMac 可视化特色
- Dashboard 总览（运行状态/网络状态/实时速率/7 天趋势/流量汇总环形图 + 多维排行）
- Topology 桑基图（IP → 进程 → 规则 → 节点 → 出站）
- Route Map 3D 球形地图（three.js 或 echarts-gl globe：拖拽旋转/滚轮缩放，支持一键
  展开为 2D 平面世界地图；GeoIP mmdb 本地定位；星空 + 大气辉光视觉）
- Traffic Stats 统计页（按代理/进程/域名多维，SQLite 持久化历史）

注：托盘弹窗是托盘交互组件（Windows 托盘 flyout），不在主窗口侧边栏出现；
设计稿中通过 mockup.html#tray 查看。

## UI 设计语言（提取自参考截图）

- 深色优先：背景 `#161618`、卡片 `#232326`、1px 微边框 `rgba(255,255,255,.06)`、12px 圆角
- 强调色 `#0A84FF`，状态绿 `#32D74B`，图表多彩（紫/青/橙渐变）
- 侧边栏 210px，分组：概览（仪表盘/流量统计/连接/日志）、可视化（拓扑/路由地图）、
  代理（节点/规则/提供者）、配置（订阅/设置）
- 顶栏：页面标题 + 出站模式分段控件 + 状态图标
- 大数字等宽（tabular-nums），卡片标题带彩色小图标
- 浅色主题同构生成；托盘弹窗按 menu_b.jpg 双主题

## 架构

```
React 前端 ── Tauri IPC ── Rust 后端 ─┬─ core.rs     mihomo sidecar 生命周期
   │                                  ├─ profiles.rs 订阅下载 → Merge → Script → 运行时配置
   │ WS 直连 mihomo:9097              ├─ sysopt.rs   系统代理/守卫/自启/UWP 回环
   │  traffic/logs/connections        ├─ service.rs  Windows 服务模式
   └─ REST 直连 mihomo 组切换/测延迟   ├─ tray.rs     托盘弹窗 + 菜单
                                      └─ hotkey / updater / deep-link（Tauri 2 插件）
```

错误处理：内核崩溃自动重启并通知；订阅拉取失败保留旧配置；配置链任一环节产物先经
mihomo `-t` 校验再热重载，失败回滚。

测试：Rust 单测（配置链/订阅解析）、前端 vitest 组件测试、手动冒烟清单（系统代理/TUN
需真机验证）。

## 交付物顺序

1. 高保真 HTML 设计稿（`design/mockup.html`，全部页面可切换）+ Stitch 提示词 → 用户过目
2. 实施计划（writing-plans）
3. M1 → M2 → M3 编码，`tauri build` 产出 exe/MSI
