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
  DnsQueryResult,
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
import { DEFAULT_TUN_OPTIONS } from '../types/tun'
import { DEFAULT_PROFILE_DOWNLOAD_OPTIONS, type ProfileDownloadOptions, type ProfileTopology } from '../types/profileFeatures'
import type { UpdateState } from '../types/updates'
import type { BackupEntry, WebDavConfig } from '../types/backup'

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
  tunOptions: { ...DEFAULT_TUN_OPTIONS },
  autostart: true,
  silentStart: false,
  lightweightOnClose: false,
  mixedPort: 7897,
  externalController: '127.0.0.1:9097',
  secret: 'MOCK_CONTROLLER_SECRET',
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
  statsRetentionDays: 0,
  /* DNS 高级配置默认值 */
  enableDns: true,
  dnsListen: '127.0.0.1:5335',
  dnsEnhancedMode: 'fake-ip',
  fakeIpRange: '198.18.0.1/16',
  fakeIpFilterMode: 'blacklist',
  ipv6Dns: false,
  preferH3: false,
  respectRules: null,
  useHosts: null,
  useSystemHosts: null,
  delayTestUrl: 'https://www.gstatic.com/generate_204',
  delayTestTimeout: 5000,
  autoCloseConnections: true,
  unifiedDelay: false,
  findProcessMode: '',
  sniffer: false,
  settingsVersion: 1,
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

const BUILTIN_PRUNE_ENHANCER_ID = 'builtin-prune-invalid-nodes'
const BUILTIN_PRUNE_SCRIPT = String.raw`// 去除名称里明显不是节点的项目，并同步清理策略组和订阅提供者引用。
function main(config) {
  const invalidNodeFilterBody = '过期|到期|失效|剩余|流量|官网|套餐|订阅(?:[：:]|地址|链接|更新)|网址|重置|用量|群组|频道|traffic|expire|subscription(?:[：:]|[ ]+(?:info|url|link|expire))|remaining|reset|used|total';
  const invalidNodeFilter = '(?i)(' + invalidNodeFilterBody + ')';
  const badName = new RegExp(invalidNodeFilterBody, 'i');
  const removed = {};
  const applyExcludeFilter = function(target) {
    if (!target || typeof target !== 'object') return;
    const current = String(target['exclude-filter'] || '').trim();
    if (!current) {
      target['exclude-filter'] = invalidNodeFilter;
    } else if (!/剩余|流量|remaining|traffic|expire/i.test(current)) {
      target['exclude-filter'] = '(?i)(?:' + current.replace(/^\(\?i\)/, '') + '|' + invalidNodeFilterBody + ')';
    }
  };

  config.proxies = (config.proxies || []).filter(function(proxy) {
    const name = String((proxy && proxy.name) || '');
    const drop = badName.test(name);
    if (drop) removed[name] = true;
    return !drop;
  });

  for (const provider of Object.values(config['proxy-providers'] || {})) {
    applyExcludeFilter(provider);
  }

  for (const group of config['proxy-groups'] || []) {
    if (group && group.use) applyExcludeFilter(group);
    if (Array.isArray(group.proxies)) {
      group.proxies = group.proxies.filter(function(name) {
        const text = String(name || '');
        return !removed[text] && !badName.test(text);
      });
    }
  }
  return config;
}
`

function builtinPruneEnhancer(): EnhancerMeta {
  return {
    id: BUILTIN_PRUNE_ENHANCER_ID,
    kind: 'script',
    name: '内置：去除无效节点',
    enabled: false,
  }
}

interface MockProfile { meta: ProfileMeta; content: string; topology?: Omit<ProfileTopology, 'content'> }

let profileSeq = 4

