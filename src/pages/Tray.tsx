import { useCallback, useEffect, useRef, useState } from 'react'
import './Tray.css'
import Button from '../components/ui/Button'
import Icon from '../components/ui/Icon'
import Seg from '../components/ui/Seg'
import Spark from '../components/ui/Spark'
import Toggle from '../components/ui/Toggle'
import { usePollingQuery } from '../hooks/usePollingQuery'
import { useT } from '../i18n'
import { closeGroupConnections, getProxies, selectProxy } from '../services/api'
import { call, isMock } from '../services/ipc'
import { useAppStore, watchSystemTheme } from '../stores/app'
import { startLiveStreams, useLiveStore } from '../stores/live'
import type { OutboundMode, ProfileMeta, ProxiesPayload } from '../types/clash'
import { daysLeft, fmtBytes, fmtSpeed } from '../utils/format'

interface TraySnapshot {
  profiles: ProfileMeta[]
  proxies: ProxiesPayload | null
  proxyError: string | null
}

async function loadSnapshot(): Promise<TraySnapshot> {
  await useAppStore.getState().loadAll()
  const profiles = await call('list_profiles')
  let proxies: ProxiesPayload | null = null
  let proxyError: string | null = null
  if (useAppStore.getState().coreStatus.running) {
    try { proxies = await getProxies() }
    catch (error) { proxyError = String(error) }
  }
  return { profiles, proxies, proxyError }
}

