/**
 * mihomo WS 订阅 — 锁定契约 C。
 * WS /traffic → TrafficPoint/s; WS /connections → ConnectionsPayload/s;
 * WS /logs?level=info → LogItem。
 * mock 模式用定时器造数: traffic 每 1s randomwalk、logs 每 2s 一条、
 * connections 每 1s 快照微扰; 真实模式 WebSocket + 断线 3s 重连。
 */
import type { ConnectionsPayload, LogItem, MemoryPoint, TrafficPoint } from '../types/clash'
import { apiConfig } from './api'
import { isMock } from './ipc'
import { mockConnections, mockNextLog, mockNextMemory, mockNextTraffic } from './mock'

/** 取消订阅函数 */
export type Unsubscribe = () => void

const RECONNECT_MS = 3000

/** 真实模式: 建 WebSocket 并在断开后 3s 自动重连, 直到取消订阅 */
function subscribeWs<T>(
  path: string,
  onMessage: (data: T) => void,
  onDisconnect?: () => void,
): Unsubscribe {
  let ws: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const connect = (): void => {
    if (closed) return
    const { baseUrl, secret } = apiConfig()
    const wsBase = baseUrl.replace(/^http/, 'ws')
    const sep = path.includes('?') ? '&' : '?'
    ws = new WebSocket(`${wsBase}${path}${sep}token=${encodeURIComponent(secret)}`)
    ws.onmessage = (ev: MessageEvent<string>) => {
      try {
        onMessage(JSON.parse(ev.data) as T)
      } catch {
        // 忽略无法解析的帧
      }
    }
    ws.onclose = () => {
      ws = null
      onDisconnect?.()
      if (!closed) timer = setTimeout(connect, RECONNECT_MS)
    }
  }

  connect()
  return () => {
    closed = true
    if (timer !== null) clearTimeout(timer)
    ws?.close()
  }
}

/** mock 模式: setInterval 推造数 */
function subscribeMock<T>(intervalMs: number, next: () => T, onMessage: (data: T) => void): Unsubscribe {
  // 立即推一帧, 避免页面初始空白
  onMessage(next())
  const timer = setInterval(() => onMessage(next()), intervalMs)
  return () => clearInterval(timer)
}

/** WS /traffic — 每秒一个 TrafficPoint(B/s) */
export function subscribeTraffic(onPoint: (point: TrafficPoint) => void): Unsubscribe {
  if (isMock) {
    return subscribeMock(
      1000,
      () => ({ ...mockNextTraffic(), timestamp: Date.now(), source: 'mock' as const }),
      onPoint,
    )
  }
  return subscribeWs<TrafficPoint>(
    '/traffic',
    (point) => onPoint({ ...point, timestamp: Date.now(), source: point.source ?? 'traffic' }),
    () => onPoint({ up: 0, down: 0, timestamp: Date.now(), source: 'disconnect' as const }),
  )
}

/** WS /connections — 每秒一份连接快照 */
export function subscribeConnections(
  onPayload: (payload: ConnectionsPayload) => void,
): Unsubscribe {
  if (isMock) return subscribeMock(1000, mockConnections, onPayload)
  return subscribeWs<ConnectionsPayload>('/connections', onPayload)
}

/** WS /memory — 每秒一个内核内存占用点 */
export function subscribeMemory(onPoint: (point: MemoryPoint) => void): Unsubscribe {
  if (isMock) return subscribeMock(1000, mockNextMemory, onPoint)
  return subscribeWs<MemoryPoint>('/memory', onPoint)
}

/** WS /logs?level={level} — mock 模式每 2s 一条仿真日志 */
export function subscribeLogs(
  onLog: (log: LogItem) => void,
  level: string = 'info',
): Unsubscribe {
  if (isMock) return subscribeMock(2000, mockNextLog, onLog)
  return subscribeWs<LogItem>(`/logs?level=${encodeURIComponent(level)}`, onLog)
}
