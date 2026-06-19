/**
 * Tauri invoke 适配层 — 锁定契约 B 的前端入口。
 * VITE_MOCK=1 或非 Tauri 环境时查 mock.ts 的 handler 表(延迟 80-200ms resolve)。
 */
import type {
  AppSettings,
  CoreStatus,
  EnhancerMeta,
  ProfileMeta,
  RankRow,
  SeriesPoint,
  StatDim,
  StatRange,
} from '../types/clash'
import { mockHandlers } from './mock'

/** 是否运行在模拟模式(无 Rust 后端) */
export const isMock =
  import.meta.env.VITE_MOCK === '1' || !('__TAURI_INTERNALS__' in window)

/** 契约 B: 命令名 → { 参数, 返回值 } */
export interface IpcCommands {
  get_settings: { args: undefined; result: AppSettings }
  save_settings: { args: { settings: AppSettings }; result: void }
  core_status: { args: undefined; result: CoreStatus }
  start_core: { args: undefined; result: void }
  stop_core: { args: undefined; result: void }
  restart_core: { args: undefined; result: void }
  list_profiles: { args: undefined; result: ProfileMeta[] }
  import_profile: { args: { url: string }; result: ProfileMeta }
  import_profile_file: { args: { name: string; content: string }; result: ProfileMeta }
  update_profile: { args: { id: string }; result: ProfileMeta }
  select_profile: { args: { id: string }; result: void }
  delete_profile: { args: { id: string }; result: void }
  read_profile: { args: { id: string }; result: string }
  save_profile_content: { args: { id: string; content: string }; result: void }
  read_enhancer: { args: { profileId: string; enhancerId: string }; result: string }
  save_enhancer: {
    args: { profileId: string; enhancerId: string | null; kind: 'merge' | 'script'; name: string; content: string }
    result: EnhancerMeta
  }
  delete_enhancer: { args: { profileId: string; enhancerId: string }; result: void }
  toggle_enhancer: { args: { profileId: string; enhancerId: string; enabled: boolean }; result: void }
  set_system_proxy: { args: { enable: boolean }; result: void }
  set_tun: { args: { enable: boolean }; result: void }
  set_mode: { args: { mode: string }; result: void }
  open_app_dir: { args: { kind: 'config' | 'core' | 'logs' }; result: void }
  /* ---- M2 ---- */
  open_url: { args: { url: string }; result: void }
  service_status: { args: undefined; result: 'running' | 'installed' | 'not-installed' }
  install_service: { args: undefined; result: void }
  uninstall_service: { args: undefined; result: void }
  exempt_uwp_loopback: { args: undefined; result: void }
  check_update: { args: undefined; result: string | null }
  reset_settings: { args: undefined; result: AppSettings }
  query_traffic_series: { args: { range: StatRange }; result: SeriesPoint[] }
  query_traffic_rank: { args: { dim: StatDim; range: StatRange }; result: RankRow[] }
  get_runtime_config: { args: undefined; result: string }
}

export type IpcCommand = keyof IpcCommands

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 调用契约 B 命令。mock 模式查表并模拟 IPC 延迟; 真实模式走 Tauri invoke。
 */
export async function call<C extends IpcCommand>(
  cmd: C,
  ...rest: IpcCommands[C]['args'] extends undefined
    ? [args?: undefined]
    : [args: IpcCommands[C]['args']]
): Promise<IpcCommands[C]['result']> {
  const args = rest[0]
  if (isMock) {
    const handler = mockHandlers[cmd]
    if (!handler) throw new Error(`mock 未实现命令: ${cmd}`)
    await sleep(80 + Math.random() * 120)
    return handler((args ?? {}) as Record<string, unknown>) as IpcCommands[C]['result']
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<IpcCommands[C]['result']>(cmd, args as Record<string, unknown> | undefined)
}
