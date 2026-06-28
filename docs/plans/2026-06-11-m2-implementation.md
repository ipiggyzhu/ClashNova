# M2 实施计划 — 完整对齐 clash-verge-rev

日期：2026-06-11　前置：M1 已完成（9a47405）

## 范围（设计文档 M2 节）

Merge/Script 配置增强链、服务模式、热键、UWP 回环豁免、DNS/hosts 编辑、
自定义 CSS、中英双语、应用内更新器、Providers 页、测试页、编辑器升级。

## 验证基线

- WSL 可验证：`cargo test -p nova-core`（增强链单测）、`npm run build`、
  mock 模式截图（Providers 页/测试页/设置新项）。
- 仅 CI 可验证：src-tauri 新增 Rust 代码（windows-latest 编译）。

## 任务拆解（依赖序）

### T1 nova-core 增强链（可测）
- `script.rs`：boa_engine 执行 `function main(config){...}`；
  YAML→JSON 注入，`JSON.stringify(main(JSON.parse(...)))` 取回；
  语法错误/运行时错误/返回非对象 → `CoreError::Script(描述)`。
- `chain.rs`：`EnhancerItem::{Merge(Value), Script(String)}`，
  `apply_chain(base, &[item])` 逐项应用，fail-fast 带序号报错。
- 单测：merge 项、script 项、链式顺序、script 报错回传。

### T2 增强链接入 profiles（Rust + 前端）
- `ProfileMeta` 增加 `enhancers: Vec<EnhancerMeta>{id,kind,name,enabled}`；
  增强项内容存 `profiles/<pid>.merge-<eid>.yaml` / `.script-<eid>.js`。
- 命令（契约 B 扩展）：`list_enhancers` / `save_enhancer` / `delete_enhancer` /
  `toggle_enhancer`（含内容读写）。
- `regenerate_runtime`：订阅原文 → 链式增强 → build_runtime_config；
  增强链任一失败 → 跳过该项并记日志（不阻断内核）。
- 前端 Profiles 页：解锁增强链卡片（M1 占位禁用态），新增/编辑（抽屉
  textarea，T8 升级 CodeMirror）/启停/删除；mock 同步。

### T3 Providers 页（前端为主）
- REST：`GET /providers/proxies`、`GET /providers/rules`、
  `PUT /providers/proxies/:name`（更新）、healthcheck。
- 页面：两组卡片列表（名称/类型/节点或规则数/更新时间/更新按钮）；
  替换 M1 占位路由；mock 数据。

### T4 测试页（前端）
- 内置测试站点网格（Google/GitHub/YouTube/Cloudflare…，可增删，存 settings）；
  通过 `Image/fetch no-cors 计时` 经当前代理测连通性与延迟，彩色徽章。
- 替换 M1 占位路由；mock 模式直接出模拟延迟。

### T5 i18n 中英双语（前端）
- 轻量自研：`src/i18n/{zh.ts,en.ts,index.tsx}`，`useT()` hook + zustand
  language 状态；settings 增加语言项；全部页面文案过 `t()`。

### T6 设置扩展（前端 + Rust）
- 新分组：DNS 覆写（开关 + nameserver 列表）、hosts 编辑（textarea）、
  自定义 CSS（textarea，注入 `<style id="custom-css">`）、Web UI 跳转按钮、
  热键配置（录制控件）、UWP 回环豁免按钮、服务模式安装/卸载按钮。
- `AppSettings` 扩展：`language/customCss/dnsOverride/hosts/hotkeys`；
  config_gen 接 DNS/hosts 覆写。

### T7 src-tauri 系统能力（仅 CI 验证）
- 热键：`tauri-plugin-global-shortcut`（显隐窗口/切系统代理/切 TUN）。
- UWP 回环：`CheckNetIsolation.exe LoopbackExempt -a` 调用 + 枚举。
- 服务模式 `service.rs`：`sc.exe create/delete/start/stop` 包装 mihomo
  服务（`--service` 参数运行），TUN 免管理员；状态查询命令。
- 更新器：`tauri-plugin-updater` + GitHub Releases latest.json 端点，
  settings 增加「检查更新」。

### T8 编辑器升级（前端）
- CodeMirror 6（yaml/javascript 语言包，比 Monaco 轻量、Vite 零配置），
  替换 Profiles 编辑抽屉与增强项编辑的 textarea。

## 验收

1. `cargo test -p nova-core` 全绿（新增 ≥6 链路单测）。
2. `npm run build` 零错误；mock 截图：Providers/测试页/Profiles 增强链/
   设置新分组、中英切换各一张。
3. CI windows-latest 编译通过（推 tag 验证）。
