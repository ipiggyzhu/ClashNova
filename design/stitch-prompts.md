# ClashNova v2 — Google Stitch 提示词文档

> 设计语言：深色 macOS 控制中心质感 · 桌面端 1280×800
> bg `#161618` / card `#232326` (1px subtle border, radius 12px) / accent `#0A84FF` / status green `#32D74B`
> charts: purple `#BF5AF2` · cyan `#64D2FF` · orange `#FF9F0A` / 左侧分组侧边栏 210px / 顶栏 Direct·Rule·Global 分段控件 / SF Pro 风格字体

## 使用说明

打开 [stitch.withgoogle.com](https://stitch.withgoogle.com) 新建项目，**模式务必选择 Desktop（桌面 / Web）**，否则会按手机比例出图。每个页面一节提示词，均为**自包含**的英文提示词（已内嵌应用背景与风格要点），直接整段复制到 Stitch 输入框生成即可，不需要附加其他上下文；建议一次只生成一个页面，生成后用追加指令微调。如果在同一个 Stitch 项目里连续生成多个页面、或在多轮对话中风格出现漂移（颜色、圆角、侧边栏不一致），把下方「Style Preamble」整段粘贴为追加消息，提醒模型回到统一风格基线。生成结果导出时优先用 Figma / HTML 导出，色值以本文档十六进制为准做最终校对。

## 通用 Style Preamble（可复用）

```text
ClashNova v2 is a Windows desktop Clash proxy client styled like the macOS Control
Center in dark mode, rendered in a 1280×800 desktop app frame. Background #161618;
cards and panels #232326 with a subtle 1px light border (white at ~8% opacity) and
12px corner radius. Accent blue #0A84FF for active states and primary buttons;
status green #32D74B for healthy/connected; chart palette purple #BF5AF2, cyan
#64D2FF, orange #FF9F0A. A 210px-wide left sidebar with grouped navigation
sections (Overview, Network, Config, App), each item with a small monochrome
glyph, the active item on a rounded blue tint. The top bar holds the app title,
a Direct / Rule / Global segmented control with a blue active segment, and a
connection status pill. SF Pro-like typography: semibold 15px headings, 13px
body, 11px secondary text in #98989D. 8px spacing grid, 16px card padding, soft
shadows, smooth rounded toggles and controls — a clean native macOS feel.
```

---

## 1. Dashboard 仪表盘

```text
ClashNova v2 is a Windows Clash proxy client with a dark macOS Control Center
look: 1280×800 desktop frame, #161618 background, #232326 cards with subtle 1px
borders and 12px radius, #0A84FF accent, SF Pro-like type, a 210px grouped left
sidebar (Dashboard active) and a top bar with a Direct/Rule/Global segmented
control. Design the Dashboard as a dense card grid. Top row: a Running Status
card with a pulsing green #32D74B dot, "Clash core running", uptime and version,
plus toggles for System Proxy and TUN Mode; next to it a Network Status card
showing public IP, ISP, region flag and ping. Middle: a wide real-time speed
line chart with two smooth glowing curves — cyan #64D2FF download, purple
#BF5AF2 upload — and current speeds as large numerals with ↓/↑ glyphs. Bottom
row: a 7-day traffic bar chart in orange #FF9F0A with weekday labels, and a
traffic summary card pairing a multicolor donut chart with a ranked list of top
processes and their usage.
```

## 2. Traffic Stats 流量统计

```text
ClashNova v2 is a Windows Clash proxy client styled like the dark macOS Control
Center: 1280×800 desktop frame, #161618 background, #232326 cards with 1px
subtle borders and 12px radius, #0A84FF accent, SF Pro-like typography, a 210px
grouped left sidebar (Traffic Stats active) and a top bar with a
Direct/Rule/Global segmented control. Design the Traffic Stats page. Header row:
four KPI cards — Total Upload, Total Download, Active Time, Sessions — each with
a small colored sparkline. Below, a large stacked area chart of upload (purple
#BF5AF2) and download (cyan #64D2FF) over time, with a Today / 7 Days / 30 Days
segmented filter and a hover crosshair tooltip. Bottom split: on the left a
donut chart breaking traffic down by proxy group in purple, cyan, orange #FF9F0A
and green #32D74B with a center total; on the right a per-application table with
app icon, name, upload, download, total and a thin proportional usage bar.
```

## 3. Connections 连接表

```text
ClashNova v2 is a Windows Clash proxy client with a dark macOS Control Center
aesthetic: 1280×800 desktop frame, #161618 background, #232326 cards with 1px
subtle borders and 12px radius, #0A84FF accent, SF Pro-like type, a 210px
grouped left sidebar (Connections active) and a top bar with a
Direct/Rule/Global segmented control. Design the Connections page as a live
table. Toolbar: a rounded search field "Filter host, process or rule", network
and source dropdown filters, a Pause button, a red-tinted Close All button, and
a counter "Active: 247 · ↓ 4.2 MB/s ↑ 860 KB/s". The full-width table sits on a
card with a sticky header and columns: Host, Process (tiny app icon), Rule,
Chain, DL Speed, UL Speed, Total, Duration, Destination IP. Speed cells are
tinted cyan #64D2FF and purple #BF5AF2; rules are small gray pills; one hovered
row glows and reveals an × close action. A right-side drawer shows key-value
details for the selected connection.
```

## 4. Logs 日志控制台

```text
ClashNova v2 is a Windows Clash proxy client with a dark macOS Control Center
aesthetic: 1280×800 desktop frame, #161618 background, #232326 cards with 1px
subtle borders and 12px radius, #0A84FF accent, SF Pro-like UI type, a 210px
grouped left sidebar (Logs active) and a top bar with a Direct/Rule/Global
segmented control. Design the Logs console page. Toolbar: a log-level segmented
filter — All, Info, Warning, Error, Debug — a search box, a green #32D74B LIVE
indicator dot, Pause and Clear buttons, and an export icon button. The main area
is a full-height #1B1B1D console card with monospaced 12px text: each line has a
dim gray timestamp, a colored level tag (Info cyan #64D2FF, Warning orange
#FF9F0A, Error red #FF453A, Debug purple #BF5AF2) and a message such as "[TCP]
github.com:443 matched RULE-SET:proxy → HK-IEPL-01". Highlight one searched
keyword in blue #0A84FF. An auto-scroll toggle floats bottom-right; a slim
status bar shows line count and buffer size.
```

## 5. Topology 拓扑桑基图

```text
ClashNova v2 is a Windows Clash proxy client with a dark macOS Control Center
aesthetic: 1280×800 desktop frame, #161618 background, #232326 cards with 1px
subtle borders and 12px radius, #0A84FF accent, SF Pro-like type, a 210px
grouped left sidebar (Topology active) and a top bar with a Direct/Rule/Global
segmented control. Design the Topology page as a full-bleed Sankey flow diagram
on one large card. Five labeled columns left to right: Source IP → Process →
Rule Set → Proxy Node → Outbound. Nodes are small rounded #2C2C2F blocks with
white labels and traffic totals; flowing ribbons connect them with translucent
gradients in purple #BF5AF2, cyan #64D2FF, orange #FF9F0A and green #32D74B,
ribbon thickness proportional to traffic volume. One hovered path —
chrome.exe → RULE-SET:streaming → HK-IEPL-01 → Proxy — renders at full opacity
while all other ribbons dim. Top-right shows a color legend and a time-range
selector; the bottom edge carries a total flow summary line.
```

## 6. Route Map 路由地图

```text
ClashNova v2 is a Windows Clash proxy client with a dark macOS Control Center
aesthetic: 1280×800 desktop frame, #161618 background, #232326 cards with 1px
subtle borders and 12px radius, #0A84FF accent, SF Pro-like type, a 210px
grouped left sidebar (Route Map active) and a top bar with a Direct/Rule/Global
segmented control. Design the Route Map page as one immersive map card: a dark
flat 2D vector map of the Asia-Pacific region, landmasses in #1C1C1F with faint
borders over a #131315 ocean, no satellite texture. The user's location in
eastern China is a pulsing blue #0A84FF dot; proxy nodes in Hong Kong, Tokyo,
Singapore, Seoul and Los Angeles are glowing green #32D74B markers labeled with
latency ("HK 42ms"). Curved glowing flight arcs in a cyan #64D2FF → purple
#BF5AF2 gradient connect the user to active nodes, with tiny white plane icons
mid-arc and subtle dashed motion trails. A floating glass panel top-left lists
active routes with live speeds; zoom controls sit bottom-right.
```

## 7. Proxies 代理节点

```text
ClashNova v2 is a Windows Clash proxy client with a dark macOS Control Center
aesthetic: 1280×800 desktop frame, #161618 background, #232326 cards with 1px
subtle borders and 12px radius, #0A84FF accent, SF Pro-like type, a 210px
grouped left sidebar (Proxies active) and a top bar with a Direct/Rule/Global
segmented control. Design the Proxies page. Top toolbar: a search field, a sort
dropdown (Latency / Name / Default), and a blue "Test All" button with a
lightning icon. Content is a vertical stack of proxy group cards; each header
shows the group name ("Auto Select", "Streaming", "Games"), a type tag
(url-test or select), the currently selected node name, an average-latency
badge and an expand chevron. The first card is expanded into a responsive grid
of node tiles: each tile shows node name, region flag and a latency badge pill
— green #32D74B under 100ms, orange #FF9F0A for 100–300ms, red #FF453A for
timeout. The active node tile has a blue #0A84FF border and a checkmark.
```

## 8. Rules 规则列表

```text
ClashNova v2 is a Windows Clash proxy client with a dark macOS Control Center
aesthetic: 1280×800 desktop frame, #161618 background, #232326 cards with 1px
subtle borders and 12px radius, #0A84FF accent, SF Pro-like type, a 210px
grouped left sidebar (Rules active) and a top bar with a Direct/Rule/Global
segmented control. Design the Rules page. Toolbar: a search field "Search 8,432
rules", a rule-type filter dropdown and a total counter chip. The main list is
one tall card of compact rows: each row shows a dim sequence number, a
color-coded rule-type chip (DOMAIN-SUFFIX cyan #64D2FF, DOMAIN-KEYWORD purple
#BF5AF2, GEOIP orange #FF9F0A, RULE-SET green #32D74B, MATCH gray), the payload
in white text such as "googlevideo.com", and the target policy right-aligned as
a small pill — Proxy in blue #0A84FF, DIRECT in gray, REJECT in red. Rows
highlight on hover with smooth virtual scrolling. A slim right-side summary
panel shows rule counts per type as tiny horizontal bars.
```

## 9. Providers 提供者

```text
ClashNova v2 is a Windows Clash proxy client with a dark macOS Control Center
aesthetic: 1280×800 desktop frame, #161618 background, #232326 cards with 1px
subtle borders and 12px radius, #0A84FF accent, SF Pro-like type, a 210px
grouped left sidebar (Providers active) and a top bar with a Direct/Rule/Global
segmented control. Design the Providers page with an "Update All" button in the
page header and two sections titled "Proxy Providers" and "Rule Providers".
Each provider is a wide card row showing its name, a type tag (HTTP / File),
node or rule count, "Updated 2 hours ago", a heartbeat health icon, and
right-aligned circular icon buttons for refresh and health-test in blue
#0A84FF. Proxy provider cards add a thin traffic-quota progress bar ("38.2 GB
of 200 GB used") in a cyan #64D2FF → purple #BF5AF2 gradient plus an expiry
date in #98989D. Show one card mid-refresh with a spinner and a green #32D74B
"Updated" toast in the top-right corner.
```

## 10. Profiles 配置订阅

```text
ClashNova v2 is a Windows Clash proxy client with a dark macOS Control Center
aesthetic: 1280×800 desktop frame, #161618 background, #232326 cards with 1px
subtle borders and 12px radius, #0A84FF accent, SF Pro-like type, a 210px
grouped left sidebar (Profiles active) and a top bar with a Direct/Rule/Global
segmented control. Design the Profiles page. Top: an "Import subscription URL"
input with a blue Download button and a secondary "+ New" button. Below, a
two-column grid of subscription profile cards: each shows the profile name with
a provider favicon, a cyan #64D2FF traffic usage progress bar labeled
"38.2 / 200 GB", expiry date, last-updated time and a ··· menu; the active
profile card carries a blue #0A84FF border and a green #32D74B "Active" badge.
The bottom section, "Enhancement Chain", visualizes a horizontal pipeline —
Profile → Merge (YAML icon) → Script (JS icon) → Final Config — as rounded
nodes joined by arrows with a purple #BF5AF2 glow, each node with an enable
toggle and an edit button.
```

## 11. Settings 设置

```text
ClashNova v2 is a Windows Clash proxy client with a dark macOS Control Center
aesthetic: 1280×800 desktop frame, #161618 background, #232326 cards with 1px
subtle borders and 12px radius, #0A84FF accent, SF Pro-like type, a 210px
grouped left sidebar (Settings active) and a top bar with a Direct/Rule/Global
segmented control. Design the Settings page as grouped macOS-style preference
sections, each a card with rows separated by hairline dividers and
right-aligned controls. "Network": System Proxy toggle on in blue #0A84FF, TUN
Mode toggle with a stack dropdown, Mixed Port stepper at 7890, Allow LAN
toggle. "Service": service-mode status with a green #32D74B "Installed" badge
and Reinstall / Uninstall buttons. "Hotkeys": rows with recorded shortcuts
rendered as keycap chips like Ctrl+Alt+P for toggling the proxy. "Appearance":
a theme picker of Dark / Light / Auto thumbnail cards with Dark selected,
accent color dots and a language dropdown. "General": launch at login, silent
start, auto-update. A settings search field sits top-right.
```

## 12. Tray Popover 托盘弹窗

```text
ClashNova v2 is a Windows Clash proxy client with a dark macOS Control Center
aesthetic — #161618 and #232326 surfaces, subtle 1px borders, 12px radius,
#0A84FF accent, SF Pro-like typography. Instead of the full app window, design
a compact 340×460 system tray popover floating over a dimmed blurred desktop
wallpaper, with a soft drop shadow and a small anchor arrow at the top edge.
Inside: a header with the app glyph, a "Connected" label beside a green #32D74B
dot, and a master power toggle; under it a mini Direct / Rule / Global
segmented control. Then a small live sparkline area chart of network speed in
cyan #64D2FF and purple #BF5AF2 with current ↓/↑ numerals. Below, a "Quick
Switch" list of three proxy groups, each row showing group name, current node
and a latency badge; one row is expanded revealing selectable nodes with a blue
checkmark on the active one. Footer: a row of small icon buttons — open
dashboard, profiles, settings, quit.
```
