/**
 * 英文字典:键为界面中文原文(zh 即恒等),值为英文。
 * 缺失键回退中文原文,新增文案先写中文再补译。
 */
export const EN: Record<string, string> = {
  /* 侧边栏 */
  概览: 'Overview', 可视化: 'Visualize', 代理: 'Proxy', 配置: 'Config',
  仪表盘: 'Dashboard', 流量统计: 'Traffic', 连接: 'Connections', 日志: 'Logs',
  拓扑: 'Topology', 路由地图: 'Route Map', 节点: 'Proxies', 规则: 'Rules',
  提供者: 'Providers', 测试: 'Test', 订阅: 'Profiles', 设置: 'Settings',
  'Mihomo 运行中': 'Mihomo Running', 'Mihomo 已停止': 'Mihomo Stopped',
  内存: 'Mem',
  /* 顶栏 */
  直连: 'Direct', 全局: 'Global', 通知: 'Notifications', 切换主题: 'Toggle theme',
  最小化: 'Minimize', 最大化: 'Maximize', 关闭: 'Close',
  /* 通用 */
  保存: 'Save', 取消: 'Cancel', 编辑: 'Edit', 删除: 'Delete', 确认: 'Confirm',
  更新: 'Update', 导入: 'Import', 新建: 'New', 启用: 'Enable', 添加: 'Add',
  '更新中…': 'Updating…', '导入中…': 'Importing…', '检查中…': 'Checking…',
  /* 设置-系统 */
  系统: 'System', 系统代理: 'System Proxy',
  '修改 Windows Internet 设置, 流量经由混合端口':
    'Modify Windows Internet settings, traffic via mixed port',
  守卫模式: 'Guard Mode', 代理绕过: 'Proxy Bypass',
  'TUN 模式': 'TUN Mode', '虚拟网卡接管全部流量, 需服务模式':
    'Virtual NIC takes over all traffic, requires service mode',
  服务模式: 'Service Mode', '以 Windows 服务运行内核, TUN 免管理员':
    'Run core as Windows service, TUN without admin',
  开机自启: 'Auto Start', '登录 Windows 时自动启动': 'Launch on Windows login',
  静默启动: 'Silent Start', '启动时仅驻留托盘, 不显示主窗口':
    'Start minimized to tray without main window',
  已安装: 'Installed', 未安装: 'Not Installed', 安装: 'Install', 卸载: 'Uninstall',
  /* 设置-界面 */
  界面: 'Interface', 主题: 'Theme', 深色: 'Dark', 浅色: 'Light', 跟随系统: 'System',
  强调色: 'Accent Color', '自定义 CSS': 'Custom CSS',
  注入自定义样式覆盖主题: 'Inject custom styles to override theme',
  语言: 'Language', 启动页: 'Start Page',
  /* 设置-内核 */
  'Clash 内核': 'Clash Core', 混合端口: 'Mixed Port',
  'HTTP + SOCKS5 共用端口': 'Shared port for HTTP + SOCKS5',
  外部控制: 'External Controller', 'RESTful API 监听地址': 'RESTful API listen address',
  'API 密钥': 'API Secret', '外部控制鉴权 secret': 'External controller auth secret',
  允许局域网: 'Allow LAN', 局域网设备可经本机代理: 'LAN devices may proxy via this host',
  日志等级: 'Log Level', 'DNS 覆写': 'DNS Override', 'hosts 覆写': 'Hosts Override',
  内核版本: 'Core Channel', 重启内核: 'Restart Core',
  'UWP 回环豁免': 'UWP Loopback', 解除商店应用回环限制:
    'Exempt Store apps from loopback restriction',
  立即豁免: 'Exempt Now', 'Web UI': 'Web UI',
  在浏览器中打开外部控制面板: 'Open external controller dashboard in browser',
  跳转面板: 'Open Dashboard',
  /* 设置-热键 */
  热键: 'Hotkeys', '显示 / 隐藏主窗口': 'Show / Hide Window',
  切换系统代理: 'Toggle System Proxy', '切换 TUN 模式': 'Toggle TUN Mode',
  出站模式轮换: 'Cycle Outbound Mode',
  点击录制: 'Click to record', 按下组合键: 'Press keys…', 清除: 'Clear',
  /* 设置-关于 */
  关于: 'About', 检查更新: 'Check Updates', 已是最新: 'Up to date',
  开源协议: 'License', 'GitHub 仓库': 'GitHub Repository', 目录: 'Folders',
  配置目录: 'Config Dir', 内核目录: 'Core Dir', 日志目录: 'Logs Dir',
  重置: 'Reset', 恢复全部设置为默认值: 'Restore all settings to defaults',
  恢复默认设置: 'Restore Defaults',
  '确认恢复默认设置?': 'Restore default settings?',
  /* 编辑抽屉 */
  'DNS 覆写编辑(YAML, 留空关闭)': 'Edit DNS override (YAML, empty to disable)',
  'hosts 覆写编辑(每行: 域名 IP)': 'Edit hosts override (per line: domain IP)',
  '自定义 CSS 编辑(留空关闭)': 'Edit custom CSS (empty to disable)',
  已启用: 'Enabled', 未启用: 'Disabled',
}
