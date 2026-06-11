import { useEffect, useState } from 'react'
import './Settings.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Seg from '../components/ui/Seg'
import Toggle from '../components/ui/Toggle'
import { useT } from '../i18n'
import { updateGeo } from '../services/api'
import { call } from '../services/ipc'
import { useAppStore } from '../stores/app'
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

/** 文本编辑抽屉(自定义 CSS / DNS 覆写 / hosts) */
interface DrawerState {
  title: string
  key: 'customCss' | 'dnsOverride' | 'hosts'
  content: string
  mono: boolean
}

export default function Settings() {
  const t = useT()
  const settings = useAppStore((s) => s.settings)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const loadAll = useAppStore((s) => s.loadAll)
  const core = useAppStore((s) => s.coreStatus)
  const restartCore = useAppStore((s) => s.restartCore)

  /* 输入框本地草稿(失焦提交) */
  const [draft, setDraft] = useState<Partial<Record<keyof AppSettings, string>>>({})
  const [coreChannel, setCoreChannel] = useState('stable')
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [service, setService] = useState<'installed' | 'not-installed' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    void call('service_status')
      .then(setService)
      .catch(() => setService(null))
  }, [])

  const patch = (p: Partial<AppSettings>): void => {
    void patchSettings(p).catch(() => {})
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

  const toggleService = (): void => {
    const installing = service !== 'installed'
    void withBusy('service', async () => {
      await call(installing ? 'install_service' : 'uninstall_service')
      setService(await call('service_status'))
    }).catch(() => {})
  }

  const checkUpdate = (): void => {
    void withBusy('update', async () => {
      const ver = await call('check_update')
      setUpdateMsg(ver ? `v${ver}` : t('已是最新'))
    }).catch(() => setUpdateMsg(null))
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
    patch({ [drawer.key]: drawer.content } as Partial<AppSettings>)
    setDrawer(null)
  }

  const enabledBadge = (v: string): JSX.Element =>
    v.trim() ? <Badge tone="green">{t('已启用')}</Badge> : <Badge tone="gray">{t('未启用')}</Badge>

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
            <Input
              style={{ width: 180 }}
              value={draftValue('bypass', settings.bypass)}
              onChange={(e) => setDraft((d) => ({ ...d, bypass: e.target.value }))}
              onBlur={() => commitText('bypass')}
            />
          </Row>
          <Row title={t('TUN 模式')} desc={t('虚拟网卡接管全部流量, 需服务模式')}>
            <Toggle on={settings.tun} onChange={(on) => patch({ tun: on })} />
          </Row>
          <Row title={t('服务模式')} desc={t('以 Windows 服务运行内核, TUN 免管理员')}>
            {service === 'installed' ? (
              <Badge tone="green">{t('已安装')}</Badge>
            ) : (
              <Badge tone="gray">{t('未安装')}</Badge>
            )}
            <Button size="sm" onClick={toggleService} disabled={busy === 'service' || service === null}>
              {service === 'installed' ? t('卸载') : t('安装')}
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
              <span className="v">v2.0.0</span>
              {updateMsg && <Badge tone="blue">{updateMsg}</Badge>}
              <Button size="sm" variant="primary" onClick={checkUpdate} disabled={busy === 'update'}>
                {busy === 'update' ? t('检查中…') : t('检查更新')}
              </Button>
            </div>
          </Row>
          <Row title={t('开源协议')} desc="MIT License">
            <span
              className="link"
              onClick={() => void call('open_url', { url: 'https://github.com' }).catch(() => {})}
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
          actions={<span className="chip">mihomo {core.version}</span>}
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
          <Row title={t('DNS 覆写')}>
            {enabledBadge(settings.dnsOverride ?? '')}
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
          <Row title={t('hosts 覆写')}>
            {enabledBadge(settings.hosts ?? '')}
            <Button
              size="sm"
              onClick={() =>
                setDrawer({
                  title: t('hosts 覆写编辑(每行: 域名 IP)'),
                  key: 'hosts',
                  content: settings.hosts ?? '',
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
            <Button size="sm" onClick={() => void restartCore()}>{t('重启内核')}</Button>
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
            <textarea
              className={drawer.mono ? 'mono' : ''}
              value={drawer.content}
              onChange={(e) => setDrawer({ ...drawer, content: e.target.value })}
              spellCheck={false}
            />
            <div className="dfoot">
              <Button onClick={() => setDrawer(null)}>{t('取消')}</Button>
              <Button variant="primary" onClick={saveDrawer}>
                <Icon name="check" size={13} />{t('保存')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
