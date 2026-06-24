/**
 * 实时数据状态 — traffic 60 点环形缓冲 / connections 快照 / logs 1024 行环形缓冲 + 暂停。
 * startLiveStreams() 把 ws.ts 的三路订阅接入 store(引用计数, 多页共享一份订阅)。
 */
import { create } from 'zustand'
import {
  subscribeConnections,
  subscribeLogs,
  subscribeMemory,
  subscribeTraffic,
  type Unsubscribe,
} from '../services/ws'
import type { ConnItem, ConnectionsPayload, LogItem, MemoryPoint, TrafficPoint } from '../types/clash'

/** traffic 环形缓冲容量(60 点 ≈ 60s) */
export const TRAFFIC_CAPACITY = 60
/** logs 环形缓冲容量 */
export const LOG_CAPACITY = 1024
const TRAFFIC_STALE_MS = 2500
const DUPLICATE_TRAFFIC_WINDOW_MS = 50

const EMPTY_CONNECTIONS: ConnectionsPayload = {
  downloadTotal: 0,
  uploadTotal: 0,
  connections: [],
}

let lastRealTrafficAt = 0
let lastTrafficSignature = ''
let lastTrafficSignatureAt = 0
let lastConnectionTotals: { upload: number; download: number; at: number } | null = null

function resetTrafficSamplingState(): void {
  lastRealTrafficAt = 0
  lastTrafficSignature = ''
  lastTrafficSignatureAt = 0
  lastConnectionTotals = null
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeTraffic(point: TrafficPoint | null | undefined): TrafficPoint {
  if (!point || typeof point !== 'object') return { up: 0, down: 0, timestamp: Date.now() }
  const timestamp = numberOrZero((point as Partial<TrafficPoint>).timestamp) || Date.now()
  const source = (point as Partial<TrafficPoint>).source
  return {
    up: Math.max(0, numberOrZero((point as Partial<TrafficPoint>).up)),
    down: Math.max(0, numberOrZero((point as Partial<TrafficPoint>).down)),
    ...(typeof (point as Partial<TrafficPoint>).upTotal === 'number'
      ? { upTotal: Math.max(0, numberOrZero((point as Partial<TrafficPoint>).upTotal)) }
      : {}),
    ...(typeof (point as Partial<TrafficPoint>).downTotal === 'number'
      ? { downTotal: Math.max(0, numberOrZero((point as Partial<TrafficPoint>).downTotal)) }
      : {}),
    timestamp,
    ...(source === 'traffic' || source === 'connections' || source === 'disconnect' || source === 'mock'
      ? { source }
      : {}),
  }
}

function shouldSkipDuplicateTraffic(point: TrafficPoint): boolean {
  const now = Date.now()
  const signature = `${Math.round(point.up)}:${Math.round(point.down)}:${Math.round(point.upTotal ?? 0)}:${Math.round(point.downTotal ?? 0)}:${point.source ?? ''}`
  if (signature === lastTrafficSignature && now - lastTrafficSignatureAt <= DUPLICATE_TRAFFIC_WINDOW_MS) {
    return true
  }
  lastTrafficSignature = signature
  lastTrafficSignatureAt = now
  return false
}

function normalizeConnection(value: unknown): ConnItem | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<ConnItem>
  const metadata =
    item.metadata && typeof item.metadata === 'object'
      ? (item.metadata as unknown as Record<string, unknown>)
      : {}
  return {
    id: stringOrEmpty(item.id),
    metadata: {
      host: stringOrEmpty(metadata.host),
      destinationIP: stringOrEmpty(metadata.destinationIP),
      destinationPort: stringOrEmpty(metadata.destinationPort),
      sourceIP: stringOrEmpty(metadata.sourceIP),
      sourcePort: stringOrEmpty(metadata.sourcePort),
      network: metadata.network === 'udp' ? 'udp' : 'tcp',
      ...(typeof metadata.process === 'string' ? { process: metadata.process } : {}),
      ...(typeof metadata.processPath === 'string' ? { processPath: metadata.processPath } : {}),
    },
    rule: stringOrEmpty(item.rule),
    rulePayload: stringOrEmpty(item.rulePayload),
    chains: Array.isArray(item.chains) ? item.chains.filter((chain): chain is string => typeof chain === 'string') : [],
    upload: numberOrZero(item.upload),
    download: numberOrZero(item.download),
    start: stringOrEmpty(item.start) || new Date().toISOString(),
    ...(typeof item.curUp === 'number' && Number.isFinite(item.curUp) ? { curUp: item.curUp } : {}),
    ...(typeof item.curDown === 'number' && Number.isFinite(item.curDown) ? { curDown: item.curDown } : {}),
  }
}

function normalizeConnections(payload: ConnectionsPayload | null | undefined): ConnectionsPayload {
  if (!payload || typeof payload !== 'object') return { ...EMPTY_CONNECTIONS }
  return {
    downloadTotal: numberOrZero((payload as Partial<ConnectionsPayload>).downloadTotal),
    uploadTotal: numberOrZero((payload as Partial<ConnectionsPayload>).uploadTotal),
    connections: Array.isArray((payload as Partial<ConnectionsPayload>).connections)
      ? (payload as Partial<ConnectionsPayload>).connections!.map(normalizeConnection).filter((item): item is ConnItem => item !== null)
      : [],
  }
}

