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
export interface ProfileMeta { id: string; name: string; kind: 'remote' | 'local'; url?: string;
  updatedAt: number; autoUpdateMin?: number; sizeBytes?: number; quota?: ProfileQuota; current: boolean;
  enhancers?: EnhancerMeta[] }
export type OutboundMode = 'rule' | 'global' | 'direct'
export type Theme = 'dark' | 'light' | 'system'
export interface AppSettings { sysProxy: boolean; guard: boolean; guardIntervalSec: number;
  bypass: string; tun: boolean; autostart: boolean; silentStart: boolean;
  mixedPort: number; externalController: string; secret: string;
  allowLan: boolean; ipv6: boolean; logLevel: LogItem['type'] | 'silent';
  mode: OutboundMode; theme: Theme }
