/**
 * 应用状态 — settings/coreStatus/mode/theme(zustand)。
 * patchSettings 乐观更新 + ipc 持久化, 失败回滚。
 */
import { create } from 'zustand'
import { configureApi, getVersion, patchMode } from '../services/api'
import { call } from '../services/ipc'
import { DEFAULT_SETTINGS } from '../services/mock'
import type { AppSettings, CoreStatus, OutboundMode, Theme } from '../types/clash'

/** 把 theme(含 system) 解析为实际生效的明暗值并写到 <html data-theme> */
export function applyTheme(theme: Theme): 'dark' | 'light' {
  const resolved: 'dark' | 'light' =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme
  document.documentElement.dataset['theme'] = resolved
  return resolved
}

const INITIAL_CORE: CoreStatus = {
  running: false,
  version: '—',
  uptimeSec: 0,
  memoryBytes: 0,
}

export interface AppStore {
  settings: AppSettings
  coreStatus: CoreStatus
  /** loadAll 是否已成功完成 */
  loaded: boolean
  /** 可用的新版本号(null=无更新, undefined=未检查, 'error'=检查失败) */
  updateAvailable: string | null | undefined
  /** 拉取 settings + core_status 并应用主题(幂等, 并发安全) */
  loadAll: () => Promise<void>
  /** 仅刷新内核状态(侧边栏 chip / 仪表盘 5s 轮询用) */
  refreshCoreStatus: () => Promise<void>
  /** 乐观更新 + save_settings 持久化, 失败回滚 */
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>
  /** 出站模式: set_mode(后端 PATCH /configs + 持久化) + mihomo REST 同步 */
  setMode: (mode: OutboundMode) => Promise<void>
  setTheme: (theme: Theme) => Promise<void>
  startCore: () => Promise<void>
  stopCore: () => Promise<void>
  restartCore: () => Promise<void>
  /** 检查更新(后台静默) */
  checkUpdate: () => Promise<void>
}

let loadAllPromise: Promise<void> | null = null
/** refreshCoreStatus 调用序号: REST 兜底 await 期间有更新的刷新时丢弃过期结果 */
let coreRefreshSeq = 0

export const useAppStore = create<AppStore>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  coreStatus: INITIAL_CORE,
  loaded: false,
  updateAvailable: undefined,

  loadAll: async () => {
    loadAllPromise ??= (async () => {
      const [settings, coreStatus] = await Promise.all([
        call('get_settings'),
        call('core_status'),
      ])
      configureApi(settings.externalController, settings.secret)
      applyTheme(settings.theme)
      set({ settings, coreStatus, loaded: true })
      // 启动后静默检查更新
      void get().checkUpdate()
    })().catch((err: unknown) => {
      loadAllPromise = null
      throw err
    })
    return loadAllPromise
  },

  refreshCoreStatus: async () => {
    const seq = ++coreRefreshSeq
    const coreStatus = await call('core_status')
    // 后端缓存未就绪时直接问内核 REST /version 兜底
    if (coreStatus.running && (!coreStatus.version || coreStatus.version === '—')) {
      try {
        coreStatus.version = (await getVersion()).version
      } catch {
        // 内核未就绪, 下轮轮询再试
      }
    }
    // await 期间出现了更新的刷新(如 stop/start 后的立即刷新) → 本次结果作废
    if (seq === coreRefreshSeq) set({ coreStatus })
  },

  patchSettings: async (patch) => {
    const prev = get().settings
    const next = { ...prev, ...patch }
    set({ settings: next })
    if (patch.theme !== undefined) applyTheme(patch.theme)
    try {
      await call('save_settings', { settings: next })
      configureApi(next.externalController, next.secret)
    } catch (err) {
      // 持久化失败 → 回滚乐观更新
      set({ settings: prev })
      if (prev.theme !== next.theme) applyTheme(prev.theme)
      throw err
    }
  },

  setMode: async (mode) => {
    const prev = get().settings
    set({ settings: { ...prev, mode } })
    try {
      await call('set_mode', { mode })
      await patchMode(mode)
    } catch (err) {
      set({ settings: { ...get().settings, mode: prev.mode } })
      throw err
    }
  },

  setTheme: async (theme) => {
    await get().patchSettings({ theme })
  },

  startCore: async () => {
    await call('start_core')
    await get().refreshCoreStatus()
  },

  stopCore: async () => {
    await call('stop_core')
    await get().refreshCoreStatus()
  },

  restartCore: async () => {
    await call('restart_core')
    await get().refreshCoreStatus()
  },

  checkUpdate: async () => {
    try {
      const version = await call('check_update')
      set({ updateAvailable: version ?? null })
    } catch {
      // 网络失败 → 标记为错误状态
      set({ updateAvailable: 'error' })
    }
  },
}))
