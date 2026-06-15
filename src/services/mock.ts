/**
 * 模拟数据层 — 契约 B 全部命令的内存实现 + REST/WS 造数器。
 * 数据与设计稿一致(design/pages/03-connections.html、07-proxies.html、
 * 08-rules.html、10-profiles.html、11-settings.html)。
 */
import type {
  AppSettings,
  ConnItem,
  ConnectionsPayload,
  CoreStatus,
  EnhancerMeta,
  LogItem,
  ProfileMeta,
  ProxiesPayload,
  ProxyGroup,
  ProxyNode,
  ProxyProviderItem,
  RuleItem,
  RuleProviderItem,
} from '../types/clash'

/* ============================== 工具 ============================== */

const KB = 1024
const MB = 1024 * 1024
const GB = 1024 * 1024 * 1024
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** 在 base 附近做 ±ratio 的微扰(非负) */
function jitter(base: number, ratio = 0.15): number {
  return Math.max(0, Math.round(base * rand(1 - ratio, 1 + ratio)))
}

/* ============================== 设置 ============================== */

/** 默认设置 — 取自 design/pages/11-settings.html 的展示值 */
export const DEFAULT_SETTINGS: AppSettings = {
  sysProxy: true,
  guard: true,
  guardIntervalSec: 30,
  bypass: 'localhost;127.*;10.*;192.168.*',
  tun: false,
  autostart: true,
  silentStart: false,
  mixedPort: 7897,
  externalController: '127.0.0.1:9097',
  secret: '7kQx2mZpR4',
  allowLan: false,
  ipv6: false,
  logLevel: 'info',
  mode: 'rule',
  theme: 'dark',
  language: 'zh',
  customCss: '',
  dnsOverride: '',
  hosts: '',
  hotkeys: {},
  /* DNS 高级配置默认值 */
  enableDns: true,
  dnsListen: '127.0.0.1:5335',
  dnsEnhancedMode: 'fake-ip',
  fakeIpRange: '198.18.0.1/16',
  fakeIpFilterMode: 'blacklist',
  ipv6Dns: false,
  preferH3: false,
  respectRules: false,
  useHosts: false,
  useSystemHosts: false,
}

let settings: AppSettings = { ...DEFAULT_SETTINGS }

// 截图/走查辅助: mock 模式允许 ?lang=en&theme=light 预置设置
if (typeof location !== 'undefined') {
  const qs = new URLSearchParams(location.search)
  const lang = qs.get('lang')
  if (lang === 'en' || lang === 'zh') settings.language = lang
  const theme = qs.get('theme')
  if (theme === 'light' || theme === 'dark') settings.theme = theme
}

/** 服务模式安装状态(M2 mock) */
let serviceInstalled = false
let serviceRunning = false

/* ============================== 内核状态 ============================== */

const coreBootAt = Date.now() - 47 * MIN

const core: { running: boolean } = { running: true }

function coreStatus(): CoreStatus {
  return {
    running: core.running,
    version: 'v1.19.2',
    uptimeSec: core.running ? Math.floor((Date.now() - coreBootAt) / 1000) : 0,
    memoryBytes: core.running ? jitter(63 * MB, 0.04) : 0,
  }
}

/* ============================== 订阅 Profile ============================== */

const BIGAIRPORT_YAML = `# BigAirport 订阅(模拟)
mixed-port: 7897
mode: rule
log-level: info
proxies:
  - { name: HK-PCCW, type: trojan, server: hk1.bigairport.io, port: 443, password: mock }
  - { name: HK-ViuTV, type: vless, server: hk2.bigairport.io, port: 443, uuid: mock }
  - { name: US-OpenAI, type: trojan, server: us1.bigairport.io, port: 443, password: mock }
proxy-groups:
  - { name: Streaming, type: select, proxies: [HK-PCCW, HK-ViuTV] }
  - { name: AI, type: url-test, proxies: [US-OpenAI], url: 'https://www.gstatic.com/generate_204', interval: 300 }
rules:
  - DOMAIN-SUFFIX,openai.com,AI
  - DOMAIN-KEYWORD,youtube,Streaming
  - GEOIP,CN,DIRECT
  - MATCH,Fallback
`

const FULL_EN_YAML = `# full.en 本地配置(模拟)
mixed-port: 7897
mode: rule
proxies: []
proxy-groups: []
rules:
  - MATCH,DIRECT
`

interface MockProfile { meta: ProfileMeta; content: string }

let profileSeq = 2

