import { useEffect, useState } from 'react'
import './Settings.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import CodeEditor from '../components/ui/CodeEditor'
import DnsSettings from '../components/DnsSettings'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Seg from '../components/ui/Seg'
import Toggle from '../components/ui/Toggle'
import { useT } from '../i18n'
import { updateGeo } from '../services/api'
import { call } from '../services/ipc'
import { useAppStore } from '../stores/app'
import { useNotificationStore } from '../stores/notifications'
import type { AppSettings, Language, Theme } from '../types/clash'

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

/** 录制一次组合键: 修饰键 + 主键 → "Ctrl+Shift+X" */
function HotkeyInput({
  value,
  onCommit,
}: {
  value: string
  onCommit: (accel: string) => void
}) {
  const t = useT()
  const [recording, setRecording] = useState(false)

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(false)
      return
    }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
    const parts: string[] = []
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.shiftKey) parts.push('Shift')
    if (e.altKey) parts.push('Alt')
    if (e.metaKey) parts.push('Super')
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
    parts.push(key)
    onCommit(parts.join('+'))
    setRecording(false)
  }

  return (
    <div className="hotkey-set">
      <button
        className={recording ? 'hotkey-btn rec' : 'hotkey-btn'}
        onClick={() => setRecording(true)}
        onKeyDown={onKeyDown}
        onBlur={() => setRecording(false)}
      >
        {recording ? (
          t('按下组合键')
        ) : value ? (
          <span className="kbd-group">
            {value.split('+').map((k) => (
              <span className="kbd" key={k}>{k}</span>
            ))}
          </span>
        ) : (
          t('点击录制')
        )}
      </button>
      {value && (
        <button className="hotkey-clear" title={t('清除')} onClick={() => onCommit('')}>
          <Icon name="x" size={11} />
        </button>
      )}
    </div>
  )
}

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
  const [coreChannel, setCoreChannel] = useState('stable')
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [service, setService] = useState<ServiceUiStatus>('unknown')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [showDnsSettings, setShowDnsSettings] = useState(false)
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
    const status = (await call('service_status')) as string
    setService(mapServiceStatus(status))
  }

  useEffect(() => {
    void refreshServiceStatus().catch(() => setService('unknown'))
  }, [])

  const patch = (p: Partial<AppSettings>): void => {
    void patchSettings(p).catch((err) => {
      notify('error', t('保存设置失败'), errorMessage(err))
    })
  }

  const draftValue = (key: keyof AppSettings, fallback: string): string =>
    (draft[key] as string | undefined) ?? fallback

  const commitNumber = (key: 'mixedPort' | 'guardIntervalSec'): void => {
    const raw = draft[key]
    if (raw === undefined) return
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0 && n < 65536) patch({ [key]: Math.round(n) })
    setDraft((d) => ({ ...d, [key]: undefined }))
  }

  const commitText = (key: 'externalController' | 'secret' | 'bypass'): void => {
    const raw = draft[key]
    if (raw === undefined) return
    if (raw.trim()) patch({ [key]: raw.trim() })
    setDraft((d) => ({ ...d, [key]: undefined }))
  }

  const withBusy = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key)
    try {
      await fn()
    } finally {
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
      await loadAll()
    }).catch((err) => {
      notify('error', t('服务模式操作失败'), errorMessage(err))
    })
  }

  const toggleTun = (on: boolean): void => {
    void withBusy('tun', async () => {
      await setTun(on)
      await refreshServiceStatus()
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
    void withBusy('update', checkUpdate).catch(() => {})
  }

  const downloadUpdate = (): void => {
    void call('open_url', {
      url: `https://github.com/ipiggyzhu/ClashNova/releases/tag/v${updateAvailable}`,
    }).catch(() => {})
  }

  const doReset = (): void => {
    setConfirmReset(false)
    void withBusy('reset', async () => {
      await call('reset_settings')
      await loadAll()
    }).catch(() => {})
  }

  const openWebUi = (): void => {
    void call('open_url', { url: `http://${settings.externalController}/ui/` }).catch(() => {})
  }

  const saveDrawer = (): void => {
    if (!drawer) return
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
    setDrawer(null)
    void withBusy(`drawer-${key}`, async () => {
      await patchSettings({ [key]: content } as Partial<AppSettings>)
    }).catch((err) => {
      notify('error', t('保存设置失败'), errorMessage(err))
    })
  }

  const enabledBadge = (v: string | boolean): JSX.Element => {
    const enabled = typeof v === 'boolean' ? v : v.trim().length > 0
    return enabled ? <Badge tone="green">{t('已启用')}</Badge> : <Badge tone="gray">{t('未启用')}</Badge>
  }

  return (
    <div className="pg-settings">
      <div className="col">
        {/* ---- 系统 ---- */}
        <Card icon={<Icon name="settings" />} iconColor="var(--accent)" title={t('系统')} flush>
          <Row title={t('系统代理')} desc={t('修改 Windows Internet 设置, 流量经由混合端口')}>
            <Toggle on={settings.sysProxy} onChange={(on) => patch({ sysProxy: on })} />
          </Row>
          <Row title={t('守卫模式')} desc={`${settings.guardIntervalSec}s`}>
            <Input
              className="num"
              style={{ width: 64 }}
              value={draftValue('guardIntervalSec', String(settings.guardIntervalSec))}
              onChange={(e) => setDraft((d) => ({ ...d, guardIntervalSec: e.target.value }))}
              onBlur={() => commitNumber('guardIntervalSec')}
            />
            <Toggle on={settings.guard} onChange={(on) => patch({ guard: on })} />
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
            <Toggle on={settings.tun} onChange={toggleTun} disabled={busy === 'tun'} />
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
              <Badge tone="gray">—</Badge>
            )}
            <Button size="sm" onClick={toggleService} disabled={busy === 'service' || service === 'unknown'}>
              {busy === 'service' ? t('处理中…') : serviceButtonLabel()}
            </Button>
          </Row>
          <Row title={t('开机自启')} desc={t('登录 Windows 时自动启动')}>
            <Toggle on={settings.autostart} onChange={(on) => patch({ autostart: on })} />
          </Row>
          <Row title={t('静默启动')} desc={t('启动时仅驻留托盘, 不显示主窗口')}>
            <Toggle on={settings.silentStart} onChange={(on) => patch({ silentStart: on })} />
          </Row>
        </Card>

        {/* ---- 界面 ---- */}
        <Card icon={<Icon name="sun" />} iconColor="var(--purple)" title={t('界面')} flush>
          <Row title={t('主题')}>
            <Seg<Theme>
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
              <Button size="sm" variant="primary" onClick={handleCheckUpdate} disabled={busy === 'update'}>
                {busy === 'update' ? t('检查中…') : t('检查更新')}
              </Button>
            </div>
          </Row>
          <Row title={t('开源协议')} desc="MIT License">
            <span
              className="link"
              onClick={() => void call('open_url', { url: 'https://github.com/ipiggyzhu/ClashNova' }).catch(() => {})}
            >
              {t('GitHub 仓库')}
            </span>
          </Row>
          <Row title={t('目录')}>
            <div className="dir-btns">
              <Button size="sm" onClick={() => void call('open_app_dir', { kind: 'config' })}>
                {t('配置目录')}
              </Button>
              <Button size="sm" onClick={() => void call('open_app_dir', { kind: 'logs' })}>
                {t('日志目录')}
              </Button>
            </div>
          </Row>
          <Row title={t('重置')} desc={t('恢复全部设置为默认值')}>
            {confirmReset ? (
              <>
                <Button size="sm" variant="danger" onClick={doReset}>{t('确认')}</Button>
                <Button size="sm" onClick={() => setConfirmReset(false)}>{t('取消')}</Button>
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
              className="num"
              style={{ width: 90 }}
              value={draftValue('mixedPort', String(settings.mixedPort))}
              onChange={(e) => setDraft((d) => ({ ...d, mixedPort: e.target.value }))}
              onBlur={() => commitNumber('mixedPort')}
            />
          </Row>
          <Row title={t('外部控制')} desc={t('RESTful API 监听地址')}>
            <Input
              className="num"
              style={{ width: 150 }}
              value={draftValue('externalController', settings.externalController)}
              onChange={(e) => setDraft((d) => ({ ...d, externalController: e.target.value }))}
              onBlur={() => commitText('externalController')}
            />
          </Row>
          <Row title={t('API 密钥')} desc={t('外部控制鉴权 secret')}>
            <Input
              type="password"
              style={{ width: 150 }}
              value={draftValue('secret', settings.secret)}
              onChange={(e) => setDraft((d) => ({ ...d, secret: e.target.value }))}
              onBlur={() => commitText('secret')}
            />
          </Row>
          <Row title={t('允许局域网')} desc={t('局域网设备可经本机代理')}>
            <Toggle on={settings.allowLan} onChange={(on) => patch({ allowLan: on })} />
          </Row>
          <Row title="IPv6">
            <Toggle on={settings.ipv6} onChange={(on) => patch({ ipv6: on })} />
          </Row>
          <Row title={t('日志等级')}>
            <select
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
            <Seg
              items={[
                { value: 'stable', label: 'Stable' },
                { value: 'alpha', label: 'Alpha' },
              ]}
              value={coreChannel}
              onChange={setCoreChannel}
            />
            <Button size="sm" onClick={handleRestartCore} disabled={busy === 'core'}>
              {busy === 'core' ? t('重启中…') : t('重启内核')}
            </Button>
          </Row>
          <Row title="GeoData" desc="geoip / geosite">
            <Button
              size="sm"
              disabled={busy === 'geo'}
              onClick={() => void withBusy('geo', updateGeo).catch(() => {})}
            >
              {busy === 'geo' ? t('更新中…') : t('更新')}
            </Button>
          </Row>
          <Row title={t('UWP 回环豁免')} desc={t('解除商店应用回环限制')}>
            <Button
              size="sm"
              disabled={busy === 'uwp'}
              onClick={() =>
                void withBusy('uwp', () => call('exempt_uwp_loopback')).catch(() => {})
              }
            >
              {t('立即豁免')}
            </Button>
          </Row>
          <Row title={t('Web UI')} desc={t('在浏览器中打开外部控制面板')}>
            <Button size="sm" onClick={openWebUi}>
              <Icon name="external" size={12} />{t('跳转面板')}
            </Button>
          </Row>
        </Card>

        {/* ---- 热键 ---- */}
        <Card icon={<Icon name="zap" />} iconColor="var(--orange)" title={t('热键')} flush>
          {HOTKEY_ACTIONS.map((h) => (
            <Row key={h.action} title={t(h.label)}>
              <HotkeyInput
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
        <div className="set-mask" onClick={() => setDrawer(null)}>
          <div className="set-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="dhead">
              <Icon name="edit" size={14} />
              {drawer.title}
              <span className="spacer" />
              <button className="icon-btn" onClick={() => setDrawer(null)}>
                <Icon name="x" />
              </button>
            </div>
            {drawer.help && <div className="drawer-help">{drawer.help}</div>}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <CodeEditor
                value={drawer.content}
                onChange={(content) => setDrawer({ ...drawer, content })}
                lang={drawer.key === 'dnsOverride' ? 'yaml' : 'css'}
              />
            </div>
            <div className="dfoot">
              <Button onClick={() => setDrawer(null)}>{t('取消')}</Button>
              <Button variant="primary" onClick={saveDrawer} disabled={busy === `drawer-${drawer.key}`}>
                <Icon name="check" size={13} />{busy === `drawer-${drawer.key}` ? t('保存中...') : t('保存')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ---- DNS 高级配置 ---- */}
      {showDnsSettings && <DnsSettings onClose={() => setShowDnsSettings(false)} />}
    </div>
  )
}
