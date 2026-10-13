import { useCallback, useEffect, useRef, useState } from 'react'
import Badge from './ui/Badge'
import Button from './ui/Button'
import Card from './ui/Card'
import Dialog from './ui/Dialog'
import Icon from './ui/Icon'
import { useT } from '../i18n'
import { call } from '../services/ipc'
import { useAppStore } from '../stores/app'
import type { UpdatePhase, UpdateState } from '../types/updates'
import './UpdateSettings.css'

const BUSY_PHASES = new Set<UpdatePhase>(['checking', 'downloading', 'verifying', 'installing', 'switching'])
const PHASE_LABELS: Record<UpdatePhase, string> = {
  idle: '待命', checking: '检查中…', downloading: '下载中…', verifying: '校验中…', ready: '安装包已校验',
  installing: '等待安装程序…', switching: '切换内核中…', failed: '更新失败', cancelled: '已取消下载',
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function size(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 原生下载状态独立于页面生命周期；离开设置不会自动安装或切换内核。 */
export default function UpdateSettings() {
  const t = useT()
  const [state, setState] = useState<UpdateState | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [confirm, setConfirm] = useState<'app' | 'core' | null>(null)
  const [selected, setSelected] = useState('')
  const actionInFlight = useRef(false)
  const mounted = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    const next = await call('get_update_state')
    if (!mounted.current) return
    setState(next)
    setSelected((current) => next.installedCores.some((core) => core.id === current)
      ? current : next.installedCores.find((core) => core.active)?.id ?? 'bundled')
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh().catch((err) => { if (mounted.current) setError(message(err)) })
    return () => { mounted.current = false }
  }, [refresh])

  const nativeBusy = state ? BUSY_PHASES.has(state.phase) : false
  useEffect(() => {
    if (!nativeBusy) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try { await refresh() } catch (err) { if (!stopped && mounted.current) setError(message(err)) }
      if (!stopped) timer = setTimeout(() => void poll(), 500)
    }
    timer = setTimeout(() => void poll(), 500)
    return () => { stopped = true; clearTimeout(timer) }
  }, [nativeBusy, refresh])

  const run = (action: () => Promise<unknown>): void => {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setPending(true)
    setError('')
    void action().catch((err) => { if (mounted.current) setError(message(err)) }).finally(async () => {
      try { await refresh() } catch (err) { if (mounted.current) setError(message(err)) }
      actionInFlight.current = false
      if (mounted.current) setPending(false)
    })
  }

  const busy = pending || nativeBusy
  const unsupported = state?.supported === false
  const active = state?.installedCores.find((core) => core.active)
  const chosen = state?.installedCores.find((core) => core.id === selected)
  const progress = state && state.total > 0 ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : 0
  const displayedError = error || state?.error

  return (
    <Card title={t('应用与内核更新')} icon={<Icon name="download" />} iconColor="var(--accent)" className="update-settings">
      {unsupported && <p className="update-note">{t('应用内更新本轮仅支持 Windows；其他平台请使用发布页安装包。')}</p>}
      <section className="update-section" aria-label={t('应用更新')}>
        <div className="update-heading">
          <h4>ClashNova <span className="chip">v{__APP_VERSION__}</span></h4>
          <Button size="sm" disabled={!state || busy || unsupported} onClick={() => run(() => call('check_app_update'))}>
            {t('检查应用更新')}
          </Button>
        </div>
        {state?.app ? <>
          <p className="update-note"><Badge tone="orange">v{state.app.version}{state.app.sameVersion ? ` · ${t('新构建')}` : ''}</Badge>
            <span>{state.app.buildId.slice(0, 8)} · {size(state.app.size)}</span></p>
          <p className="update-hash" title={state.app.sha256}>SHA256 · {state.app.sha256}</p>
          <div className="update-actions">
            {state.appDownloaded
              ? <Button variant="primary" size="sm" disabled={busy} onClick={() => setConfirm('app')}>{t('退出并安装更新')}</Button>
              : <Button variant="primary" size="sm" disabled={busy} onClick={() => run(() => call('download_app_update'))}>{t('下载更新')}</Button>}
          </div>
        </> : state?.appChecked && <p className="update-note">{t('当前没有可用的新版本或后续构建。')}</p>}
        <p className="update-note">{t('只接收官方仓库的 Windows 安装包，校验 SHA256 后仍需确认安装；同版本按源码提交关系判断更新。')}</p>
      </section>

      <section className="update-section" aria-label={t('内核更新')}>
        <div className="update-heading">
          <h4>mihomo <span className="chip">{active?.version ?? '—'}</span></h4>
          <Button size="sm" disabled={!state || busy || unsupported} onClick={() => run(() => call('check_core_update'))}>{t('检查内核更新')}</Button>
        </div>
        {state?.core && <div className="update-actions">
          <span>{t('官方稳定版')} {state.core.version} · {size(state.core.size)}</span>
          <Button size="sm" disabled={busy} onClick={() => run(() => call('download_core_update'))}>{t('下载内核')}</Button>
        </div>}
        <div className="update-actions">
          <select className="select" aria-label={t('已下载的内核版本')} value={selected} disabled={!state || busy || unsupported} onChange={(event) => setSelected(event.target.value)}>
            {state?.installedCores.map((core) => <option key={core.id} value={core.id}>
              {core.version}{core.bundled ? ` · ${t('内置')}` : ''}{core.active ? ` · ${t('当前')}` : ''}
            </option>)}
          </select>
          <Button size="sm" disabled={!chosen || busy || unsupported} onClick={() => setConfirm('core')}>
            {chosen?.active ? t('重新应用') : t('切换内核')}
          </Button>
        </div>
        <p className="update-note">{t('下载不会自动切换。切换会短暂中断连接；服务模式需要 UAC，失败回滚原内核，可随时切回内置版本。')}</p>
      </section>

      {state && state.phase !== 'idle' && <div className="update-progress" role="status" aria-live="polite">
        <span>{t(PHASE_LABELS[state.phase])}</span>
        {state.phase === 'downloading' && <>
          <progress max={100} value={progress} aria-label={t('更新下载进度')} />
          <span>{size(state.downloaded)} / {size(state.total)} · {progress}%</span>
        </>}
        {(state.phase === 'downloading' || state.phase === 'ready') && <Button size="sm" disabled={pending} onClick={() => run(() => call('cancel_update'))}>{t('取消下载')}</Button>}
      </div>}
      {displayedError && <p className="update-error" role="alert">{displayedError}</p>}

      {confirm && <Dialog title={t(confirm === 'app' ? '确认安装更新' : '确认切换内核')} className="update-mask" panelClassName="update-dialog"
        onClose={() => setConfirm(null)} dismissible={!pending}>
        <h3>{t(confirm === 'app' ? '确认安装更新' : '确认切换内核')}</h3>
        <p>{confirm === 'app'
          ? t('将停止当前内核、退出 ClashNova 并打开已校验的 Windows 安装程序。UAC 取消时恢复当前运行状态，配置文件不会删除。')
          : t('将重启内核并验证当前配置；连接会短暂中断。已安装服务时会请求管理员确认，启动或校验失败会回滚。')}</p>
        <p className="update-note">{confirm === 'app' ? `v${state?.app?.version} · ${state?.app?.buildId.slice(0, 8)}` : chosen?.version}</p>
        <div className="update-actions">
          <Button onClick={() => setConfirm(null)} disabled={pending}>{t('取消')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => run(async () => {
            if (confirm === 'app') await call('install_app_update', { confirm: true })
            else {
              await call('switch_core_version', { id: selected, confirm: true })
              await useAppStore.getState().refreshCoreStatus(true)
            }
            if (mounted.current) setConfirm(null)
          })}>{t(confirm === 'app' ? '确认退出并安装' : '确认切换')}</Button>
        </div>
      </Dialog>}
    </Card>
  )
}