let profiles: MockProfile[] = [
  {
    meta: {
      id: 'p-bigairport',
      name: 'BigAirport',
      kind: 'remote',
      url: 'https://subscription.example.invalid/main.yaml',
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
        builtinPruneEnhancer(),
      ],
    },
    content: BIGAIRPORT_YAML,
  },
  {
    meta: {
      id: 'p-lantern',
      name: 'Lantern Plus',
      kind: 'remote',
      url: 'https://subscription.example.invalid/backup.yaml',
      updatedAt: Date.now() - 9 * HOUR,
      autoUpdateMin: 720,
      sizeBytes: Math.round(96 * KB),
      quota: {
        used: 88.7 * GB,
        total: 200 * GB,
        expireAt: Date.now() + 21 * DAY,
      },
      current: false,
      enhancers: [builtinPruneEnhancer()],
    },
    content: BIGAIRPORT_YAML,
  },
  {
    meta: {
      id: 'p-lab-rules',
      name: 'Lab Ruleset',
      kind: 'remote',
      url: 'https://profiles.example.net/sub/clashnova-lab.yaml',
      updatedAt: Date.now() - 30 * MIN,
      autoUpdateMin: 360,
      sizeBytes: Math.round(71 * KB),
      quota: {
        used: 12.1 * GB,
        total: 120 * GB,
        expireAt: Date.now() + 83 * DAY,
      },
      current: false,
      enhancers: [builtinPruneEnhancer()],
    },
    content: BIGAIRPORT_YAML,
  },
  {
    meta: {
      id: 'p-full-en',
      name: 'full.en',
      kind: 'local',
      url: 'C:\\Users\\USER\\.config\\clash\\full.en.yaml',
      updatedAt: new Date('2026-05-28T10:00:00+08:00').getTime(),
      sizeBytes: Math.round(12.6 * KB),
      current: false,
      enhancers: [builtinPruneEnhancer()],
    },
    content: FULL_EN_YAML,
  },
]

function findProfile(id: string): MockProfile {
  const p = profiles.find((it) => it.meta.id === id)
  if (!p) throw new Error(`订阅不存在: ${id}`)
  return p
}

let globalEnhancers: EnhancerMeta[] = []
function enhancersFor(id: string): EnhancerMeta[] {
  return id === '__global__' ? globalEnhancers : (findProfile(id).meta.enhancers ??= [])
}

const updateState: UpdateState = {
  supported: true, currentBuildId: 'dev', appChecked: false, appDownloaded: false,
  app: null, core: null, installedCores: [{ id: 'bundled', version: 'v1.19.27', bundled: true, active: true }],
  phase: 'idle', kind: null, downloaded: 0, total: 0, error: null,
}

interface MockBackup { entry: BackupEntry; settings: AppSettings; profiles: MockProfile[]; global: EnhancerMeta[]; enhancers: Record<string, string> }
let backupSeq = 0
const backups: MockBackup[] = []
const remoteBackups: MockBackup[] = []
let webdav: WebDavConfig = { url: '', username: '', passwordSaved: false }
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const preservedBackupSettings = ['sysProxy', 'guard', 'guardIntervalSec', 'bypass', 'tun', 'tunOptions', 'autostart', 'silentStart', 'hotkeys', 'mixedPort', 'externalController', 'secret', 'allowLan'] as const

function createBackup(label: string): MockBackup {
  const snapshot: MockBackup = copy({
    entry: { id: `mock-backup-${++backupSeq}`, label: label.trim() || '手动备份', createdAt: Date.now(), appVersion: '2.4.8', sizeBytes: 0, source: 'local' },
    settings, profiles, global: globalEnhancers, enhancers: enhancerContents,
  })
  snapshot.entry.sizeBytes = new Blob([JSON.stringify(snapshot)]).size
  backups.unshift(snapshot)
  return snapshot
}

function findBackup(args: Record<string, unknown>, entries = backups): MockBackup {
  const found = entries.find((item) => item.entry.id === argString(args, 'id'))
  if (!found) throw new Error('备份不存在')
  return found
}

function removeBackup(args: Record<string, unknown>, entries = backups): void {
  const found = findBackup(args, entries)
  entries.splice(entries.indexOf(found), 1)
}

