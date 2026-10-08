/**
 * 应用状态 — settings/coreStatus/mode/theme(zustand)。
 * patchSettings 乐观更新 + ipc 持久化, 失败回滚。
 */
import { create } from 'zustand'
import { configureApi, getRuntimeConfigs, getVersion } from '../services/api'
import { call } from '../services/ipc'
import { DEFAULT_SETTINGS } from '../services/mock'
import type { AppSettings, CoreStatus, OutboundMode, Theme } from '../types/clash'
import { normalizeDnsSettings, syncDnsSettings } from '../utils/dnsOverride'

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
  resolvedTheme: 'dark' | 'light'
  /** mihomo 当前运行态模式; null 表示未同步或内核未运行 */
  runtimeMode: OutboundMode | null
  coreStatus: CoreStatus
  /** loadAll 是否已成功完成 */
  loaded: boolean
  /** 可用的新版本号(null=无更新, undefined=未检查, 'error'=检查失败) */
  updateAvailable: string | null | undefined
  /** 拉取 settings + core_status 并应用主题(幂等, 并发安全) */
  loadAll: () => Promise<void>
  /** 仅刷新内核状态(侧边栏 chip / 仪表盘 5s 轮询用) */
  refreshCoreStatus: (force?: boolean) => Promise<void>
  /** 从 mihomo /configs 同步低风险运行态字段, 不持久化本地设置 */
  syncRuntimeMode: () => Promise<void>
  /** 乐观更新 + save_settings 持久化, 失败回滚 */
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>
  /** 出站模式: set_mode(后端 PATCH /configs + 持久化) + mihomo REST 同步 */
  setMode: (mode: OutboundMode) => Promise<void>
  setTun: (enabled: boolean) => Promise<void>
  setTheme: (theme: Theme) => Promise<void>
  startCore: () => Promise<void>
  stopCore: () => Promise<void>
  restartCore: () => Promise<void>
  /** 检查更新(后台静默) */
  checkUpdate: () => Promise<void>
}

let loadAllPromise: Promise<void> | null = null
let settingsSaveQueue: Promise<void> = Promise.resolve()
let confirmedSettings = normalizeDnsSettings({ ...DEFAULT_SETTINGS })
let settingsRevision = 0
const pendingSettings: { patch: Partial<AppSettings> }[] = []
let coreRefreshPromise: Promise<void> | null = null
let runtimeSyncPromise: Promise<void> | null = null
/** refreshCoreStatus 调用序号: REST 兜底 await 期间有更新的刷新时丢弃过期结果 */
let coreRefreshSeq = 0

/** 失败只移除对应操作, 后续尚未持久化的修改始终在已确认快照上重放。 */
function publishSettings(): void {
  const settings = pendingSettings.reduce(
    (current, operation) => syncDnsSettings(current, operation.patch),
    confirmedSettings,
  )
  useAppStore.setState({ settings, resolvedTheme: applyTheme(settings.theme) })
}

async function enqueueSettings(
  patch: Partial<AppSettings>,
  persist: (patch: Partial<AppSettings>) => Promise<AppSettings>,
): Promise<void> {
  if (!useAppStore.getState().loaded) await useAppStore.getState().loadAll()
  const operation = { patch }
  pendingSettings.push(operation)
  settingsRevision += 1
  publishSettings()
  const result = settingsSaveQueue.then(async () => {
    const next = syncDnsSettings(confirmedSettings, patch)
    // 只提交本次意图及其 DNS 派生字段，后端在配置锁内合并，避免覆盖托盘等并发修改。
    const effectivePatch = { ...patch }
    for (const key of Object.keys(next) as (keyof AppSettings)[]) {
      if (next[key] !== confirmedSettings[key]) Object.assign(effectivePatch, { [key]: next[key] })
    }
    try {
      confirmedSettings = normalizeDnsSettings(await persist(effectivePatch))
    } catch (err) {
      try {
        confirmedSettings = normalizeDnsSettings(await call('get_settings'))
      } catch {
        // 后端不可达时保留最后一次已确认的快照, 不覆盖后续排队修改。
      }
      throw err
    } finally {
      pendingSettings.splice(pendingSettings.indexOf(operation), 1)
      configureApi(confirmedSettings.externalController, confirmedSettings.secret)
      publishSettings()
    }
  })
  settingsSaveQueue = result.catch(() => undefined)
  return result
}

