/**
 * 实时数据状态 — traffic 60 点环形缓冲 / connections 快照 / logs 1024 行环形缓冲 + 暂停。
 * startLiveStreams() 把 ws.ts 的三路订阅接入 store(引用计数, 多页共享一份订阅)。
 */
import { create } from 'zustand'
import {
  subscribeConnections,
  subscribeLogs,
  subscribeTraffic,
  type Unsubscribe,
} from '../services/ws'
import type { ConnectionsPayload, LogItem, TrafficPoint } from '../types/clash'

/** traffic 环形缓冲容量(60 点 ≈ 60s) */
export const TRAFFIC_CAPACITY = 60
/** logs 环形缓冲容量 */
export const LOG_CAPACITY = 1024

const EMPTY_CONNECTIONS: ConnectionsPayload = {
  downloadTotal: 0,
  uploadTotal: 0,
  connections: [],
}

export interface LiveStore {
  /** 最近 60 个流量点(尾部为最新) */
  traffic: TrafficPoint[]
  /** 最新连接快照 */
  connections: ConnectionsPayload
  /** 最近 1024 行日志(尾部为最新) */
  logs: LogItem[]
  /** 暂停时丢弃新日志 */
  logsPaused: boolean
  pushTraffic: (point: TrafficPoint) => void
  setConnections: (payload: ConnectionsPayload) => void
  pushLog: (log: LogItem) => void
  setLogsPaused: (paused: boolean) => void
  clearLogs: () => void
}

export const useLiveStore = create<LiveStore>((set, get) => ({
  traffic: [],
  connections: EMPTY_CONNECTIONS,
  logs: [],
  logsPaused: false,

  pushTraffic: (point) =>
    set((s) => ({ traffic: [...s.traffic, point].slice(-TRAFFIC_CAPACITY) })),

  setConnections: (payload) => set({ connections: payload }),

  pushLog: (log) => {
    if (get().logsPaused) return
    set((s) => ({ logs: [...s.logs, log].slice(-LOG_CAPACITY) }))
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
    const { pushTraffic, setConnections, pushLog } = useLiveStore.getState()
    unsubscribers = [
      subscribeTraffic(pushTraffic),
      subscribeConnections(setConnections),
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
    }
  }
}