let profiles: MockProfile[] = [
  {
    meta: {
      id: 'p-bigairport',
      name: 'BigAirport',
      kind: 'remote',
      url: 'https://sub.bigairport.io/api/v1/client/subscribe?token=mock',
      updatedAt: Date.now() - 2 * HOUR,
      autoUpdateMin: 1440,
      sizeBytes: 184 * KB,
      quota: {
        used: 162.4 * GB,
        total: 500 * GB,
        expireAt: Date.now() + 37 * DAY,
      },
      current: true,
      enhancers: [
        { id: 'e-dns', kind: 'merge', name: 'Merge: 覆写 DNS 与端口', enabled: true },
        { id: 'e-rename', kind: 'script', name: 'Script: 节点改名+地区分组', enabled: true },
        { id: 'e-prune', kind: 'script', name: 'Script: 去除无效节点', enabled: false },
      ],
    },
    content: BIGAIRPORT_YAML,
  },
  {
    meta: {
      id: 'p-full-en',
      name: 'full.en',
      kind: 'local',
      url: 'C:\\Users\\piggy\\.config\\clash\\full.en.yaml',
      updatedAt: new Date('2026-05-28T10:00:00+08:00').getTime(),
      sizeBytes: Math.round(12.6 * KB),
      current: false,
    },
    content: FULL_EN_YAML,
  },
]

function findProfile(id: string): MockProfile {
  const p = profiles.find((it) => it.meta.id === id)
  if (!p) throw new Error(`订阅不存在: ${id}`)
  return p
}

/* ============================== 代理(契约 C /proxies) ============================== */

type ProxyEntry = ProxyNode & Partial<ProxyGroup>

function node(name: string, type: string, delay?: number): ProxyEntry {
  const history =
    delay === undefined
      ? []
      : [{ time: new Date(Date.now() - 4 * MIN).toISOString(), delay }]
  return { name, type, udp: true, history, ...(delay === undefined ? {} : { delay }) }
}

function group(
  name: string,
  type: ProxyGroup['type'],
  now: string,
  all: string[],
): ProxyEntry {
  return { name, type, now, all, history: [] }
}

/** 节点延迟基准 — 与 design/pages/07-proxies.html 一致(undefined = 超时) */
const NODE_DEFS: [string, string, number | undefined][] = [
  ['HK-PCCW', 'Trojan', 42],
  ['HK-ViuTV', 'VLESS', 51],
  ['HK-03', 'SS', 86],
  ['JP-AbemaTV', 'Hysteria2', 112],
  ['JP-Tokyo-02', 'Trojan', 134],
  ['SG-AWS', 'VLESS', 183],
  ['US-Streaming-01', 'Hysteria2', 247],
  ['US-LA-CN2', 'Trojan', 261],
  ['DE-Server', 'SS', 312],
  ['US-Netflix', 'VLESS', undefined],
  ['TW-Hinet', 'Trojan', 58],
  ['KR-Seoul', 'Hysteria2', 97],
  ['US-OpenAI', 'Trojan', 188],
  ['US-GPT-4', 'VLESS', 201],
  ['US-Claude', 'Hysteria2', 195],
  ['JP-GPT', 'Trojan', 156],
  ['SG-OpenAI', 'SS', 172],
  ['UK-AI', 'VLESS', 233],
  ['DE-AI', 'Trojan', 287],
  ['US-West-AI', 'Hysteria2', undefined],
]

const STREAMING_ALL = [
  'HK-PCCW', 'HK-ViuTV', 'HK-03', 'JP-AbemaTV', 'JP-Tokyo-02', 'SG-AWS',
  'US-Streaming-01', 'US-LA-CN2', 'DE-Server', 'US-Netflix', 'TW-Hinet', 'KR-Seoul',
]
const AI_ALL = [
  'US-OpenAI', 'US-GPT-4', 'US-Claude', 'JP-GPT', 'SG-OpenAI', 'UK-AI', 'DE-AI', 'US-West-AI',
]
const FALLBACK_ALL = ['HK-PCCW', 'HK-ViuTV', 'JP-Tokyo-02', 'SG-AWS', 'US-LA-CN2', 'DE-Server']

