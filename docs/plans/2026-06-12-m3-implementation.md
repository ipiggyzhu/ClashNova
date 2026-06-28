# M3 实施计划 — ClashMac 可视化特色

日期：2026-06-12　前置：M2 已完成（b6d7fd1）

## 任务拆解（依赖序）

### T1 流量统计后端（Rust + SQLite）
- `stats.rs`：后台任务每 2s 轮询 mihomo `GET /connections`，按连接 id 差分
  增量字节，归因到 **代理链出口 / 进程 / 域名** 三维度；分钟桶聚合，
  每分钟落 SQLite（rusqlite bundled，库文件 `stats.db`）。
- 表 `traffic_minute(ts, dim, key, up, down)`，dim ∈ proxy|process|host。
- 命令：`query_traffic_series(range)` → 按天/小时聚合的总量序列;
  `query_traffic_rank(dim, range)` → TopN 排行。mock 造数对齐。

### T2 流量统计页（前端，纯 SVG/CSS 图表）
- 维度 Seg(代理/进程/域名) + 区间 Seg(今日/7 天/30 天)；
  趋势面积图(复用 Spark)、TopN 水平条形排行、明细表。
- 替换占位路由。

### T3 Dashboard 真实化
- 7 天趋势 / 流量汇总环形图 / 多维排行接 T1 命令（mock 同步）；
- 网络状态卡：互联网/DNS 延迟探测(test 页 probe 复用)、本机 IP。

### T4 Topology 桑基图（前端）
- 数据：/connections 快照分组 进程 → 规则 → 节点链 → 出站；
- 自研迷你 sankey 布局（列内按流量排序，贝塞尔联带，宽度∝流量），
  视觉对齐 design/pages/05-topology.html。

### T5 路由地图 3D 球体（前端）
- `globe.gl`(three.js)：暗色六边形大陆 + 出口地区弧线（流量加权），
  拖拽旋转/滚轮缩放；`平面视图` 切换为等距圆柱 SVG 同数据；
- 出口定位：节点名地区前缀/旗帜 → 内置经纬表（GeoIP mmdb 留 M4）。
- 世界轮廓数据 bundle（world-atlas topojson 110m）。

## 验证
`cargo test -p nova-core` 不回归；`npm run build` 零错误；
traffic/dashboard/topology/routemap 截图比对设计稿。
