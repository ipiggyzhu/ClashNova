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
  TunAdapterStatus,
  TrafficSummary,
} from '../types/clash'
import { mockHandlers } from './mock'
import type { ProfileDownloadOptions, ProfileTopology } from '../types/profileFeatures'
import type { BackupEntry, BackupExport, BackupPreview, WebDavConfig, WebDavConfigInput } from '../types/backup'
import type { AppUpdate, CoreUpdate, UpdateState } from '../types/updates'
import type { MediaReport } from '../types/media'
import type { DiagnosticReport } from '../types/diagnostics'

/** 是否运行在模拟模式(无 Rust 后端) */
export const isMock =
  import.meta.env.VITE_MOCK === '1' || !('__TAURI_INTERNALS__' in window)

/** 契约 B: 命令名 → { 参数, 返回值 } */
export interface IpcCommands {
  tray_panel_visible: { args: undefined; result: boolean }
  hide_tray_panel: { args: undefined; result: void }
  tray_open_main: { args: undefined; result: void }
  tray_quit_app: { args: undefined; result: void }
  get_settings: { args: undefined; result: AppSettings }
  save_settings: { args: { settings: AppSettings }; result: void }
  patch_settings: { args: { patch: Partial<AppSettings> }; result: AppSettings }
  core_status: { args: undefined; result: CoreStatus }
  start_core: { args: undefined; result: void }
  stop_core: { args: undefined; result: void }
  restart_core: { args: undefined; result: void }
  list_profiles: { args: undefined; result: ProfileMeta[] }
  import_profile: { args: { url: string; options?: ProfileDownloadOptions }; result: ProfileMeta }
  import_profile_file: { args: { name: string; content: string }; result: ProfileMeta }
  update_profile: { args: { id: string }; result: ProfileMeta }
  update_profile_meta: {
    args: { id: string; name: string; url: string | null; autoUpdateMin: number | null; downloadOptions?: ProfileDownloadOptions }
    result: ProfileMeta
  }
  select_profile: { args: { id: string }; result: void }
  delete_profile: { args: { id: string }; result: void }
  read_profile: { args: { id: string }; result: string }
  list_profile_rule_targets: { args: { id: string }; result: string[] }
  save_profile_content: { args: { id: string; content: string }; result: void }
  read_profile_topology: { args: { id: string }; result: ProfileTopology }
  save_profile_topology: {
    args: { id: string; originalContent: string; proxies: Record<string, unknown>[]; groups: Record<string, unknown>[]; renames?: Record<string, string> }
    result: void
  }
  list_global_enhancers: { args: undefined; result: EnhancerMeta[] }
  pending_profile_imports: { args: undefined; result: { id: number; name?: string | null; host: string; importing: boolean }[] }
  dismiss_profile_import: { args: { id: number }; result: void }
  confirm_profile_import: { args: { id: number }; result: ProfileMeta }
  read_enhancer: { args: { profileId: string; enhancerId: string }; result: string }
  save_enhancer: {
    args: { profileId: string; enhancerId: string | null; kind: 'merge' | 'script'; name: string; content: string }
    result: EnhancerMeta
  }
  delete_enhancer: { args: { profileId: string; enhancerId: string }; result: void }
  toggle_enhancer: { args: { profileId: string; enhancerId: string; enabled: boolean }; result: void }
  reorder_enhancers: { args: { profileId: string; enhancerIds: string[] }; result: void }
  set_system_proxy: { args: { enable: boolean }; result: void }
  set_tun: { args: { enable: boolean }; result: void }
  set_mode: { args: { mode: string }; result: void }
  open_app_dir: { args: { kind: 'config' | 'core' | 'logs' }; result: void }
  /* ---- M2 ---- */
  open_url: { args: { url: string }; result: void }
  service_status: { args: undefined; result: string }
  check_tun_adapter: { args: undefined; result: TunAdapterStatus }
  probe_url: { args: { url: string }; result: number }
  media_probe: { args: { requestId: string }; result: MediaReport }
  media_cancel: { args: { requestId: string }; result: void }
  diagnostics_run: { args: { includeInternet: boolean }; result: DiagnosticReport }
  install_service: { args: undefined; result: void }
  start_service: { args: undefined; result: void }
  uninstall_service: { args: undefined; result: void }
  reinstall_service: { args: undefined; result: void }
  repair_service: { args: undefined; result: void }
  exempt_uwp_loopback: { args: undefined; result: void }
  check_update: { args: undefined; result: string | null }
  get_update_state: { args: undefined; result: UpdateState }
  check_app_update: { args: undefined; result: AppUpdate | null }
  check_core_update: { args: undefined; result: CoreUpdate }
  download_app_update: { args: undefined; result: void }
  download_core_update: { args: undefined; result: void }
  cancel_update: { args: undefined; result: void }
  install_app_update: { args: { confirm: boolean }; result: void }
  switch_core_version: { args: { id: string; confirm: boolean }; result: void }
  backup_list: { args: undefined; result: BackupEntry[] }
  backup_create: { args: { label: string }; result: BackupEntry }
  backup_delete: { args: { id: string }; result: void }
  backup_export: { args: { id: string; redacted: boolean }; result: BackupExport }
  backup_import: { args: { content: string }; result: BackupEntry }
  backup_preview: { args: { id: string }; result: BackupPreview }
  backup_restore: { args: { id: string }; result: AppSettings }
  backup_webdav_get: { args: undefined; result: WebDavConfig }
  backup_webdav_save: { args: { config: WebDavConfigInput }; result: void }
  backup_webdav_list: { args: undefined; result: BackupEntry[] }
  backup_webdav_upload: { args: { id: string }; result: void }
  backup_webdav_download: { args: { id: string }; result: BackupEntry }
  backup_webdav_delete: { args: { id: string }; result: void }
  reset_settings: { args: undefined; result: AppSettings }
  query_traffic_series: { args: { range: StatRange }; result: SeriesPoint[] }
  query_traffic_rank: { args: { dim: StatDim; range: StatRange }; result: RankRow[] }
  get_runtime_config: { args: undefined; result: string }
  query_traffic_summary: { args: { range: StatRange }; result: TrafficSummary }
  get_platform: { args: undefined; result: string }
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