function buildProxies(): Record<string, ProxyEntry> {
  const map: Record<string, ProxyEntry> = {
    DIRECT: node('DIRECT', 'Direct'),
    REJECT: node('REJECT', 'Reject'),
  }
  for (const [name, type, delay] of NODE_DEFS) map[name] = node(name, type, delay)
  map['Streaming'] = group('Streaming', 'Selector', 'HK-PCCW', STREAMING_ALL)
  map['AI'] = group('AI', 'URLTest', 'US-OpenAI', AI_ALL)
  map['Fallback'] = group('Fallback', 'Fallback', 'HK-PCCW', FALLBACK_ALL)
  map['GLOBAL'] = group('GLOBAL', 'Selector', 'Streaming', [
    'Streaming', 'AI', 'Fallback', ...STREAMING_ALL.filter((n) => !AI_ALL.includes(n)), ...AI_ALL,
  ])
  return map
}

const proxyState = buildProxies()

/** /proxies 快照造数器 */
export function mockProxies(): ProxiesPayload {
  // 返回深拷贝, 避免调用方误改内部状态
  return JSON.parse(JSON.stringify({ proxies: proxyState })) as ProxiesPayload
}

/** PUT /proxies/{group} 的 mock 实现 */
export function mockSelectProxy(groupName: string, name: string): void {
  const g = proxyState[groupName]
  if (g && Array.isArray(g.all) && g.all.includes(name)) g.now = name
}

/** GET /proxies/{name}/delay 的 mock 实现(顺带刷新内存状态) */
export function mockTestDelay(name: string): number {
  const p = proxyState[name]
  const base = p?.delay ?? rand(40, 320)
  const delay = Math.max(8, jitter(base, 0.25))
  if (p) {
    p.delay = delay
    p.history = [...p.history.slice(-9), { time: new Date().toISOString(), delay }]
  }
  return delay
}

/* ============================== 规则(契约 C /rules) ============================== */

/** 规则列表 — 与 design/pages/08-rules.html 一致 */
export function mockRules(): RuleItem[] {
  return [
    { type: 'DOMAIN-SUFFIX', payload: 'openai.com', proxy: 'AI' },
    { type: 'DOMAIN-SUFFIX', payload: 'anthropic.com', proxy: 'AI' },
    { type: 'DOMAIN-KEYWORD', payload: 'youtube', proxy: 'Streaming' },
    { type: 'DOMAIN-SUFFIX', payload: 'googlevideo.com', proxy: 'Streaming' },
    { type: 'DOMAIN', payload: 'mtalk.google.com', proxy: 'DIRECT' },
    { type: 'DOMAIN-SUFFIX', payload: 'netflix.com', proxy: 'Streaming' },
    { type: 'PROCESS-NAME', payload: 'Telegram.exe', proxy: 'Social' },
    { type: 'PROCESS-NAME', payload: 'steam.exe', proxy: 'Gaming' },
    { type: 'RULE-SET', payload: 'reject', proxy: 'REJECT' },
    { type: 'RULE-SET', payload: 'China', proxy: 'DIRECT' },
    { type: 'IP-CIDR', payload: '198.18.0.0/16', proxy: 'DIRECT' },
    { type: 'IP-CIDR', payload: '10.0.0.0/8', proxy: 'DIRECT' },
    { type: 'GEOIP', payload: 'CN', proxy: 'DIRECT' },
    { type: 'MATCH', payload: '', proxy: 'Fallback' },
  ]
}

/* ============================== 连接(契约 C /connections) ============================== */

interface ConnSeed {
  host: string; ip: string; port: string; network: 'tcp' | 'udp'
  process: string; rule: string; rulePayload: string
  /** mihomo 原始顺序: 出口节点在前、入口组在后; UI 展示需 reverse 后用 → 连接 */
  chains: string[]
  up: number; down: number; curUp: number; curDown: number
  /** 连接时长(秒), 用于回推 start */
  ageSec: number
}