function mockImportSource(value: string): { url: string; name?: string } {
  const parsed = new URL(value)
  if (['http:', 'https:'].includes(parsed.protocol)) return { url: parsed.href }
  if (!['clash:', 'clash-verge:', 'clashnova:'].includes(parsed.protocol) || parsed.hostname !== 'install-config') throw new Error('不支持的订阅协议')
  if (parsed.searchParams.getAll('url').length !== 1) throw new Error('协议链接缺少唯一的 url 参数')
  const url = new URL(parsed.searchParams.get('url')!)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('订阅下载地址仅支持 HTTP(S)')
  return { url: url.href, name: parsed.searchParams.get('name') || undefined }
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

/** GET /group/{name}/delay 的 mock 实现: 返回成员延迟; URLTest 组顺带切到最快成员 */
export function mockTestGroupDelay(groupName: string, timeout: number): Record<string, number> {
  const g = proxyState[groupName]
  const result: Record<string, number> = {}
  for (const name of g?.all ?? []) {
    const delay = mockTestDelay(name)
    if (delay <= timeout) result[name] = delay
  }
  if (g?.type === 'URLTest') {
    const fastest = Object.entries(result).sort((a, b) => a[1] - b[1])[0]
    if (fastest) g.now = fastest[0]
  }
  return result
}

/** GET /dns/query 的 mock 实现 */
export function mockQueryDns(name: string, type: string): DnsQueryResult {
  const host = name.replace(/\.$/, '')
  if (type === 'AAAA') {
    return { status: 0, answers: [{ name: `${host}.`, type: 28, TTL: 300, data: '2001:db8::1' }] }
  }
  if (type !== 'A') return { status: 0, answers: [] }
  return {
    status: 0,
    answers: [
      { name: `${host}.`, type: 5, TTL: 120, data: `edge.${host}.` },
      { name: `edge.${host}.`, type: 1, TTL: 60, data: `198.18.0.${Math.round(rand(2, 250))}` },
    ],
  }
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
        type: 'HTTP',
        inboundName: 'DEFAULT-MIXED',
        inboundIP: '127.0.0.1',
        inboundPort: '7897',
        dnsMode: 'fake-ip',
        remoteDestination: c.seed.chains[0] === 'DIRECT' || c.seed.chains[0] === 'REJECT' ? c.seed.ip : '',
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

/** 关闭链路经过指定组/节点的连接 */
export function mockCloseGroupConnections(group: string): void {
  for (const c of connStates) {
    if (c.seed.chains.includes(group)) c.closed = true
  }
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
  patch_settings: (args) => {
    settings = { ...settings, ...(args['patch'] as Partial<AppSettings>) }
    return { ...settings }
  },
  tray_panel_visible: () => true,
  hide_tray_panel: () => undefined,
  tray_open_main: () => undefined,
  tray_quit_app: () => undefined,
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
  list_global_enhancers: () => copy(globalEnhancers),
  pending_profile_imports: () => [],
  dismiss_profile_import: () => undefined,
  confirm_profile_import: () => { throw new Error('订阅请求已处理') },
  import_profile: (args) => {
    const { url, name } = mockImportSource(argString(args, 'url'))
    profileSeq += 1
    const meta: ProfileMeta = {
      id: `p-${profileSeq}`,
      name: name || new URL(url).hostname || `订阅 ${profileSeq}`,
      kind: 'remote',
      url,
      updatedAt: Date.now(),
      autoUpdateMin: 1440,
      sizeBytes: Math.round(rand(20, 200)) * KB,
      quota: { used: 0, total: 100 * GB, expireAt: Date.now() + 30 * DAY },
      current: false,
      enhancers: [builtinPruneEnhancer()],
      downloadOptions: { ...DEFAULT_PROFILE_DOWNLOAD_OPTIONS, ...(args.options as ProfileDownloadOptions | undefined) },
    }
    enhancerContents[`${meta.id}/${BUILTIN_PRUNE_ENHANCER_ID}`] = BUILTIN_PRUNE_SCRIPT
    profiles.push({ meta, content: BIGAIRPORT_YAML })
    return { ...meta }
  },
  import_profile_file: (args) => {
    const name = argString(args, 'name')
    const content = argString(args, 'content')
    profileSeq += 1
    const profileName = name.replace(/\.(ya?ml|txt|conf|config)$/i, '') || `本地配置 ${profileSeq}`
    const meta: ProfileMeta = {
      id: `p-${profileSeq}`,
      name: profileName,
      kind: 'local',
      url: name,
      updatedAt: Date.now(),
      sizeBytes: new Blob([content]).size,
      current: profiles.length === 0,
      enhancers: [builtinPruneEnhancer()],
    }
    enhancerContents[`${meta.id}/${BUILTIN_PRUNE_ENHANCER_ID}`] = BUILTIN_PRUNE_SCRIPT
    profiles.push({ meta, content })
    return { ...meta }
  },
  update_profile: (args) => {
    const p = findProfile(argString(args, 'id'))
    p.meta.updatedAt = Date.now()
    if (p.meta.quota) p.meta.quota.used = Math.min(p.meta.quota.total, p.meta.quota.used + rand(0.1, 1.2) * GB)
    return { ...p.meta }
  },
  update_profile_meta: (args) => {
    const p = findProfile(argString(args, 'id'))
    const name = argString(args, 'name').trim()
    if (!name) throw new Error('订阅名称不能为空')
    const rawUrl = typeof args['url'] === 'string' ? args['url'].trim() : ''
    if (p.meta.kind === 'remote' && !rawUrl) throw new Error('远程订阅 URL 不能为空')
    const rawInterval = args['autoUpdateMin']
    const autoUpdateMin =
      typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval > 0
        ? Math.round(rawInterval)
        : undefined
    p.meta.name = name
    p.meta.url = rawUrl || undefined
    p.meta.autoUpdateMin = autoUpdateMin
    if (args.downloadOptions) p.meta.downloadOptions = copy(args.downloadOptions as ProfileDownloadOptions)
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
  list_profile_rule_targets: () => Object.keys(mockProxies().proxies),
  save_profile_content: (args) => {
    const p = findProfile(argString(args, 'id'))
    p.content = argString(args, 'content')
    p.meta.sizeBytes = new Blob([p.content]).size
    p.meta.updatedAt = Date.now()
    return undefined
  },
  read_profile_topology: (args) => {
    const p = findProfile(argString(args, 'id'))
    p.topology ??= p.meta.kind === 'local' ? { proxies: [], groups: [] } : {
      proxies: [{ name: 'HK-PCCW', type: 'trojan', server: 'hk1.example.invalid', port: 443, password: 'mock' }],
      groups: [{ name: 'Streaming', type: 'select', proxies: ['HK-PCCW'] }],
    }
    return copy({ content: p.content, ...p.topology })
  },
  save_profile_topology: (args) => {
    const p = findProfile(argString(args, 'id'))
    if (p.content !== args.originalContent) throw new Error('订阅已被其他操作修改，请重新打开编辑器')
    p.topology = copy({ proxies: args.proxies as Record<string, unknown>[], groups: args.groups as Record<string, unknown>[] })
    p.content = JSON.stringify({ proxies: p.topology.proxies, 'proxy-groups': p.topology.groups, rules: ['MATCH,DIRECT'] }, null, 2)
    p.meta.sizeBytes = new Blob([p.content]).size
    p.meta.updatedAt = Date.now()
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
  service_status: () => (serviceRunning ? 'ready' : serviceInstalled ? 'unavailable:服务未运行' : 'not-installed'),
  check_tun_adapter: () => ({
    enabled: settings.tun,
    adapterPresent: settings.tun && serviceRunning,
    adapterName: settings.tun && serviceRunning ? 'ClashNova TUN' : undefined,
    status: settings.tun && serviceRunning ? 'Up' : 'Down',
    detail: settings.tun && serviceRunning ? 'Mock TUN adapter' : 'Mock adapter is not active',
  }),
  install_service: () => {
    serviceInstalled = true
    serviceRunning = true
    core.running = true
    return undefined
  },
  start_service: () => {
    if (!serviceInstalled) throw new Error('服务未安装，请先安装服务模式')
    serviceRunning = true
    core.running = true
    return undefined
  },
  reinstall_service: () => {
    serviceInstalled = true
    serviceRunning = true
    core.running = true
    return undefined
  },
  repair_service: () => {
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
  check_update: () => { updateState.appChecked = true; return null },
  get_update_state: () => copy(updateState),
  check_app_update: () => { updateState.appChecked = true; return copy(updateState.app) },
  check_core_update: () => {
    updateState.core = { version: 'v1.19.27', size: 17445304, sha256: '0'.repeat(64) }
    return copy(updateState.core)
  },
  download_app_update: () => {
    if (!updateState.app) throw new Error('请先检查应用更新')
    updateState.appDownloaded = true
    updateState.phase = 'ready'
    updateState.kind = 'app'
  },
  download_core_update: () => {
    if (!updateState.core) throw new Error('请先检查内核更新')
    if (!updateState.installedCores.some((item) => item.id === 'mock-core')) {
      updateState.installedCores.push({ id: 'mock-core', version: updateState.core.version, bundled: false, active: false })
    }
    updateState.phase = 'idle'
  },
  cancel_update: () => { updateState.phase = 'cancelled'; updateState.appDownloaded = false },
  install_app_update: (args) => {
    if (args.confirm !== true || !updateState.appDownloaded) throw new Error('需要先下载并确认安装')
    // 浏览器模拟不退出进程或运行安装程序。
    updateState.phase = 'idle'
  },
  switch_core_version: (args) => {
    if (args.confirm !== true) throw new Error('需要确认切换内核')
    const selected = updateState.installedCores.find((item) => item.id === args.id)
    if (!selected) throw new Error('内核版本不存在')
    for (const item of updateState.installedCores) item.active = item === selected
    updateState.phase = 'idle'
  },
  backup_list: () => backups.map((item) => copy(item.entry)),
  backup_create: (args) => copy(createBackup(argString(args, 'label')).entry),
  backup_delete: (args) => removeBackup(args),
  backup_export: (args) => {
    const backup = findBackup(args)
    return { filename: `${backup.entry.id}${args.redacted ? '-redacted' : ''}.json`, content: JSON.stringify(args.redacted
      ? { format: 'clashnova-mock-backup', redacted: true, profileCount: backup.profiles.length }
      : { format: 'clashnova-mock-backup', redacted: false, ...backup }, null, 2) }
  },
  backup_import: (args) => {
    const value = JSON.parse(argString(args, 'content')) as MockBackup & { format: string; redacted: boolean }
    if (value.redacted || value.format !== 'clashnova-mock-backup' || !value.entry || !value.settings || !Array.isArray(value.profiles)) throw new Error('备份格式无效或为不可恢复的脱敏摘要')
    const imported = copy(value)
    imported.entry.id = `mock-backup-${++backupSeq}`
    imported.entry.source = 'local'
    backups.unshift(imported)
    return copy(imported.entry)
  },
  backup_preview: (args) => {
    const backup = findBackup(args)
    return { entry: copy(backup.entry), profileCount: backup.profiles.length,
      enhancerCount: backup.global.length + backup.profiles.reduce((total, item) => total + (item.meta.enhancers?.length ?? 0), 0),
      fileCount: backup.profiles.length + 2, preservedSettings: [...preservedBackupSettings], warnings: [] }
  },
  backup_restore: (args) => {
    const backup = copy(findBackup(args))
    createBackup('恢复前自动备份')
    const local = Object.fromEntries(preservedBackupSettings.map((key) => [key, settings[key]]))
    settings = { ...backup.settings, ...local }
    profiles = backup.profiles
    globalEnhancers = backup.global
    for (const key of Object.keys(enhancerContents)) delete enhancerContents[key]
    Object.assign(enhancerContents, backup.enhancers)
    window.dispatchEvent(new Event('clashnova-profiles-changed'))
    return copy(settings)
  },
  backup_webdav_get: () => copy(webdav),
  backup_webdav_save: (args) => {
    const config = args.config as WebDavConfig & { password?: string }
    if (!config.url) { webdav = { url: '', username: '', passwordSaved: false }; return }
    const url = new URL(config.url)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('WebDAV 需要 HTTPS')
    const sameAccount = Boolean(webdav.url) && new URL(webdav.url).origin === url.origin && webdav.username === config.username
    webdav = { url: url.href, username: config.username, passwordSaved: config.password === undefined ? sameAccount && webdav.passwordSaved : Boolean(config.password) }
  },
  backup_webdav_list: () => remoteBackups.map((item) => copy(item.entry)),
  backup_webdav_upload: (args) => {
    if (!webdav.url) throw new Error('请先配置 WebDAV')
    const backup = copy(findBackup(args))
    if (remoteBackups.some((item) => item.entry.id === backup.entry.id)) throw new Error('远端备份已存在')
    backup.entry.source = 'webdav'
    remoteBackups.unshift(backup)
  },
  backup_webdav_download: (args) => {
    const backup = copy(findBackup(args, remoteBackups))
    backup.entry.id = `mock-backup-${++backupSeq}`
    backup.entry.source = 'local'
    backups.unshift(backup)
    return copy(backup.entry)
  },
  backup_webdav_delete: (args) => removeBackup(args, remoteBackups),
  reset_settings: () => {
    settings = { ...DEFAULT_SETTINGS }
    return { ...settings }
  },
  query_traffic_series: (args) => mockSeries(String(args['range'] ?? '7d')),
  query_traffic_rank: (args) =>
    mockRank(String(args['dim'] ?? 'proxy'), String(args['range'] ?? '7d')),
  query_traffic_summary: (args) => {
    const series = mockSeries(String(args['range'] ?? 'day'))
    const up = series.reduce((total, row) => total + row.up, 0)
    const down = series.reduce((total, row) => total + row.down, 0)
    const direct = Math.floor((up + down) * 0.2)
    const unattributed = Math.floor((up + down) * 0.05)
    return { up, down, direct, unattributed, proxy: up + down - direct - unattributed }
  },
  get_platform: () => navigator.userAgent.includes('Windows') ? 'Windows' : navigator.userAgent.includes('Mac') ? 'macOS' : 'Linux',
  probe_url: () => Math.round(30 + Math.random() * 300),
  media_probe: () => {
    if (!core.running) throw new Error('内核未运行，请先启动内核')
    return { proxyPort: settings.mixedPort, results: ['youtube', 'netflix', 'disney'].map((service) => ({
      service, status: 'reachable', elapsedMs: Math.round(rand(30, 150)), httpStatus: 200,
      detail: '模拟页面可达；不表示账号或地区片库已解锁',
    })) }
  },
  media_cancel: () => undefined,
  diagnostics_run: (args) => ({
    schemaVersion: 1, source: 'mock', appVersion: '2.4.8', platform: 'mock',
    generatedAt: Date.now(), durationMs: 0, includeInternet: Boolean(args['includeInternet']),
    checks: [{ id: 'simulation', title: '模拟诊断', status: 'unknown',
      detail: '浏览器模拟模式没有读取系统状态或探测网络；请在 Windows 客户端运行真实诊断。', suggestion: '', elapsedMs: null }],
  }),
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
    const enhancers = enhancersFor(pid)
    const kind = argString(args, 'kind') as EnhancerMeta['kind']
    const name = argString(args, 'name')
    const eid = typeof args['enhancerId'] === 'string' ? (args['enhancerId'] as string) : null
    let meta: EnhancerMeta
    if (eid) {
      const found = enhancers.find((e) => e.id === eid)
      if (!found) throw new Error(`增强项不存在: ${eid}`)
      found.name = name
      meta = found
    } else {
      meta = { id: `e-${Date.now().toString(36)}`, kind, name, enabled: true }
      enhancers.push(meta)
    }
    enhancerContents[`${pid}/${meta.id}`] = argString(args, 'content')
    return { ...meta }
  },
  delete_enhancer: (args) => {
    const pid = argString(args, 'profileId')
    const eid = argString(args, 'enhancerId')
    const enhancers = enhancersFor(pid)
    const index = enhancers.findIndex((e) => e.id === eid)
    if (index < 0) throw new Error('增强项不存在')
    enhancers.splice(index, 1)
    delete enhancerContents[`${pid}/${eid}`]
    return undefined
  },
  toggle_enhancer: (args) => {
    const e = enhancersFor(argString(args, 'profileId')).find((it) => it.id === args['enhancerId'])
    if (e) e.enabled = Boolean(args['enabled'])
    return undefined
  },
  reorder_enhancers: (args) => {
    const enhancers = enhancersFor(argString(args, 'profileId'))
    const ids = args['enhancerIds']
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new Error('参数 enhancerIds 缺失或类型错误')
    }
    if (ids.length !== enhancers.length) throw new Error('增强项数量不匹配')
    const uniqueIds = new Set(ids)
    if (uniqueIds.size !== ids.length) throw new Error('增强项 ID 重复')
    const byId = new Map(enhancers.map((enh) => [enh.id, enh]))
    for (const id of ids) {
      if (!byId.has(id)) throw new Error(`增强项不存在: ${id}`)
    }
    enhancers.splice(0, enhancers.length, ...ids.map((id) => byId.get(id)!))
    return undefined
  },
}

/** 增强项内容存储(键 `${profileId}/${enhancerId}`) */
const enhancerContents: Record<string, string> = {
  'p-bigairport/e-dns': `# 覆写 DNS 与端口\nmixed-port: 7897\ndns:\n  enable: true\n  enhanced-mode: fake-ip\n  nameserver:\n    - https://dns.alidns.com/dns-query\n    - https://doh.pub/dns-query\nprepend-rules:\n  - DOMAIN-SUFFIX,internal.corp,DIRECT\n`,
  'p-bigairport/e-rename': `// 节点改名 + 地区分组\nfunction main(config) {\n  const flags = { HK: '🇭🇰', TW: '🇹🇼', JP: '🇯🇵', SG: '🇸🇬', US: '🇺🇸' };\n  for (const p of config.proxies ?? []) {\n    const m = p.name.match(/^(HK|TW|JP|SG|US)/);\n    if (m && flags[m[1]]) p.name = flags[m[1]] + ' ' + p.name;\n  }\n  return config;\n}\n`,
  [`p-bigairport/${BUILTIN_PRUNE_ENHANCER_ID}`]: BUILTIN_PRUNE_SCRIPT,
  [`p-full-en/${BUILTIN_PRUNE_ENHANCER_ID}`]: BUILTIN_PRUNE_SCRIPT,
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
  const count = range === 'day' ? new Date().getHours() + 1 : range === '30d' ? 30 : 7
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