/** 独立窗口，不挂载主界面壳层；隐藏时卸载内容，释放全部轮询和 WS。 */
export default function Tray() {
  const t = useT()
  const language = useAppStore((s) => s.settings.language)
  const [nativeVisible, setNativeVisible] = useState(isMock)
  const [documentVisible, setDocumentVisible] = useState(!document.hidden)
  const [error, setError] = useState('')
  const dismiss = useCallback(async () => {
    try {
      await call('hide_tray_panel')
      setNativeVisible(false)
    } catch { setError('关闭快捷面板失败') }
  }, [])

  useEffect(() => { document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN' }, [language])

  useEffect(() => {
    document.documentElement.dataset.tray = 'true'
    const onVisibility = (): void => setDocumentVisible(!document.hidden)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        void dismiss()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('keydown', onKey)
    let disposed = false
    let revision = 0
    let stop: (() => void) | undefined
    if (!isMock) {
      void import('@tauri-apps/api/event').then(async ({ listen }) => {
        const unlisten = await listen<boolean>('tray-visibility', ({ payload }) => {
          revision += 1
          if (!disposed) setNativeVisible(payload)
        })
        if (disposed) { unlisten(); return }
        stop = unlisten
        const current = revision
        const visible = await call('tray_panel_visible')
        if (!disposed && current === revision) setNativeVisible(visible)
      }).catch(() => { if (!disposed) setError('快捷面板初始化失败') })
    }
    return () => {
      disposed = true
      stop?.()
      delete document.documentElement.dataset.tray
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('keydown', onKey)
    }
  }, [dismiss])

  return <main className="tray-root" aria-label={t('快捷面板')}>
    {error && <div className="tray-error" role="alert">{t(error)}</div>}
    {nativeVisible && documentVisible && <TrayContent onClose={() => { void dismiss() }} />}
  </main>
}

function TrayContent({ onClose }: { onClose: () => void }) {
  const t = useT()
  const settings = useAppStore(s => s.settings)
  const core = useAppStore(s => s.coreStatus)
  const loaded = useAppStore(s => s.loaded)
  const runtimeMode = useAppStore(s => s.runtimeMode)
  const traffic = useLiveStore(s => s.traffic)
  const connections = useLiveStore(s => s.connections)
  const memory = useLiveStore(s => s.memory)
  const status = useLiveStore(s => s.status)
  const [revision, setRevision] = useState(0)
  // 每次写操作和跨窗口事件使旧查询失效，迟到的配置/节点快照不能覆盖新选择。
  const query = useCallback(loadSnapshot, [revision])
  const { data, error, loading } = usePollingQuery<TraySnapshot | null>(query, null, 5000)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const busyRef = useRef(false)
  const alive = useRef(true)
  const reload = useCallback(() => setRevision(value => value + 1), [])

  useEffect(watchSystemTheme, [])
  useEffect(() => {
    if (loaded && core.running) return startLiveStreams(['traffic', 'connections', 'memory'])
  }, [loaded, core.running])
  useEffect(() => {
    alive.current = true
    const stops: (() => void)[] = []
    let disposed = false
    if (!isMock) {
      void import('@tauri-apps/api/event').then(async ({ listen }) => {
        for (const event of ['settings-changed', 'profiles-changed']) {
          const stop = await listen(event, reload)
          if (disposed) stop()
          else stops.push(stop)
        }
      }).catch(() => { if (!disposed) setActionError('快捷面板同步失败') })
    }
    return () => {
      alive.current = false
      disposed = true
      stops.forEach(stop => stop())
    }
  }, [reload])

  useEffect(() => {
    if (!settings.customCss) return
    const style = document.createElement('style')
    style.textContent = settings.customCss
    document.head.appendChild(style)
    return () => style.remove()
  }, [settings.customCss])

  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setActionError('')
    try { await operation() }
    catch (reason) { if (alive.current) setActionError(String(reason)) }
    finally {
      busyRef.current = false
      if (alive.current) { setBusy(false); reload() }
    }
  }

  const disabled = !loaded || busy
  const mode = runtimeMode ?? settings.mode
  const current = data?.profiles.find(profile => profile.current)
  const quota = current?.quota
  const percentage = quota && quota.total > 0 ? Math.min(100, Math.max(0, quota.used / quota.total * 100)) : null
  const groups = Object.values(data?.proxies?.proxies ?? {})
    .filter(group => Array.isArray(group.all) && (group.name !== 'GLOBAL' || mode === 'global'))
  const latest = traffic[traffic.length - 1]
  const speed = (direction: 'up' | 'down'): string => !core.running ? fmtSpeed(0)
    : status.traffic === 'connected' ? fmtSpeed(latest?.[direction] ?? 0) : '—'
  const openWebUi = async (): Promise<void> => {
    const controller = useAppStore.getState().settings.externalController.trim()
    const base = /^https?:\/\//i.test(controller) ? controller.replace(/\/+$/, '') : 'http://' + controller
    await call('open_url', { url: base + '/ui/' })
  }

  return <section className="tray-panel" aria-label={t('快捷面板')} aria-busy={busy}>
    <header className="tray-header">
      <img src="/logo-brand.png" alt="" width="24" height="24" />
      <strong>ClashNova</strong>
      <span className={'tray-state ' + (loaded && core.running ? 'running' : '')}>
        <i />{!loaded ? t('加载中…') : core.running ? t('运行中') : t('已停止')}
      </span>
      <button type="button" className="icon-btn" aria-label={t('关闭快捷面板')} onClick={onClose}><Icon name="x" /></button>
    </header>

    <div className="tray-scroll">
      {(actionError || error || data?.proxyError) && <div className="tray-error" role="alert">
        {t(actionError || error || data?.proxyError || '')}
      </div>}
      <section className="tray-rates" aria-label={t('实时流量')}>
        <div className="tray-plots">
          <div><span>{t('下载')}</span><b className="num">{speed('down')}</b>
            <Spark pts={core.running ? traffic.map(point => point.down) : []} color="var(--accent)" h={44} fill />
          </div>
          <div><span>{t('上传')}</span><b className="num">{speed('up')}</b>
            <Spark pts={core.running ? traffic.map(point => point.up) : []} color="var(--purple)" h={44} fill />
          </div>
        </div>
        <div className="tray-metrics">
          <span>{t('连接')} <b className="num">{core.running && status.connections !== 'connected' ? '—' : core.running ? connections.connections.length : 0}</b></span>
          <span><span>{t('内核内存')}</span> <b className="num">{core.running && status.memory !== 'connected' ? '—' : fmtBytes(core.running ? memory.inuse : 0)}</b></span>
        </div>
      </section>

      <div className="tray-controls">
        <div className="tray-row"><span>{t('系统代理')}</span>
          <Toggle label={t('系统代理')} on={settings.sysProxy} disabled={disabled}
            onChange={enable => { void run(() => useAppStore.getState().patchSettings({ sysProxy: enable })) }} />
        </div>
        <div className="tray-row"><span>{t('TUN 模式')}</span>
          <Toggle label={t('TUN 模式')} on={settings.tun} disabled={disabled}
            onChange={enable => { void run(() => useAppStore.getState().setTun(enable)) }} />
        </div>
        <div className="tray-mode"><span>{t('出站模式')}</span>
          <Seg<OutboundMode> label={t('出站模式')} value={mode} disabled={disabled}
            items={[{ value: 'direct', label: t('直连') }, { value: 'rule', label: t('规则') }, { value: 'global', label: t('全局') }]}
            onChange={value => { void run(() => useAppStore.getState().setMode(value)) }} />
        </div>
      </div>

      <div className="tray-section-title"><span>{t('策略组')}</span>
        <button type="button" className="icon-btn" aria-label={t('刷新')} disabled={disabled || loading} onClick={reload}><Icon name="refresh" size={13} /></button>
      </div>
      {!core.running && loaded ? <p className="tray-empty">{t('内核未运行，启动后可切换策略组')}</p>
        : !data ? <p className="tray-empty">{t('加载中…')}</p>
          : groups.length === 0 && !data.proxyError ? <p className="tray-empty">{t('暂无策略组')}</p>
            : groups.map(group => <label className="tray-group" key={group.name} data-type={group.type}>
              <span title={group.name}><b>{group.name}</b><small>{group.type}</small></span>
              <select aria-label={t('策略组') + ' ' + group.name} value={group.now ?? ''}
                disabled={disabled || !['Selector', 'URLTest'].includes(group.type)}
                onChange={event => {
                  const name = event.target.value
                  void run(async () => {
                    await selectProxy(group.name, name)
                    if (settings.autoCloseConnections && group.now !== name) void closeGroupConnections(group.name)
                  })
                }}>
                {!group.all!.includes(group.now ?? '') && <option value={group.now ?? ''}>{group.now || t('自动选择')}</option>}
                {group.all!.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>)}

      {data && <div className="tray-profile">
        <label className="tray-row"><span>{t('切换配置')}</span>
          <select aria-label={t('切换配置')} value={current?.id ?? ''} disabled={disabled || data.profiles.length === 0}
            onChange={event => { const id = event.target.value; void run(() => call('select_profile', { id })) }}>
            {!current && <option value="" disabled>{t('未选择配置')}</option>}
            {data.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>
        {quota && <div className="tray-quota">
          <div><span className="num">{fmtBytes(quota.used)} / {quota.total > 0 ? fmtBytes(quota.total) : t('总量未知')}</span>
            {quota.expireAt !== undefined && <span>{quota.expireAt <= Date.now() ? t('已过期') : t('剩余天数') + ' ' + daysLeft(quota.expireAt)}</span>}
          </div>
          {percentage !== null && <div className={'tray-quota-bar ' + (percentage >= 90 ? 'warning' : '')} role="progressbar"
            aria-label={t('订阅用量')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percentage)}>
            <i style={{ width: percentage + '%' }} />
          </div>}
        </div>}
      </div>}
    </div>

    <footer className="tray-footer">
      <div>
        <Button size="sm" disabled={disabled} onClick={() => { void run(() => core.running ? useAppStore.getState().stopCore() : useAppStore.getState().startCore()) }}>
          {busy ? t('处理中…') : core.running ? t('停止内核') : t('启动内核')}
        </Button>
        <Button size="sm" variant="primary" onClick={() => { void run(() => call('tray_open_main')) }} disabled={busy}>{t('打开主窗口')}</Button>
      </div>
      <div>
        <button type="button" disabled={disabled || !core.running} onClick={() => { void run(openWebUi) }}>Web Dashboard</button>
        <button type="button" className="tray-quit" disabled={busy} onClick={() => { void run(() => call('tray_quit_app')) }}>{t('退出 ClashNova')}</button>
      </div>
    </footer>
  </section>
}
