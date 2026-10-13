/**
 * 领域类型 — 锁定契约 A 全文(docs/plans/2026-06-11-m1-implementation.md)。
 * 双方(前端/Rust)各自实现时以此为准，不得擅改。
 */
import type { ProfileDownloadOptions } from './profileFeatures'
import type { TunOptions } from './tun'

export interface ProxyNode { name: string; type: string; udp?: boolean;
  history: { time: string; delay: number }[]; delay?: number }
export interface ProxyGroup { name: string;
  type: 'Selector' | 'URLTest' | 'Fallback' | 'LoadBalance' | string;
  now: string; all: string[] }
export interface ProxiesPayload { proxies: Record<string, ProxyNode & Partial<ProxyGroup>> }
export interface ConnMeta { host: string; destinationIP: string; destinationPort: string;
  sourceIP: string; sourcePort: string; network: 'tcp' | 'udp'; process?: string; processPath?: string
  /** 以下为详情面板展示用, mihomo 未提供时缺省 */
  type?: string; inboundName?: string; inboundUser?: string; inboundIP?: string; inboundPort?: string
  dnsMode?: string; sniffHost?: string; remoteDestination?: string; specialProxy?: string
  specialRules?: string; uid?: number; dscp?: number; destinationIPASN?: string; destinationGeoIP?: string[] }
export interface ConnItem { id: string; metadata: ConnMeta; rule: string; rulePayload: string;
  chains: string[]; upload: number; download: number; start: string;
  curUp?: number; curDown?: number }
export interface ConnectionsPayload { downloadTotal: number; uploadTotal: number; connections: ConnItem[] }
export interface RuleItem { type: string; payload: string; proxy: string }
/** GET /dns/query 的应答记录; type 为 RR 类型数值(1=A, 28=AAAA, 5=CNAME …) */
export interface DnsAnswer { name: string; type: number; TTL: number; data: string }
export interface DnsQueryResult { status: number; answers: DnsAnswer[] }
export interface LogItem { type: 'info' | 'warning' | 'error' | 'debug'; payload: string; time: string }
export interface TrafficPoint {
  up: number
  down: number
  upTotal?: number
  downTotal?: number
  timestamp?: number
  source?: 'traffic' | 'connections' | 'disconnect' | 'mock'
}
export interface MemoryPoint { inuse: number; oslimit?: number }
export interface CoreStatus { running: boolean; version: string; uptimeSec: number; memoryBytes: number }
export interface TunAdapterStatus {
  enabled: boolean
  adapterPresent: boolean
  adapterName?: string
  status?: string
  detail?: string
}
export interface ProfileQuota { used: number; total: number; expireAt?: number }
export interface EnhancerMeta { id: string; kind: 'merge' | 'script'; name: string; enabled: boolean }
export interface ProxyProviderItem { name: string; vehicleType: string; nodeCount: number;
  updatedAt?: number; subscription?: ProfileQuota }
export interface RuleProviderItem { name: string; behavior: string; vehicleType: string;
  ruleCount: number; updatedAt?: number }
export type StatRange = 'day' | '7d' | '30d'
export type StatDim = 'proxy' | 'process' | 'host'
export interface SeriesPoint { ts: number; up: number; down: number }
export interface RankRow { key: string; up: number; down: number }
export interface TrafficSummary { up: number; down: number; direct: number; proxy: number; unattributed: number }
export interface ProfileMeta { id: string; name: string; kind: 'remote' | 'local'; url?: string;
  updatedAt: number; autoUpdateMin?: number; sizeBytes?: number; quota?: ProfileQuota; current: boolean;
  enhancers?: EnhancerMeta[]; downloadOptions?: ProfileDownloadOptions }
export type OutboundMode = 'rule' | 'global' | 'direct'
export type Theme = 'dark' | 'light' | 'system'
export type Language = 'zh' | 'en'
export type DnsEnhancedMode = 'fake-ip' | 'redir-host'
export type FakeIpFilterMode = 'blacklist' | 'whitelist'
export interface AppSettings { sysProxy: boolean; guard: boolean; guardIntervalSec: number;
  bypass: string; tun: boolean; tunOptions: TunOptions;
  autostart: boolean; silentStart: boolean; lightweightOnClose: boolean;
  mixedPort: number; externalController: string; secret: string;
  allowLan: boolean; ipv6: boolean; logLevel: LogItem['type'] | 'silent';
  mode: OutboundMode; theme: Theme;
  /* ---- M2 ---- */
  language: Language;
  /** 注入 <style id="custom-css"> 的用户自定义样式 */
  customCss: string;
  /** DNS 覆写(空串表示不覆写); YAML 片段, 作为 dns: 段深合并 */
  dnsOverride: string;
  /** hosts 覆写; 每行 `域名 IP` */
  hosts: string;
  /** 全局热键: 动作 → 加速键(如 Ctrl+Shift+N); 空表示未绑定 */
  hotkeys: Record<string, string>;
  /** 统计保留天数, 0 表示无限保留。 */
  statsRetentionDays: number;
  /* ---- DNS 高级配置 ---- */
  /** 启用 DNS */
  enableDns: boolean;
  /** DNS 监听地址 */
  dnsListen: string;
  /** 增强模式 */
  dnsEnhancedMode: DnsEnhancedMode | '';
  /** Fake IP 范围 */
  fakeIpRange: string;
  /** Fake IP 过滤模式 */
  fakeIpFilterMode: FakeIpFilterMode;
  /** IPv6 DNS */
  ipv6Dns: boolean;
  /** 优先使用 HTTP/3 */
  preferH3: boolean;
  /** 遵循路由规则 */
  respectRules: boolean;
  /** 使用 Hosts */
  useHosts: boolean;
  /** 使用系统 Hosts */
  useSystemHosts: boolean;
  /* ---- 测速与内核高级项 ---- */
  /** 节点测速地址 */
  delayTestUrl: string;
  /** 节点测速超时(ms) */
  delayTestTimeout: number;
  /** 切换节点后关闭该策略组的旧连接 */
  autoCloseConnections: boolean;
  /** true 强制 unified-delay; false 沿用订阅 */
  unifiedDelay: boolean;
  /** 空串沿用订阅 */
  findProcessMode: FindProcessMode | '';
  /** true 开启域名嗅探; false 沿用订阅 */
  sniffer: boolean;
}
export type FindProcessMode = 'strict' | 'always' | 'off'