/** 12 条连接快照 — 与 design/pages/03-connections.html 一致 */
const CONN_SEEDS: ConnSeed[] = [
  { host: 'www.youtube.com', ip: '142.250.196.110', port: '443', network: 'tcp',
    process: 'chrome.exe', rule: 'RuleSet', rulePayload: 'Streaming',
    chains: ['HK-PCCW', 'US-Streaming'], up: 1.2 * MB, down: 86.4 * MB,
    curUp: 1.1 * KB, curDown: 12.6 * KB, ageSec: 12 * 60 + 8 },
  { host: 'api.openai.com', ip: '104.18.33.45', port: '443', network: 'tcp',
    process: 'Code.exe', rule: 'RuleSet', rulePayload: 'AI',
    chains: ['US-OpenAI', 'AI-Service'], up: 18.6 * KB, down: 384 * KB,
    curUp: 0.2 * KB, curDown: 0.9 * KB, ageSec: 5 * 60 + 32 },
  { host: 'mtalk.google.com', ip: '108.177.125.188', port: '5228', network: 'tcp',
    process: 'chrome.exe', rule: 'RuleSet', rulePayload: 'Google',
    chains: ['HK-PCCW', 'Proxy'], up: 4.2 * KB, down: 12.8 * KB,
    curUp: 0.1 * KB, curDown: 0.4 * KB, ageSec: 47 * 60 + 21 },
  { host: 'web.telegram.org', ip: '149.154.167.99', port: '443', network: 'tcp',
    process: 'Telegram.exe', rule: 'RuleSet', rulePayload: 'Telegram',
    chains: ['SG-AWS', 'Proxy'], up: 96 * KB, down: 2.4 * MB,
    curUp: 0.3 * KB, curDown: 1.4 * KB, ageSec: 18 * 60 + 44 },
  { host: 'steamcdn-a.akamaihd.net', ip: '184.25.204.7', port: '443', network: 'tcp',
    process: 'steam.exe', rule: 'RuleSet', rulePayload: 'SteamCN',
    chains: ['DIRECT'], up: 320 * KB, down: 1.21 * GB,
    curUp: 0, curDown: 0, ageSec: 26 * 60 + 15 },
  { host: 'weather-data.apple.com', ip: '17.253.85.204', port: '443', network: 'tcp',
    process: 'Widgets.exe', rule: 'RuleSet', rulePayload: 'Apple',
    chains: ['DIRECT'], up: 2.1 * KB, down: 38 * KB,
    curUp: 0, curDown: 0, ageSec: 9 * 60 + 3 },
  { host: 'alive.github.com', ip: '140.82.113.26', port: '443', network: 'tcp',
    process: 'Code.exe', rule: 'RuleSet', rulePayload: 'GitHub',
    chains: ['DE-Server', 'Proxy'], up: 6.8 * KB, down: 12.4 * KB,
    curUp: 0, curDown: 0, ageSec: 2 * 60 + 41 },
  { host: 'cdn.jsdelivr.net', ip: '151.101.77.229', port: '443', network: 'tcp',
    process: 'chrome.exe', rule: 'RuleSet', rulePayload: 'CDN',
    chains: ['HK-PCCW', 'Auto-Select'], up: 9.4 * KB, down: 648 * KB,
    curUp: 0, curDown: 0, ageSec: 3 * 60 + 57 },
  { host: 'tracker.example.org', ip: '203.0.113.18', port: '443', network: 'tcp',
    process: 'msedge.exe', rule: 'RuleSet', rulePayload: 'AdBlock',
    chains: ['REJECT'], up: 0, down: 0, curUp: 0, curDown: 0, ageSec: 12 },
  { host: 'guanggao.cn', ip: '47.95.12.34', port: '80', network: 'tcp',
    process: 'msedge.exe', rule: 'RuleSet', rulePayload: 'AdBlock',
    chains: ['REJECT'], up: 0, down: 0, curUp: 0, curDown: 0, ageSec: 5 },
  { host: 'www.bilibili.com', ip: '119.3.70.188', port: '443', network: 'tcp',
    process: 'chrome.exe', rule: 'GeoIP', rulePayload: 'CN',
    chains: ['DIRECT'], up: 42 * KB, down: 5.6 * MB,
    curUp: 0, curDown: 0, ageSec: 15 * 60 + 26 },
  { host: 'dns.alidns.com', ip: '223.5.5.5', port: '53', network: 'udp',
    process: 'System', rule: 'RuleSet', rulePayload: 'ChinaDNS',
    chains: ['DIRECT'], up: 1.4 * KB, down: 3.2 * KB,
    curUp: 0, curDown: 0, ageSec: 60 + 48 },
]

interface ConnState { seed: ConnSeed; id: string; start: number; up: number; down: number; closed: boolean }

const connBootAt = Date.now()

let connStates: ConnState[] = CONN_SEEDS.map((seed, i) => ({
  seed,
  id: `mock-conn-${i + 1}`,
  start: connBootAt - seed.ageSec * 1000,
  up: Math.round(seed.up),
  down: Math.round(seed.down),
  closed: false,
}))

let connTotals = {
  upload: connStates.reduce((s, c) => s + c.up, 0),
  download: connStates.reduce((s, c) => s + c.down, 0),
}

