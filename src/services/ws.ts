/**
 * mihomo WS 订阅 — 锁定契约 C。
 * WS /traffic → TrafficPoint/s; WS /connections → ConnectionsPayload/s;
 * WS /logs?level=info → LogItem。
 * mock 模式用定时器造数: traffic 每 1s randomwalk、logs 每 2s 一条、
 * connections 每 1s 快照微扰; 真实模式 WebSocket + 断线 3s 重连。
 */
import type { ConnectionsPayload, LogItem, MemoryPoint, TrafficPoint } from '../types/clash'
import { apiConfig, ensureConfigured } from './api'
import { isMock } from './ipc'
import { mockConnections, mockNextLog, mockNextMemory, mockNextTraffic } from './mock'

/** 取消订阅函数 */
export type Unsubscribe = () => void
export type StreamStatus = 'connecting' | 'connected' | 'disconnected' | 'paused'
type OnStatus = (status: StreamStatus) => void

const RECONNECT_MS = 3000

/** 真实模式: 建 WebSocket 并在断开后 3s 自动重连, 直到取消订阅 */
function subscribeWs<T>(
  path: string,
  onMessage: (data: T) => void,
  onDisconnect?: () => void,
  onStatus?: OnStatus,
): Unsubscribe {
  let ws: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let generation = 0

  const connect = async (): Promise<void> => {
    if (closed || document.hidden) return
    const current = ++generation
    onStatus?.('connecting')
    try {
      await ensureConfigured()
      if (closed || document.hidden || current !== generation) return
      const { baseUrl, secret } = apiConfig()
      const sep = path.includes('?') ? '&' : '?'
      const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}${path}${sep}token=${encodeURIComponent(secret)}`)
      ws = socket
      socket.onopen = () => {
        if (current === generation) onStatus?.('connected')
      }
      socket.onmessage = (ev: MessageEvent<string>) => {
        if (current !== generation) return
        try { onMessage(JSON.parse(ev.data) as T) } catch { /* 丢弃无效帧 */ }
      }
      socket.onerror = () => socket.close()
      socket.onclose = () => {
        if (current !== generation) return
        ws = null
        onDisconnect?.()
        onStatus?.('disconnected')
        if (!closed && !document.hidden) timer = setTimeout(() => { void connect() }, RECONNECT_MS)
      }
    } catch {
      if (closed || current !== generation) return
      onStatus?.('disconnected')
      timer = setTimeout(() => { void connect() }, RECONNECT_MS)
    }
  }

  const disconnect = (): void => {
    generation += 1
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      ws.close()
      ws = null
    }
    onDisconnect?.()
  }

  const reconnect = (): void => {
    if (closed) return
    disconnect()
    if (document.hidden) onStatus?.('paused')
    else void connect()
  }

  reconnect()
  window.addEventListener('clashnova-api-config-changed', reconnect)
  document.addEventListener('visibilitychange', reconnect)
  return () => {
    closed = true
    disconnect()
    onStatus?.('disconnected')
    window.removeEventListener('clashnova-api-config-changed', reconnect)
    document.removeEventListener('visibilitychange', reconnect)
  }
}

/** mock 模式: setInterval 推造数 */
function subscribeMock<T>(intervalMs: number, next: () => T, onMessage: (data: T) => void, onStatus?: OnStatus): Unsubscribe {
  let timer: ReturnType<typeof setInterval> | undefined
  const resume = (): void => {
    clearInterval(timer)
    if (document.hidden) { onStatus?.('paused'); return }
    onStatus?.('connected')
    onMessage(next())
    timer = setInterval(() => onMessage(next()), intervalMs)
  }
  resume()
  document.addEventListener('visibilitychange', resume)
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', resume)
    onStatus?.('disconnected')
  }
}

/** WS /traffic — 每秒一个 TrafficPoint(B/s) */
export function subscribeTraffic(onPoint: (point: TrafficPoint) => void, onStatus?: OnStatus): Unsubscribe {
  if (isMock) {
    return subscribeMock(
      1000,
      () => ({ ...mockNextTraffic(), timestamp: Date.now(), source: 'mock' as const }),
      onPoint,
      onStatus,
    )
  }
  return subscribeWs<TrafficPoint>(
    '/traffic',
    (point) => onPoint({ ...point, timestamp: Date.now(), source: point.source ?? 'traffic' }),
    () => onPoint({ up: 0, down: 0, timestamp: Date.now(), source: 'disconnect' as const }),
    onStatus,
  )
}

/** WS /connections — 每秒一份连接快照 */
export function subscribeConnections(
  onPayload: (payload: ConnectionsPayload) => void,
  onStatus?: OnStatus,
): Unsubscribe {
  if (isMock) return subscribeMock(1000, mockConnections, onPayload, onStatus)
  return subscribeWs<ConnectionsPayload>('/connections', onPayload,
    () => onPayload({ uploadTotal: 0, downloadTotal: 0, connections: [] }), onStatus)
}

/** WS /memory — 每秒一个内核内存占用点 */
export function subscribeMemory(onPoint: (point: MemoryPoint) => void, onStatus?: OnStatus): Unsubscribe {
  if (isMock) return subscribeMock(1000, mockNextMemory, onPoint, onStatus)
  return subscribeWs<MemoryPoint>('/memory', onPoint, () => onPoint({ inuse: 0 }), onStatus)
}

/** WS /logs?level={level} — mock 模式每 2s 一条仿真日志 */
export function subscribeLogs(
  onLog: (log: LogItem) => void,
  level: string = 'debug',
  onStatus?: OnStatus,
): Unsubscribe {
  if (isMock) return subscribeMock(2000, mockNextLog, onLog, onStatus)
  return subscribeWs<LogItem>(`/logs?level=${encodeURIComponent(level)}`, onLog, undefined, onStatus)
}
