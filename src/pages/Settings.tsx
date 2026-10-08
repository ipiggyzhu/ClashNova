import { useEffect, useRef, useState } from 'react'
import './Settings.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import CodeEditor from '../components/ui/LazyCodeEditor'
import Dialog from '../components/ui/Dialog'
import DnsSettings from '../components/DnsSettings'
import HotkeyInput from '../components/HotkeyInput'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Seg from '../components/ui/Seg'
import Toggle from '../components/ui/Toggle'
import { useT } from '../i18n'
import { updateGeo } from '../services/api'
import { call } from '../services/ipc'
import { useAppStore } from '../stores/app'
import { useNotificationStore } from '../stores/notifications'
import type { AppSettings, Language, Theme, TunAdapterStatus } from '../types/clash'

interface RowProps {
  title: string
  desc?: string
  children: React.ReactNode
}

function Row({ title, desc, children }: RowProps) {
  return (
    <div className="set-row">
      <div className="set-info">
        <h4>{title}</h4>
        {desc && <p>{desc}</p>}
      </div>
      {children}
    </div>
  )
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

/** 热键动作(键名与 Rust 侧约定一致) */
const HOTKEY_ACTIONS = [
  { action: 'show-window', label: '显示 / 隐藏主窗口' },
  { action: 'toggle-sysproxy', label: '切换系统代理' },
  { action: 'toggle-tun', label: '切换 TUN 模式' },
  { action: 'cycle-mode', label: '出站模式轮换' },
]

/** 文本编辑抽屉(自定义 CSS / DNS 覆写 / 代理绕过) */
interface DrawerState {
  title: string
  key: 'customCss' | 'dnsOverride' | 'bypass'
  content: string
  mono: boolean
  help?: string
}

type ServiceUiStatus = 'running' | 'stopped' | 'repair' | 'not-installed' | 'unknown'

export default function Settings() {
  const t = useT()
  const settings = useAppStore((s) => s.settings)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const setTun = useAppStore((s) => s.setTun)
  const loadAll = useAppStore((s) => s.loadAll)
  const core = useAppStore((s) => s.coreStatus)
  const restartCore = useAppStore((s) => s.restartCore)
  const updateAvailable = useAppStore((s) => s.updateAvailable)
  const checkUpdate = useAppStore((s) => s.checkUpdate)
  const notify = useNotificationStore((s) => s.add)

  /* 输入框本地草稿(失焦提交) */
  const [draft, setDraft] = useState<Partial<Record<keyof AppSettings, string>>>({})
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [drawerError, setDrawerError] = useState('')
  const [service, setService] = useState<ServiceUiStatus>('unknown')
  const [serviceError, setServiceError] = useState('')
  const [tunAdapter, setTunAdapter] = useState<TunAdapterStatus | null>(null)
  const [tunAdapterError, setTunAdapterError] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const busyRef = useRef<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [showDnsSettings, setShowDnsSettings] = useState(false)
  const draftRef = useRef(draft)
  const draftSaveRef = useRef<Promise<boolean> | null>(null)
  const settingsRef = useRef(settings)
  const patchSettingsRef = useRef(patchSettings)
  const notifyRef = useRef(notify)
  const tRef = useRef(t)
  const coreVersionLabel = core.running
    ? core.version === '—'
      ? t('获取中…')
      : core.version
    : t('未运行')

  // 映射后端状态到前端显示状态
  const mapServiceStatus = (status: string): ServiceUiStatus => {
    if (status === 'ready') {
      return 'running'
    } else if (status === 'not-installed') {
      return 'not-installed'
    } else if (
      status === 'needs-reinstall' ||
      status === 'reinstall-required' ||
      status === 'force-reinstall-required'
    ) {
      return 'repair'
    } else if (status.startsWith('unavailable:') || status === 'uninstall-required') {
      return 'stopped'
    } else {
      return 'unknown'
    }
  }

  const refreshServiceStatus = async (): Promise<void> => {
    try {
      const status = await call('service_status')
      setService(mapServiceStatus(status))
      setServiceError('')
    } catch (err) {
      setService('unknown')
      setServiceError(errorMessage(err))
      throw err
    }
  }

  const refreshTunAdapter = async (): Promise<void> => {
    try {
      setTunAdapter(await call('check_tun_adapter'))
      setTunAdapterError('')
    } catch (err) {
      setTunAdapter(null)
      setTunAdapterError(errorMessage(err))
    }
  }

  useEffect(() => {
    void refreshServiceStatus().catch(() => setService('unknown'))
    void refreshTunAdapter()
  }, [])

  useEffect(() => setDrawerError(''), [drawer?.key])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    patchSettingsRef.current = patchSettings
    notifyRef.current = notify
    tRef.current = t
  }, [notify, patchSettings, t])

  const clearDraftKeys = (keys: (keyof AppSettings)[]): void => {
    const next = { ...draftRef.current }
    for (const key of keys) delete next[key]
    draftRef.current = next
    setDraft(next)
  }

  const editDraft = (key: keyof AppSettings, value: string): void => {
    draftRef.current = { ...draftRef.current, [key]: value }
    setDraft(draftRef.current)
  }

  const flushDraft = (): Promise<boolean> => {
    if (draftSaveRef.current) return draftSaveRef.current.then((saved) => saved ? flushDraft() : false)
    const currentDraft = draftRef.current
    const currentSettings = settingsRef.current
    const patch: Partial<AppSettings> = {}
    const keys: (keyof AppSettings)[] = []
    let validationError = ''

    const commitNumberDraft = (key: 'mixedPort' | 'guardIntervalSec'): void => {
      const raw = currentDraft[key]
      if (raw === undefined) return
      keys.push(key)
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        validationError = tRef.current('端口和守卫间隔需要是 1-65535 的整数')
      } else if (n !== currentSettings[key]) patch[key] = n
    }

    const commitTextDraft = (key: 'externalController' | 'secret' | 'bypass'): void => {
      const raw = currentDraft[key]
      if (raw === undefined) return
      keys.push(key)
      const value = raw.trim()
      if (!value && key === 'externalController') {
        validationError = tRef.current('外部控制地址不能为空')
        return
      }
      if (value !== currentSettings[key]) patch[key] = value
    }

    commitNumberDraft('mixedPort')
    commitNumberDraft('guardIntervalSec')
    commitTextDraft('externalController')
    commitTextDraft('secret')
    commitTextDraft('bypass')

    if (validationError) {
      notifyRef.current('warning', tRef.current('设置未保存'), validationError)
      return Promise.resolve(false)
    }
    if (keys.length) clearDraftKeys(keys)
    if (!Object.keys(patch).length) return Promise.resolve(true)

    const operation = patchSettingsRef.current(patch).then(() => true).catch((err: unknown) => {
      const restored = { ...draftRef.current }
      for (const key of keys) {
        if (restored[key] === undefined) restored[key] = currentDraft[key]
      }
      draftRef.current = restored
      setDraft(restored)
      notifyRef.current('error', tRef.current('保存设置失败'), errorMessage(err))
      return false
    })
    draftSaveRef.current = operation
    void operation.then(() => {
      if (draftSaveRef.current === operation) draftSaveRef.current = null
    })
    return operation
  }

  useEffect(() => () => {
    void flushDraft()
  }, [])

  const patch = (p: Partial<AppSettings>): void => {
    void (async () => {
      await flushDraft()
      await patchSettings(p)
    })().catch((err) => {
      notify('error', t('保存设置失败'), errorMessage(err))
    })
  }

  const draftValue = (key: keyof AppSettings, fallback: string): string =>
    (draft[key] as string | undefined) ?? fallback

  const commitNumber = (_key: 'mixedPort' | 'guardIntervalSec'): void => {
    void flushDraft()
  }

  const commitText = (_key: 'externalController' | 'secret' | 'bypass'): void => {
    void flushDraft()
  }

  const commitTextOnEnter = (
    e: React.KeyboardEvent<HTMLInputElement>,
    _key: 'externalController' | 'secret' | 'bypass',
  ): void => {
    if (e.key !== 'Enter') return
    e.currentTarget.blur()
  }

  const withBusy = async (key: string, fn: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = key
    setBusy(key)
    try {
      if (!await flushDraft()) return
      await fn()
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }

  const serviceCommand = (): 'install_service' | 'start_service' | 'uninstall_service' | 'repair_service' => {
    if (service === 'running') return 'uninstall_service'
    if (service === 'repair') return 'repair_service'
    if (service === 'stopped') return 'start_service'
    return 'install_service'
  }

  const serviceButtonLabel = (): string => {
    if (service === 'running') return t('卸载')
    if (service === 'repair') return t('修复')
    if (service === 'stopped') return t('启动')
    return t('安装')
  }

  const toggleService = (): void => {
    void withBusy('service', async () => {
      await call(serviceCommand())
      await refreshServiceStatus()
      await refreshTunAdapter()
      await loadAll()
    }).catch((err) => {
      notify('error', t('服务模式操作失败'), errorMessage(err))
    })
  }

  const toggleTun = (on: boolean): void => {
    void withBusy('tun', async () => {
      await setTun(on)
      await refreshServiceStatus()
      await refreshTunAdapter()
    }).catch((err) => {
      notify('error', t('TUN 切换失败'), errorMessage(err))
    })
  }

  const handleRestartCore = (): void => {
    void withBusy('core', async () => {
      await restartCore()
      await refreshServiceStatus()
    }).catch((err) => {
      notify('error', t('重启内核失败'), errorMessage(err))
      void refreshServiceStatus().catch(() => setService('unknown'))
    })
  }

  const handleCheckUpdate = (): void => {
    void withBusy('update', checkUpdate).catch((err) => {
      notify('error', t('检查更新失败'), errorMessage(err))
    })
  }

  const downloadUpdate = (): void => {
    void call('open_url', {
      url: `https://github.com/ipiggyzhu/ClashNova/releases/tag/v${updateAvailable}`,
    }).catch((err) => notify('error', t('打开链接失败'), errorMessage(err)))
  }

  const doReset = (): void => {
    void withBusy('reset', async () => {
      await call('reset_settings')
      await loadAll()
      setConfirmReset(false)
    }).catch((err) => notify('error', t('恢复默认设置失败'), errorMessage(err)))
  }

  const openWebUi = (): void => {
    void withBusy('web-ui', async () => {
      const controller = useAppStore.getState().settings.externalController.trim()
      const base = /^https?:\/\//i.test(controller)
        ? controller.replace(/\/+$/, '')
        : `http://${controller.replace(/\/+$/, '')}`
      await call('open_url', { url: `${base}/ui/` })
    }).catch((err) => notify('error', t('打开链接失败'), errorMessage(err)))
  }

  const saveDrawer = (): void => {
    if (!drawer || busyRef.current) return
    const currentDrawer = drawer
    setDrawerError('')
    const key = drawer.key
    const content =
      key === 'bypass'
        ? drawer.content
            .split(/[\n,;]+/)
            .map((item) => item.trim())
            .filter(Boolean)
            .join(';')
        : drawer.content
    const current = String(settings[key] ?? '')
    if (content === current) {
      setDrawer(null)
      return
    }
    void withBusy(`drawer-${key}`, async () => {
      await patchSettings({ [key]: content } as Partial<AppSettings>)
      setDrawer((current) => current === currentDrawer ? null : current)
    }).catch((err) => {
      setDrawerError(errorMessage(err))
      notify('error', t('保存设置失败'), errorMessage(err))
    })
  }

  const enabledBadge = (v: string | boolean): JSX.Element => {
    const enabled = typeof v === 'boolean' ? v : v.trim().length > 0
    return enabled ? <Badge tone="green">{t('已启用')}</Badge> : <Badge tone="gray">{t('未启用')}</Badge>
  }

  const tunAdapterBadge = (): JSX.Element => {
    if (!settings.tun) return <Badge tone="gray">{t('未启用')}</Badge>
    if (tunAdapterError) return <Badge tone="red">{t('检测失败')}</Badge>
    if (!tunAdapter) return <Badge tone="gray">{t('检测中…')}</Badge>
    if (tunAdapter.status === 'unsupported') return <Badge tone="blue">{t('检测不支持')}</Badge>
    if (tunAdapter.status === 'runtime-enabled') return <Badge tone="green">TUN 已接管</Badge>
    if (tunAdapter.adapterPresent) {
      return <Badge tone="green">{tunAdapter.adapterName ?? t('网卡就绪')}</Badge>
    }
    return <Badge tone="orange">{t('网卡未就绪')}</Badge>
  }

  return (
    <div className="pg-settings">
      <div className="col">
        {/* ---- 系统 ---- */}
        <Card icon={<Icon name="settings" />} iconColor="var(--accent)" title={t('系统')} flush>
          <Row title={t('系统代理')} desc={t('修改 Windows Internet 设置, 流量经由混合端口')}>
            <Toggle label={t('系统代理')} on={settings.sysProxy} onChange={(on) => patch({ sysProxy: on })} />
          </Row>
          <Row title={t('守卫模式')} desc={`每 ${settings.guardIntervalSec}s 检查并恢复系统代理`}>
            <Input
              aria-label={t('守卫检查间隔（秒）')}
              className="num"
              style={{ width: 64 }}
              value={draftValue('guardIntervalSec', String(settings.guardIntervalSec))}
              onChange={(e) => editDraft('guardIntervalSec', e.target.value)}
              onBlur={() => commitNumber('guardIntervalSec')}
            />
            <Toggle label={t('守卫模式')} on={settings.guard} onChange={(on) => patch({ guard: on })} />
          </Row>
          <Row title={t('代理绕过')} desc={settings.bypass}>
            <Button
              size="sm"
              onClick={() =>
                setDrawer({
                  title: '代理绕过编辑',
                  key: 'bypass',
                  content: settings.bypass,
                  mono: true,
                  help: '这些地址会跳过系统代理，直接连接。常用写法: localhost、127.*、192.168.*、10.*、172.16.*、<local>。多个项目可用分号或换行分隔。',
                })
              }
            >
              {t('编辑')}
            </Button>
          </Row>
          <Row title={t('TUN 模式')} desc={t('虚拟网卡接管全部流量, 需服务模式')}>
            <span title={tunAdapterError || tunAdapter?.detail || undefined}>{tunAdapterBadge()}</span>
            <Toggle label={t('TUN 模式')} on={settings.tun} onChange={toggleTun} disabled={busy !== null} />
          </Row>
          <Row title={t('服务模式')} desc={t('以 Windows 服务运行内核, TUN 免管理员')}>
            {service === 'running' ? (
              <Badge tone="green">{t('运行中')}</Badge>
            ) : service === 'stopped' ? (
              <Badge tone="yellow">{t('已停止')}</Badge>
            ) : service === 'repair' ? (
              <Badge tone="orange">{t('需修复')}</Badge>
            ) : service === 'not-installed' ? (
              <Badge tone="gray">{t('未安装')}</Badge>
            ) : (
              <span title={serviceError || undefined}><Badge tone={serviceError ? 'red' : 'gray'}>{serviceError ? t('查询失败') : '—'}</Badge></span>
            )}
            <Button size="sm" onClick={toggleService} disabled={busy !== null || service === 'unknown'}>
              {busy === 'service' ? t('处理中…') : serviceButtonLabel()}
            </Button>
          </Row>
          <Row title={t('开机自启')} desc={t('登录 Windows 时自动启动')}>
            <Toggle label={t('开机自启')} on={settings.autostart} onChange={(on) => patch({ autostart: on })} />
          </Row>
          <Row title={t('静默启动')} desc={t('启动时仅驻留托盘, 不显示主窗口')}>
            <Toggle label={t('静默启动')} on={settings.silentStart} onChange={(on) => patch({ silentStart: on })} />
          </Row>
        </Card>

        {/* ---- 界面 ---- */}
        <Card icon={<Icon name="sun" />} iconColor="var(--purple)" title={t('界面')} flush>
          <Row title={t('主题')}>
            <Seg<Theme>
              label={t('主题')}
              items={[
                { value: 'dark', label: t('深色') },
                { value: 'light', label: t('浅色') },
                { value: 'system', label: t('跟随系统') },
              ]}
              value={settings.theme}
              onChange={(v) => patch({ theme: v })}
            />
          </Row>
          <Row title={t('语言')}>
            <Seg<Language>
              label={t('语言')}
              items={[
                { value: 'zh', label: '中文' },
                { value: 'en', label: 'English' },
              ]}
              value={settings.language ?? 'zh'}
              onChange={(v) => patch({ language: v })}
            />
          </Row>
          <Row title={t('自定义 CSS')} desc={t('注入自定义样式覆盖主题')}>
            {enabledBadge(settings.customCss ?? '')}
            <Button
              size="sm"
              onClick={() =>
                setDrawer({
                  title: t('自定义 CSS 编辑(留空关闭)'),
                  key: 'customCss',
                  content: settings.customCss ?? '',
                  mono: true,
                })
              }
            >
              {t('编辑')}
            </Button>
          </Row>
        </Card>

        <Card icon={<Icon name="traffic" />} title={t('流量统计')} flush>
          <Row title={t('历史数据保留')} desc={t('默认无限保留；设置期限后，更早的统计记录将被清理')}>
            <select
              aria-label={t('历史数据保留')}
              value={settings.statsRetentionDays ?? 0}
              onChange={(event) => {
                const days = Number(event.target.value)
                if (days > 0 && !window.confirm(t(`启用后将清理 ${days} 天以前的统计记录，是否继续？`))) return
                patch({ statsRetentionDays: days })
              }}
            >
              <option value={0}>{t('无限保留')}</option>
              <option value={30}>30 {t('天')}</option>
              <option value={90}>90 {t('天')}</option>
              <option value={365}>365 {t('天')}</option>
            </select>
          </Row>
        </Card>

        {/* ---- 关于 ---- */}
        <Card icon={<Icon name="check" />} iconColor="var(--green)" title={t('关于')} flush>
          <Row title="ClashNova">
            <div className="about-ver">
              <span className="v">v{__APP_VERSION__}</span>
              {updateAvailable && updateAvailable !== 'error' && (
                <Badge tone="orange">v{updateAvailable} 可用</Badge>
              )}
              {updateAvailable === null && <Badge tone="green">{t('已是最新')}</Badge>}
              {updateAvailable === 'error' && <Badge tone="red">{t('检查失败')}</Badge>}
              {updateAvailable && updateAvailable !== 'error' && (
                <Button size="sm" onClick={downloadUpdate}>
                  <Icon name="download" size={13} />
                  {t('下载更新')}
                </Button>
              )}
              <Button size="sm" variant="primary" onClick={handleCheckUpdate} disabled={busy !== null}>
                {busy === 'update' ? t('检查中…') : t('检查更新')}
              </Button>
            </div>
          </Row>
          <Row title={t('开源协议')} desc="MIT License">
            <button
              type="button"
              className="link"
              onClick={() => void call('open_url', { url: 'https://github.com/ipiggyzhu/ClashNova' })
                .catch((err) => notify('error', t('打开链接失败'), errorMessage(err)))}
            >
              {t('GitHub 仓库')}
            </button>
          </Row>
          <Row title={t('目录')}>
            <div className="dir-btns">
              <Button size="sm" onClick={() => void call('open_app_dir', { kind: 'config' })
                .catch((err) => notify('error', t('打开配置目录失败'), errorMessage(err)))}>
                {t('配置目录')}
              </Button>
              <Button size="sm" onClick={() => void call('open_app_dir', { kind: 'logs' })
                .catch((err) => notify('error', t('打开日志目录失败'), errorMessage(err)))}>
                {t('日志目录')}
              </Button>
            </div>
          </Row>
          <Row title={t('重置')} desc={t('恢复全部设置为默认值')}>
            {confirmReset ? (
              <>
                <Button size="sm" variant="danger" onClick={doReset} disabled={busy !== null}>{t('确认')}</Button>
                <Button size="sm" onClick={() => setConfirmReset(false)} disabled={busy === 'reset'}>{t('取消')}</Button>
              </>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setConfirmReset(true)}>
                {t('恢复默认设置')}
              </Button>
            )}
          </Row>
        </Card>
      </div>

      <div className="col">
        {/* ---- Clash 内核 ---- */}
        <Card
          icon={<Icon name="cpu" />}
          iconColor="var(--cyan)"
          title={t('Clash 内核')}
          actions={<span className="chip">mihomo {coreVersionLabel}</span>}
          flush
        >
          <Row title={t('混合端口')} desc={t('HTTP + SOCKS5 共用端口')}>
            <Input
              aria-label={t('混合端口')}
              className="num"
              style={{ width: 90 }}
              value={draftValue('mixedPort', String(settings.mixedPort))}
              onChange={(e) => editDraft('mixedPort', e.target.value)}
              onBlur={() => commitNumber('mixedPort')}
            />
          </Row>
          <Row title={t('外部控制')} desc={t('RESTful API 监听地址')}>
            <Input
              aria-label={t('外部控制')}
              className="num"
              style={{ width: 150 }}
              value={draftValue('externalController', settings.externalController)}
              onChange={(e) => editDraft('externalController', e.target.value)}
              onKeyDown={(e) => commitTextOnEnter(e, 'externalController')}
              onBlur={() => commitText('externalController')}
            />
          </Row>
          <Row title={t('API 密钥')} desc={t('外部控制鉴权 secret')}>
            <div className="secret-control">
              <Input
                aria-label={t('API 密钥')}
                type={showSecret ? 'text' : 'password'}
                spellCheck={false}
                value={draftValue('secret', settings.secret)}
                onChange={(e) => editDraft('secret', e.target.value)}
                onKeyDown={(e) => commitTextOnEnter(e, 'secret')}
                onBlur={() => commitText('secret')}
              />
              <button
                type="button"
                className="secret-eye"
                title={showSecret ? t('隐藏') : t('显示')}
                aria-label={showSecret ? t('隐藏 API 密钥') : t('显示 API 密钥')}
                aria-pressed={showSecret}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setShowSecret((visible) => !visible)}
              >
                <Icon name={showSecret ? 'eye-off' : 'eye'} size={14} />
              </button>
            </div>
          </Row>
          <Row title={t('允许局域网')} desc={t('局域网设备可经本机代理')}>
            <Toggle label={t('允许局域网')} on={settings.allowLan} onChange={(on) => patch({ allowLan: on })} />
          </Row>
          <Row title="IPv6">
            <Toggle label="IPv6" on={settings.ipv6} onChange={(on) => patch({ ipv6: on })} />
          </Row>
          <Row title={t('日志等级')}>
            <select
              aria-label={t('日志等级')}
              className="select"
              value={settings.logLevel}
              onChange={(e) => patch({ logLevel: e.target.value as AppSettings['logLevel'] })}
            >
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warning">warning</option>
              <option value="error">error</option>
              <option value="silent">silent</option>
            </select>
          </Row>
          <Row title={t('DNS 覆写')} desc="完整 DNS YAML 配置；需要 nameserver、fallback、fake-ip 等高级项时使用">
            {enabledBadge(settings.enableDns)}
            <Button size="sm" onClick={() => setShowDnsSettings(true)}>
              <Icon name="zap" size={13} />
              {t('高级')}
            </Button>
            <Button
              size="sm"
              onClick={() =>
                setDrawer({
                  title: t('DNS 覆写编辑(YAML, 留空关闭)'),
                  key: 'dnsOverride',
                  content: settings.dnsOverride ?? '',
                  mono: true,
                })
              }
            >
              {t('编辑')}
            </Button>
          </Row>
          <Row title={t('内核版本')}>
            <span className="chip">{coreVersionLabel}</span>
            <Button size="sm" onClick={handleRestartCore} disabled={busy !== null}>
              {busy === 'core' ? t('重启中…') : t('重启内核')}
            </Button>
          </Row>
          <Row title="GeoData" desc="geoip / geosite">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void withBusy('geo', updateGeo)
                .catch((err) => notify('error', t('更新 GeoData 失败'), errorMessage(err)))}
            >
              {busy === 'geo' ? t('更新中…') : t('更新')}
            </Button>
          </Row>
          <Row title={t('UWP 回环豁免')} desc={t('解除商店应用回环限制')}>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void withBusy('uwp', () => call('exempt_uwp_loopback'))
                  .catch((err) => notify('error', t('UWP 回环豁免失败'), errorMessage(err)))
              }
            >
              {t('立即豁免')}
            </Button>
          </Row>
          <Row title={t('Web UI')} desc={t('Web UI 修改会立即影响 mihomo 运行态；ClashNova 仅跟随模式和代理选择，其他设置仍以本软件为准')}>
            <Button size="sm" onClick={openWebUi} disabled={busy !== null}>
              <Icon name="external" size={12} />{t('跳转面板')}
            </Button>
          </Row>
        </Card>

        {/* ---- 热键 ---- */}
        <Card icon={<Icon name="zap" />} iconColor="var(--orange)" title={t('热键')} flush>
          {HOTKEY_ACTIONS.map((h) => (
            <Row key={h.action} title={t(h.label)}>
              <HotkeyInput
                label={t(h.label)}
                value={settings.hotkeys?.[h.action] ?? ''}
                onCommit={(accel) => {
                  const next = { ...(settings.hotkeys ?? {}) }
                  if (accel) next[h.action] = accel
                  else delete next[h.action]
                  patch({ hotkeys: next })
                }}
              />
            </Row>
          ))}
        </Card>
      </div>

      {/* ---- 文本编辑抽屉 ---- */}
      {drawer && (
        <Dialog className="set-mask" panelClassName="set-drawer" title={drawer.title}
          onClose={() => setDrawer(null)} dismissible={busy === null}>
            <div className="dhead">
              <Icon name="edit" size={14} />
              {drawer.title}
              <span className="spacer" />
              <button type="button" className="icon-btn" aria-label={t('关闭')} onClick={() => setDrawer(null)} disabled={busy !== null}>
                <Icon name="x" />
              </button>
            </div>
            {drawer.help && <div className="drawer-help">{drawer.help}</div>}
            {drawerError && <div className="drawer-error" role="alert">{drawerError}</div>}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <CodeEditor
                label={drawer.title}
                value={drawer.content}
                onChange={(content) => setDrawer({ ...drawer, content })}
                lang={drawer.key === 'dnsOverride' ? 'yaml' : drawer.key === 'customCss' ? 'css' : 'text'}
                readOnly={busy !== null}
              />
            </div>
            <div className="dfoot">
              <Button onClick={() => setDrawer(null)} disabled={busy !== null}>{t('取消')}</Button>
              <Button variant="primary" onClick={saveDrawer} disabled={busy !== null}>
                <Icon name="check" size={13} />{busy === `drawer-${drawer.key}` ? t('保存中...') : t('保存')}
              </Button>
            </div>
        </Dialog>
      )}

      {/* ---- DNS 高级配置 ---- */}
      {showDnsSettings && <DnsSettings onClose={() => setShowDnsSettings(false)} />}
    </div>
  )
}