/** 12 条连接快照微扰造数器(每次调用累计活跃连接的速率) */
export function mockConnections(): ConnectionsPayload {
  const items: ConnItem[] = []
  for (const c of connStates) {
    if (c.closed) continue
    const curUp = jitter(c.seed.curUp, 0.4)
    const curDown = jitter(c.seed.curDown, 0.4)
    c.up += curUp
    c.down += curDown
    connTotals.upload += curUp
    connTotals.download += curDown
    items.push({
      id: c.id,
      metadata: {
        host: c.seed.host,
        destinationIP: c.seed.ip,
        destinationPort: c.seed.port,
        sourceIP: '127.0.0.1',
        sourcePort: String(52300 + items.length),
        network: c.seed.network,
        process: c.seed.process,
        processPath: c.seed.process === 'System' ? undefined : `C:\\Program Files\\${c.seed.process}`,
      },
      rule: c.seed.rule,
      rulePayload: c.seed.rulePayload,
      chains: [...c.seed.chains],
      upload: c.up,
      download: c.down,
      start: new Date(c.start).toISOString(),
      curUp,
      curDown,
    })
  }
  return { downloadTotal: connTotals.download, uploadTotal: connTotals.upload, connections: items }
}

/** DELETE /connections/{id} */
export function mockCloseConnection(id: string): void {
  const c = connStates.find((it) => it.id === id)
  if (c) c.closed = true
}

/** DELETE /connections */
export function mockCloseAllConnections(): void {
  for (const c of connStates) c.closed = true
}

/* ============================== 日志造数器 ============================== */

/** 仿真日志行 — 风格与 design/pages/04-logs.html 一致 */
const LOG_TEMPLATES: { type: LogItem['type']; payload: string }[] = [
  { type: 'info', payload: '[TCP] connection 127.0.0.1:52311 --> mtalk.google.com:5228 match RuleSet(Google) using US-OpenAI' },
  { type: 'info', payload: '[TCP] connection 127.0.0.1:52316 --> youtube.com:443 match RuleSet(Streaming) using HK-PCCW' },
  { type: 'debug', payload: 'dns resolve cache hit api.github.com --> 140.82.121.4 (ttl 287s)' },
  { type: 'info', payload: '[UDP] dns.alidns.com:443 match GeoIP(CN) using DIRECT' },
  { type: 'warning', payload: 'provider BigAirport health-check timeout: HK-03 (3082ms)' },
  { type: 'info', payload: '[TCP] connection 127.0.0.1:52320 --> api.telegram.org:443 match RuleSet(Telegram) using SG-AWS' },
  { type: 'debug', payload: 'match process Telegram.exe pid=18244 rule ProcessName(Telegram) hit' },
  { type: 'error', payload: 'dial tcp 203.0.113.7:443: connect refused (proxy DE-Server)' },
  { type: 'info', payload: 'restart selector group Streaming --> fallback JP-AbemaTV' },
  { type: 'info', payload: '[TCP] connection 127.0.0.1:52331 --> steamcdn-a.akamaihd.net:443 match RuleSet(SteamCDN) using DIRECT' },
  { type: 'debug', payload: 'sniff tls sni clients4.google.com from chrome.exe (pid 6120)' },
  { type: 'warning', payload: 'udp session 8.8.8.8:53 idle 120s, closing inbound 127.0.0.1:60214' },
  { type: 'info', payload: '[TCP] connection 127.0.0.1:52340 --> chat.openai.com:443 match RuleSet(OpenAI) using US-OpenAI' },
  { type: 'info', payload: 'provider BigAirport updated: 86 nodes, 2 unavailable, traffic 412.6 GB / 1024 GB' },
  { type: 'debug', payload: 'dns resolve raw.githubusercontent.com --> 185.199.108.133 via dns.google:853 (DoT) 42ms' },
  { type: 'error', payload: 'rule-set Telegram download failed: context deadline exceeded, retry in 60s' },
]

let logCursor = 0

/** 顺序循环吐出一条仿真日志 */
export function mockNextLog(): LogItem {
  const tpl = LOG_TEMPLATES[logCursor % LOG_TEMPLATES.length]!
  logCursor += 1
  return { ...tpl, time: new Date().toISOString() }
}

/* ============================== 流量造数器 ============================== */

const TRAFFIC_UP_MAX = 2 * MB
const TRAFFIC_DOWN_MAX = 10 * MB

let trafficUp = 0.3 * MB
let trafficDown = 2.4 * MB

