/**
 * 英文字典:键为界面中文原文(zh 即恒等),值为英文。
 * 缺失键回退中文原文,新增文案先写中文再补译。
 */
export const EN: Record<string, string> = {
  /* 侧边栏 */
  概览: 'Overview', 可视化: 'Visualize', 代理: 'Proxy', 配置: 'Config',
  仪表盘: 'Dashboard', 流量统计: 'Traffic', 连接: 'Connections', 日志: 'Logs',
  拓扑: 'Topology', 路由地图: 'Route Map', 节点: 'Proxies', 规则: 'Rules',
  提供者: 'Providers', 测试: 'Test', 订阅: 'Profiles',
  设置: 'Settings',
  'Mihomo 运行中': 'Mihomo Running', 'Mihomo 已停止': 'Mihomo Stopped',
  内存: 'Mem',
  /* 顶栏 */
  直连: 'Direct', 全局: 'Global', 通知: 'Notifications', 切换主题: 'Toggle theme',
  最小化: 'Minimize', 最大化: 'Maximize', 关闭窗口: 'Close',
  /* 通用 */
  保存: 'Save', 取消: 'Cancel', 编辑: 'Edit', 删除: 'Delete', 确认: 'Confirm',
  更新: 'Update', 导入: 'Import', 新建: 'New', 启用: 'Enable', 添加: 'Add',
  清空: 'Clear All', 全部已读: 'Mark All Read', 暂无通知: 'No notifications',
  复制: 'Copy', 刷新: 'Refresh', 重试: 'Retry', '加载中…': 'Loading…',
  '更新中…': 'Updating…', '导入中…': 'Importing…', '检查中…': 'Checking…',
  当前运行配置: 'Current Runtime Config',
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
  显示: 'Show', 隐藏: 'Hide',
  运行中: 'Running', 已停止: 'Stopped', 需修复: 'Repair Required',
  '处理中…': 'Processing…', '检测中…': 'Checking…', 检测不支持: 'Unsupported',
  网卡就绪: 'Adapter Ready', 网卡未就绪: 'Adapter Not Ready',
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
  'Web UI 修改会立即影响 mihomo 运行态；ClashNova 仅跟随模式和代理选择，其他设置仍以本软件为准':
    'Web UI changes affect mihomo runtime immediately; ClashNova only follows mode and proxy selection, while other settings remain owned by this app',
  跳转面板: 'Open Dashboard',
  /* 设置-热键 */
  热键: 'Hotkeys', '显示 / 隐藏主窗口': 'Show / Hide Window',
  切换系统代理: 'Toggle System Proxy', '切换 TUN 模式': 'Toggle TUN Mode',
  出站模式轮换: 'Cycle Outbound Mode',
  点击录制: 'Click to record', 按下组合键: 'Press keys…', 清除: 'Clear',
  /* 设置-关于 */
  关于: 'About', 检查更新: 'Check Updates', 已是最新: 'Up to date',
  下载更新: 'Download Update', 检查失败: 'Check Failed',
  开源协议: 'License', 'GitHub 仓库': 'GitHub Repository', 目录: 'Folders',
  配置目录: 'Config Dir', 内核目录: 'Core Dir', 日志目录: 'Logs Dir',
  重置: 'Reset', 恢复全部设置为默认值: 'Restore all settings to defaults',
  恢复默认设置: 'Restore Defaults',
  '确认恢复默认设置?': 'Restore default settings?',
  /* DNS 高级配置 */
  高级: 'Advanced', 重置为默认值: 'Reset to Defaults',
  '启用 DNS': 'Enable DNS', 'DNS 监听地址': 'DNS Listen Address',
  增强模式: 'Enhanced Mode', 关闭: 'Off',
  'Fake IP 范围': 'Fake IP Range', 'Fake IP 过滤模式': 'Fake IP Filter Mode',
  黑名单: 'Blacklist', 白名单: 'Whitelist',
  '启用 IPv6 DNS 解析': 'Enable IPv6 DNS resolution',
  '优先使用 HTTP/3': 'Prefer HTTP/3', 'DNS DOH 使用 HTTP/3 协议': 'DNS DOH use HTTP/3 protocol',
  遵循路由规则: 'Respect Rules', 'DNS 连接遵循路由规则': 'DNS connections follow routing rules',
  '使用 Hosts': 'Use Hosts', '启用通过 hosts 文件解析域名': 'Enable domain resolution via hosts file',
  '使用系统 Hosts': 'Use System Hosts', '启用通过操作系统 hosts 文件解析': 'Enable resolution via OS hosts file',
  '高级配置会覆盖下方的"DNS 覆写"编辑器设置。如需精细调整 nameserver、fallback 等，请使用编辑器。':
    'Advanced settings override the "DNS Override" editor below. Use the editor for fine-tuning nameserver, fallback, etc.',
  'DNS 覆写编辑器中包含 enhanced-mode 设置，将覆盖上方的增强模式配置':
    'The DNS Override editor contains enhanced-mode settings, which will override the Enhanced Mode configuration above',
  'DNS 监听地址格式错误，应为 host:port': 'Invalid DNS listen address format, should be host:port',
  '端口范围应为 1-65535': 'Port range should be 1-65535',
  'Fake IP 范围格式错误，应为 CIDR 格式（如 198.18.0.1/16）':
    'Invalid Fake IP range format, should be CIDR format (e.g. 198.18.0.1/16)',
  'IP 地址段应为 0-255': 'IP address octet should be 0-255',
  'CIDR 前缀应为 1-32': 'CIDR prefix should be 1-32',
  /* 编辑抽屉 */
  'DNS 覆写编辑(YAML, 留空关闭)': 'Edit DNS override (YAML, empty to disable)',
  'hosts 覆写编辑(每行: 域名 IP)': 'Edit hosts override (per line: domain IP)',
  '自定义 CSS 编辑(留空关闭)': 'Edit custom CSS (empty to disable)',
  已启用: 'Enabled', 未启用: 'Disabled',
}
