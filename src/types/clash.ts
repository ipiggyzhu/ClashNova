/**
 * 领域类型 — 锁定契约 A 全文(docs/plans/2026-06-11-m1-implementation.md)。
 * 双方(前端/Rust)各自实现时以此为准，不得擅改。
 */
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
export interface EnhancerMeta { id: string; kind: 'merge' | 'script'; name: string; enabled: boolean }
export interface ProxyProviderItem { name: string; vehicleType: string; nodeCount: number;
  updatedAt?: number; subscription?: ProfileQuota }
export interface RuleProviderItem { name: string; behavior: string; vehicleType: string;
  ruleCount: number; updatedAt?: number }
export type StatRange = 'day' | '7d' | '30d'
export type StatDim = 'proxy' | 'process' | 'host'
export interface SeriesPoint { ts: number; up: number; down: number }
export interface RankRow { key: string; up: number; down: number }
export interface ProfileMeta { id: string; name: string; kind: 'remote' | 'local'; url?: string;
  updatedAt: number; autoUpdateMin?: number; sizeBytes?: number; quota?: ProfileQuota; current: boolean;
  enhancers?: EnhancerMeta[] }
export type OutboundMode = 'rule' | 'global' | 'direct'
export type Theme = 'dark' | 'light' | 'system'
export type Language = 'zh' | 'en'
export interface AppSettings { sysProxy: boolean; guard: boolean; guardIntervalSec: number;
  bypass: string; tun: boolean; autostart: boolean; silentStart: boolean;
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
  hotkeys: Record<string, string> }