/** randomwalk: up 0~2MB/s, down 0~10MB/s */
export function mockNextTraffic(): { up: number; down: number } {
  trafficUp = Math.min(TRAFFIC_UP_MAX, Math.max(0, trafficUp + rand(-0.35, 0.35) * MB))
  trafficDown = Math.min(TRAFFIC_DOWN_MAX, Math.max(0, trafficDown + rand(-1.6, 1.6) * MB))
  return { up: Math.round(trafficUp), down: Math.round(trafficDown) }
}

let memInuse = 86 * MB

/** randomwalk: 内核内存 60~140MB */
export function mockNextMemory(): { inuse: number; oslimit: number } {
  memInuse = Math.min(140 * MB, Math.max(60 * MB, memInuse + rand(-4, 4) * MB))
  return { inuse: Math.round(memInuse), oslimit: 0 }
}

/* ============================== 契约 B 命令 handler 表 ============================== */

export type MockHandler = (args: Record<string, unknown>) => unknown

function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new Error(`参数 ${key} 缺失或类型错误`)
  return v
}

/** 契约 B 全部命令的内存实现(ipc.ts mock 路径查表调用) */
export const mockHandlers: Record<string, MockHandler> = {
  get_settings: () => ({ ...settings }),
  save_settings: (args) => {
    settings = { ...(args['settings'] as AppSettings) }
    return undefined
  },
  core_status: () => coreStatus(),
  start_core: () => {
    core.running = true
    return undefined
  },
  stop_core: () => {
    core.running = false
    return undefined
  },
  restart_core: () => {
    core.running = true
    return undefined
  },
  list_profiles: () => profiles.map((p) => ({ ...p.meta })),
  import_profile: (args) => {
    const url = argString(args, 'url')
    profileSeq += 1
    const meta: ProfileMeta = {
      id: `p-${profileSeq}`,
      name: new URL(url, 'https://example.com').hostname || `订阅 ${profileSeq}`,
      kind: 'remote',
      url,
      updatedAt: Date.now(),
      autoUpdateMin: 1440,
      sizeBytes: Math.round(rand(20, 200)) * KB,
      quota: { used: 0, total: 100 * GB, expireAt: Date.now() + 30 * DAY },
      current: false,
    }
    profiles.push({ meta, content: BIGAIRPORT_YAML })
    return { ...meta }
  },
  update_profile: (args) => {
    const p = findProfile(argString(args, 'id'))
    p.meta.updatedAt = Date.now()
    if (p.meta.quota) p.meta.quota.used = Math.min(p.meta.quota.total, p.meta.quota.used + rand(0.1, 1.2) * GB)
    return { ...p.meta }
  },
  select_profile: (args) => {
    const id = argString(args, 'id')
    findProfile(id)
    for (const p of profiles) p.meta.current = p.meta.id === id
    return undefined
  },
  delete_profile: (args) => {
    const id = argString(args, 'id')
    findProfile(id)
    profiles = profiles.filter((p) => p.meta.id !== id)
    return undefined
  },
  read_profile: (args) => findProfile(argString(args, 'id')).content,
  save_profile_content: (args) => {
    const p = findProfile(argString(args, 'id'))
    p.content = argString(args, 'content')
    p.meta.sizeBytes = new Blob([p.content]).size
    p.meta.updatedAt = Date.now()
    return undefined
  },
  set_system_proxy: (args) => {
    settings = { ...settings, sysProxy: Boolean(args['enable']) }
    return undefined
  },
  set_tun: (args) => {
    if (Boolean(args['enable']) && !serviceInstalled) {
      throw new Error('TUN 模式需要先安装服务模式')
    }
    if (Boolean(args['enable'])) {
      serviceRunning = true
      core.running = true
    }
    settings = { ...settings, tun: Boolean(args['enable']) }
    return undefined
  },
  set_mode: (args) => {
    const mode = argString(args, 'mode')
    if (mode === 'rule' || mode === 'global' || mode === 'direct') {
      settings = { ...settings, mode }
    }
    return undefined
  },
  open_app_dir: () => undefined,
  open_url: (args) => {
    window.open(argString(args, 'url'), '_blank')
    return undefined
  },
  service_status: () => (serviceRunning ? 'running' : serviceInstalled ? 'installed' : 'not-installed'),
  install_service: () => {
    serviceInstalled = true
    serviceRunning = true
    core.running = true
    return undefined
  },
  uninstall_service: () => {
    serviceInstalled = false
    serviceRunning = false
    settings = { ...settings, tun: false }
    core.running = true
    return undefined
  },
  exempt_uwp_loopback: () => undefined,
  check_update: () => null,
  reset_settings: () => {
    settings = { ...DEFAULT_SETTINGS }
    return { ...settings }
  },
  query_traffic_series: (args) => mockSeries(String(args['range'] ?? '7d')),
  query_traffic_rank: (args) =>
    mockRank(String(args['dim'] ?? 'proxy'), String(args['range'] ?? '7d')),
  get_runtime_config: () => `# ClashNova 运行时配置 (mock)
port: 7890
socks-port: 7891
mixed-port: 7892
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:9097
secret: ''

dns:
  enable: true
  listen: 127.0.0.1:5335
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - https://doh.pub/dns-query
    - https://dns.alidns.com/dns-query

proxies: []
proxy-groups: []
rules: []
`,
  read_enhancer: (args) => {
    const key = `${argString(args, 'profileId')}/${argString(args, 'enhancerId')}`
    return enhancerContents[key] ?? ''
  },
  save_enhancer: (args) => {
    const pid = argString(args, 'profileId')
    const p = findProfile(pid)
    const kind = argString(args, 'kind') as EnhancerMeta['kind']
    const name = argString(args, 'name')
    const eid = typeof args['enhancerId'] === 'string' ? (args['enhancerId'] as string) : null
    p.meta.enhancers ??= []
    let meta: EnhancerMeta
    if (eid) {
      const found = p.meta.enhancers.find((e) => e.id === eid)
      if (!found) throw new Error(`增强项不存在: ${eid}`)
      found.name = name
      meta = found
    } else {
      meta = { id: `e-${Date.now().toString(36)}`, kind, name, enabled: true }
      p.meta.enhancers.push(meta)
    }
    enhancerContents[`${pid}/${meta.id}`] = argString(args, 'content')
    return { ...meta }
  },
  delete_enhancer: (args) => {
    const pid = argString(args, 'profileId')
    const eid = argString(args, 'enhancerId')
    const p = findProfile(pid)
    p.meta.enhancers = (p.meta.enhancers ?? []).filter((e) => e.id !== eid)
    delete enhancerContents[`${pid}/${eid}`]
    return undefined
  },
  toggle_enhancer: (args) => {
    const p = findProfile(argString(args, 'profileId'))
    const e = (p.meta.enhancers ?? []).find((it) => it.id === args['enhancerId'])
    if (e) e.enabled = Boolean(args['enabled'])
    return undefined
  },
}