function fallbackTrafficFromConnections(payload: ConnectionsPayload, previousTraffic: TrafficPoint[]): TrafficPoint | null {
  const now = Date.now()
  const totals = {
    upload: Math.max(0, payload.uploadTotal),
    download: Math.max(0, payload.downloadTotal),
    at: now,
  }
  const previous = lastConnectionTotals
  lastConnectionTotals = totals
  if (!previous) return null

  const elapsedSec = Math.max(0.001, (now - previous.at) / 1000)
  if (elapsedSec > 10) return null

  const upDelta = totals.upload >= previous.upload ? totals.upload - previous.upload : 0
  const downDelta = totals.download >= previous.download ? totals.download - previous.download : 0
  if (upDelta === 0 && downDelta === 0) return null

  const last = previousTraffic[previousTraffic.length - 1]
  const trafficStale = now - lastRealTrafficAt > TRAFFIC_STALE_MS
  const lastTrafficZero = Boolean(last && last.up === 0 && last.down === 0 && last.source !== 'connections')
  if (!trafficStale && !lastTrafficZero) return null

  return {
    up: Math.round(upDelta / elapsedSec),
    down: Math.round(downDelta / elapsedSec),
    upTotal: totals.upload,
    downTotal: totals.download,
    timestamp: now,
    source: 'connections',
  }
}

function normalizeMemory(point: MemoryPoint | null | undefined): MemoryPoint {
  if (!point || typeof point !== 'object') return { inuse: 0 }
  const oslimit = (point as Partial<MemoryPoint>).oslimit
  return {
    inuse: numberOrZero((point as Partial<MemoryPoint>).inuse),
    ...(typeof oslimit === 'number' && Number.isFinite(oslimit) ? { oslimit } : {}),
  }
}

function normalizeLog(log: LogItem | null | undefined): LogItem | null {
  if (!log || typeof log !== 'object') return null
  const type = log.type === 'warning' || log.type === 'error' || log.type === 'debug' ? log.type : 'info'
  return {
    type,
    payload: stringOrEmpty(log.payload),
    time: stringOrEmpty(log.time) || new Date().toLocaleTimeString(),
  }
}

export interface LiveStore {
  /** 最近 60 个流量点(尾部为最新) */
  traffic: TrafficPoint[]
  /** 最新连接快照 */
  connections: ConnectionsPayload
  /** 内核内存占用(WS /memory, 未知时 inuse=0) */
  memory: MemoryPoint
  /** 最近 1024 行日志(尾部为最新) */
  logs: LogItem[]
  /** 暂停时丢弃新日志 */
  logsPaused: boolean
  pushTraffic: (point: TrafficPoint | null | undefined) => void
  setConnections: (payload: ConnectionsPayload | null | undefined) => void
  setMemory: (point: MemoryPoint | null | undefined) => void
  pushLog: (log: LogItem | null | undefined) => void
  setLogsPaused: (paused: boolean) => void
  clearLogs: () => void
}

export const useLiveStore = create<LiveStore>((set, get) => ({
  traffic: [],
  connections: EMPTY_CONNECTIONS,
  memory: { inuse: 0 },
  logs: [],
  logsPaused: false,

  pushTraffic: (point) =>
    set((s) => {
      const safePoint = normalizeTraffic(point)
      if (safePoint.source === 'traffic' || safePoint.source === 'mock') {
        lastRealTrafficAt = Date.now()
      }
      if (shouldSkipDuplicateTraffic(safePoint)) return s
      return { traffic: [...s.traffic, safePoint].slice(-TRAFFIC_CAPACITY) }
    }),

  setConnections: (payload) =>
    set((s) => {
      const connections = normalizeConnections(payload)
      const fallback = fallbackTrafficFromConnections(connections, s.traffic)
      return {
        connections,
        ...(fallback ? { traffic: [...s.traffic, fallback].slice(-TRAFFIC_CAPACITY) } : {}),
      }
    }),

  setMemory: (point) => set({ memory: normalizeMemory(point) }),

  pushLog: (log) => {
    const safeLog = normalizeLog(log)
    if (!safeLog) return
    if (get().logsPaused) return
    set((s) => ({ logs: [...s.logs, safeLog].slice(-LOG_CAPACITY) }))
  },

  setLogsPaused: (paused) => set({ logsPaused: paused }),

  clearLogs: () => set({ logs: [] }),
}))

/* ---------------- 订阅生命周期(引用计数) ---------------- */

let refCount = 0
let unsubscribers: Unsubscribe[] = []

/**
 * 启动三路 WS 订阅并写入 store。返回释放函数;
 * 多个页面同时调用只建立一份底层订阅, 最后一个释放时断开。
 */
export function startLiveStreams(): Unsubscribe {
  refCount += 1
  if (refCount === 1) {
    const { pushTraffic, setConnections, setMemory, pushLog } = useLiveStore.getState()
    unsubscribers = [
      subscribeTraffic(pushTraffic),
      subscribeConnections(setConnections),
      subscribeMemory(setMemory),
      subscribeLogs(pushLog),
    ]
  }
  let released = false
  return () => {
    if (released) return
    released = true
    refCount -= 1
    if (refCount === 0) {
      for (const u of unsubscribers) u()
      unsubscribers = []
      resetTrafficSamplingState()
    }
  }
}