/** App 壳层订阅一次, 编辑器、地图和顶栏共享解析后的主题。 */
export function watchSystemTheme(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: light)')
  const update = (): void => {
    const theme = useAppStore.getState().settings.theme
    useAppStore.setState({ resolvedTheme: applyTheme(theme) })
  }
  media.addEventListener('change', update)
  update()
  return () => media.removeEventListener('change', update)
}

async function hydrateCoreVersion(coreStatus: CoreStatus): Promise<CoreStatus> {
  if (coreStatus.running && (!coreStatus.version || coreStatus.version === '—')) {
    try {
      coreStatus.version = (await getVersion()).version
    } catch {
      // 内核未就绪, 下轮轮询再试
    }
  }
  return coreStatus
}

export const useAppStore = create<AppStore>((set, get) => ({
  settings: confirmedSettings,
  resolvedTheme: applyTheme(confirmedSettings.theme),
  runtimeMode: null,
  coreStatus: INITIAL_CORE,
  loaded: false,
  updateAvailable: undefined,

  loadAll: async () => {
    if (loadAllPromise) return loadAllPromise
    loadAllPromise = (async () => {
      const revision = settingsRevision
      const firstLoad = !get().loaded
      const [rawSettings, initialCoreStatus] = await Promise.all([
        call('get_settings'),
        call('core_status'),
      ])
      if (revision === settingsRevision && pendingSettings.length === 0) {
        confirmedSettings = normalizeDnsSettings(rawSettings)
        configureApi(confirmedSettings.externalController, confirmedSettings.secret)
        publishSettings()
      }
      const coreStatus = await hydrateCoreVersion(initialCoreStatus)
      set({ coreStatus, loaded: true })
      if (coreStatus.running) void get().syncRuntimeMode()
      // 启动后静默检查更新
      if (firstLoad) void get().checkUpdate()
    })().finally(() => {
      loadAllPromise = null
    })
    return loadAllPromise
  },

  refreshCoreStatus: async (force = false) => {
    if (coreRefreshPromise) {
      if (!force) return coreRefreshPromise
      await coreRefreshPromise.catch(() => undefined)
    }
    const seq = ++coreRefreshSeq
    const promise = (async () => {
      const coreStatus = await hydrateCoreVersion(await call('core_status'))
      if (seq === coreRefreshSeq) {
        set({ coreStatus, ...(coreStatus.running ? {} : { runtimeMode: null }) })
        if (coreStatus.running) await get().syncRuntimeMode()
      }
    })().finally(() => {
      if (coreRefreshPromise === promise) coreRefreshPromise = null
    })
    coreRefreshPromise = promise
    return promise
  },

  syncRuntimeMode: async () => {
    if (runtimeSyncPromise) return runtimeSyncPromise
    runtimeSyncPromise = (async () => {
      try {
        const { mode } = await getRuntimeConfigs()
        if (mode && get().coreStatus.running) set({ runtimeMode: mode })
      } catch {
        set({ runtimeMode: null })
      }
    })().finally(() => { runtimeSyncPromise = null })
    return runtimeSyncPromise
  },

  patchSettings: async (patch) => {
    await enqueueSettings(patch, (effectivePatch) => call('patch_settings', { patch: effectivePatch }))
  },

  setMode: async (mode) => {
    await enqueueSettings({ mode }, async () => {
      await call('set_mode', { mode })
      return call('get_settings')
    })
    set({ runtimeMode: mode })
  },

  setTun: async (enabled) => {
    await enqueueSettings({ tun: enabled }, async () => {
      await call('set_tun', { enable: enabled })
      return call('get_settings')
    })
    await get().refreshCoreStatus(true)
  },

  setTheme: async (theme) => {
    await get().patchSettings({ theme })
  },

  startCore: async () => {
    await call('start_core')
    await get().refreshCoreStatus(true)
  },

  stopCore: async () => {
    await call('stop_core')
    await get().refreshCoreStatus(true)
    set({ runtimeMode: null })
  },

  restartCore: async () => {
    await call('restart_core')
    await get().refreshCoreStatus(true)
  },

  checkUpdate: async () => {
    set({ updateAvailable: undefined })
    try {
      const version = await call('check_update')
      set({ updateAvailable: version ?? null })
    } catch {
      // 网络失败 → 标记为错误状态
      set({ updateAvailable: 'error' })
    }
  },
}))