/** 增强项内容存储(键 `${profileId}/${enhancerId}`) */
const enhancerContents: Record<string, string> = {
  'p-bigairport/e-dns': `# 覆写 DNS 与端口\nmixed-port: 7897\ndns:\n  enable: true\n  enhanced-mode: fake-ip\n  nameserver:\n    - https://dns.alidns.com/dns-query\n    - https://doh.pub/dns-query\nprepend-rules:\n  - DOMAIN-SUFFIX,internal.corp,DIRECT\n`,
  'p-bigairport/e-rename': `// 节点改名 + 地区分组\nfunction main(config) {\n  const flags = { HK: '🇭🇰', TW: '🇹🇼', JP: '🇯🇵', SG: '🇸🇬', US: '🇺🇸' };\n  for (const p of config.proxies ?? []) {\n    const m = p.name.match(/^(HK|TW|JP|SG|US)/);\n    if (m && flags[m[1]]) p.name = flags[m[1]] + ' ' + p.name;\n  }\n  return config;\n}\n`,
  'p-bigairport/e-prune': `// 去除名称带「过期/剩余」的无效节点\nfunction main(config) {\n  const bad = /过期|剩余|官网|流量/;\n  config.proxies = (config.proxies ?? []).filter((p) => !bad.test(p.name));\n  return config;\n}\n`,
}

/** 当前 mock 设置(api.ts 取 secret/controller 用) */
export function mockSettings(): AppSettings {
  return { ...settings }
}

/* ============================== 提供者造数器(M2) ============================== */

const proxyProviders: ProxyProviderItem[] = [
  {
    name: 'BigAirport',
    vehicleType: 'HTTP',
    nodeCount: 128,
    updatedAt: Date.now() - 2 * HOUR,
    subscription: { used: 162.4 * GB, total: 500 * GB, expireAt: Date.now() + 37 * DAY },
  },
  {
    name: 'SecondaryPool',
    vehicleType: 'HTTP',
    nodeCount: 36,
    updatedAt: Date.now() - 26 * HOUR,
    subscription: { used: 8.1 * GB, total: 100 * GB, expireAt: Date.now() + 83 * DAY },
  },
]

const ruleProviders: RuleProviderItem[] = [
  { name: 'reject', behavior: 'domain', vehicleType: 'HTTP', ruleCount: 32118, updatedAt: Date.now() - 2 * HOUR },
  { name: 'icloud', behavior: 'domain', vehicleType: 'HTTP', ruleCount: 398, updatedAt: Date.now() - 2 * HOUR },
  { name: 'apple', behavior: 'domain', vehicleType: 'HTTP', ruleCount: 168, updatedAt: Date.now() - 5 * HOUR },
  { name: 'google', behavior: 'domain', vehicleType: 'HTTP', ruleCount: 570, updatedAt: Date.now() - 2 * HOUR },
  { name: 'proxy', behavior: 'domain', vehicleType: 'HTTP', ruleCount: 41217, updatedAt: Date.now() - 1 * HOUR },
  { name: 'direct', behavior: 'classical', vehicleType: 'HTTP', ruleCount: 8439, updatedAt: Date.now() - 3 * HOUR },
  { name: 'cncidr', behavior: 'ipcidr', vehicleType: 'HTTP', ruleCount: 7432, updatedAt: Date.now() - 26 * HOUR },
  { name: 'lancidr', behavior: 'ipcidr', vehicleType: 'HTTP', ruleCount: 19, updatedAt: Date.now() - 3 * DAY },
]

export function mockProxyProviders(): ProxyProviderItem[] {
  return proxyProviders.map((p) => ({ ...p }))
}

export function mockRuleProviders(): RuleProviderItem[] {
  return ruleProviders.map((p) => ({ ...p }))
}

/** PUT /providers/proxies/{name} — 刷新更新时间并轻微抖动节点数 */
export function mockUpdateProxyProvider(name: string): void {
  const p = proxyProviders.find((it) => it.name === name)
  if (!p) throw new Error(`提供者不存在: ${name}`)
  p.updatedAt = Date.now()
  p.nodeCount = Math.max(1, p.nodeCount + Math.round(rand(-2, 2)))
}

/** PUT /providers/rules/{name} */
export function mockUpdateRuleProvider(name: string): void {
  const p = ruleProviders.find((it) => it.name === name)
  if (!p) throw new Error(`提供者不存在: ${name}`)
  p.updatedAt = Date.now()
}

/* ============================== 流量统计造数器(M3) ============================== */

/** 稳定伪随机(同 ts 同结果, 截图可复现) */
function seeded(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

function mockSeries(range: string): { ts: number; up: number; down: number }[] {
  const step = range === 'day' ? 3600_000 : 86_400_000
  const count = range === 'day' ? 24 : range === '30d' ? 30 : 7
  const now = Math.floor(Date.now() / step) * step
  const out = []
  for (let i = count - 1; i >= 0; i -= 1) {
    const ts = now - i * step
    const base = range === 'day' ? 60 * MB : 900 * MB
    const wave = 0.35 + seeded(ts / step) * 0.9
    out.push({
      ts,
      up: Math.round(base * wave * 0.18),
      down: Math.round(base * wave),
    })
  }
  return out
}

const RANK_KEYS: Record<string, string[]> = {
  proxy: ['DE-Server', 'US-OpenAI', 'US-Streaming', 'SG-AWS', 'DIRECT', 'JP-GPT', 'US-Netflix'],
  process: ['chrome.exe', 'Telegram.exe', 'steam.exe', 'spotify.exe', 'code.exe', 'svchost.exe'],
  host: ['youtube.com', 'chat.openai.com', 'github.com', 'steamcdn-a.akamaihd.net', 'api.telegram.org', 'doh.pub'],
}

function mockRank(dim: string, range: string): { key: string; up: number; down: number }[] {
  const keys = RANK_KEYS[dim] ?? RANK_KEYS['proxy']!
  const scale = range === 'day' ? 0.08 : range === '30d' ? 26 : 7
  return keys
    .map((key, i) => {
      const down = Math.round((18 - i * 2.3) * scale * GB * (0.6 + seeded(i + key.length) * 0.5))
      return { key, up: Math.round(down * 0.14), down }
    })
    .sort((a, b) => b.up + b.down - (a.up + a.down))
}
