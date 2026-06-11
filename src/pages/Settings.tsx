import { useState } from 'react'
import './Settings.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Seg from '../components/ui/Seg'
import Toggle from '../components/ui/Toggle'
import { call } from '../services/ipc'
import { useAppStore } from '../stores/app'
import type { AppSettings, Theme } from '../types/clash'

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

const HOTKEYS = [
  { name: '显示 / 隐藏主窗口', keys: ['Ctrl', 'Shift', 'D'] },
  { name: '切换系统代理', keys: ['Ctrl', 'Shift', 'P'] },
  { name: '切换 TUN 模式', keys: ['Ctrl', 'Shift', 'T'] },
  { name: '出站模式轮换', keys: ['Ctrl', 'Shift', 'M'] },
  { name: '暂停全部代理', keys: ['Ctrl', 'Shift', 'Z'] },
]

const SWATCHES = ['#0A84FF', '#BF5AF2', '#FF375F', '#FF9F0A', '#32D74B', '#64D2FF']

export default function Settings() {
  const settings = useAppStore((s) => s.settings)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const core = useAppStore((s) => s.coreStatus)
  const restartCore = useAppStore((s) => s.restartCore)

  /* 输入框本地草稿(失焦提交) */
  const [draft, setDraft] = useState<Partial<Record<keyof AppSettings, string>>>({})
  const [accent, setAccent] = useState(SWATCHES[0]!)
  const [coreChannel, setCoreChannel] = useState('stable')

  const patch = (p: Partial<AppSettings>): void => {
    void patchSettings(p).catch(() => {})
  }

  const draftValue = (key: keyof AppSettings, fallback: string): string =>
    draft[key] ?? fallback

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

  return (
    <div className="pg-settings">
      <div className="col">
        {/* ---- 系统 ---- */}
        <Card icon={<Icon name="settings" />} iconColor="var(--accent)" title="系统" flush>
          <Row title="系统代理" desc="修改 Windows Internet 设置, 流量经由混合端口">
            <Toggle on={settings.sysProxy} onChange={(on) => patch({ sysProxy: on })} />
          </Row>
          <Row title="守卫模式" desc={`每 ${settings.guardIntervalSec} 秒检查并恢复代理设置`}>
            <Input
              className="num"
              style={{ width: 64 }}
              value={draftValue('guardIntervalSec', String(settings.guardIntervalSec))}
              onChange={(e) => setDraft((d) => ({ ...d, guardIntervalSec: e.target.value }))}
              onBlur={() => commitNumber('guardIntervalSec')}
            />
            <Toggle on={settings.guard} onChange={(on) => patch({ guard: on })} />
          </Row>
          <Row title="代理绕过" desc={settings.bypass}>
            <Input
              style={{ width: 180 }}
              value={draftValue('bypass', settings.bypass)}
              onChange={(e) => setDraft((d) => ({ ...d, bypass: e.target.value }))}
              onBlur={() => commitText('bypass')}
            />
          </Row>
          <Row title="TUN 模式" desc="虚拟网卡接管全部流量, 需服务模式">
            <Toggle on={settings.tun} onChange={(on) => patch({ tun: on })} />
          </Row>
          <Row title="服务模式" desc="以 Windows 服务运行内核, TUN 免管理员">
            <Badge tone="green">已安装</Badge>
            <Button size="sm" disabled title="M2 提供">卸载</Button>
          </Row>
          <Row title="开机自启" desc="登录 Windows 时自动启动">
            <Toggle on={settings.autostart} onChange={(on) => patch({ autostart: on })} />
          </Row>
          <Row title="静默启动" desc="启动时仅驻留托盘, 不显示主窗口">
            <Toggle on={settings.silentStart} onChange={(on) => patch({ silentStart: on })} />
          </Row>
        </Card>

        {/* ---- 界面 ---- */}
        <Card icon={<Icon name="sun" />} iconColor="var(--purple)" title="界面" flush>
          <Row title="主题">
            <Seg<Theme>
              items={[
                { value: 'dark', label: '深色' },
                { value: 'light', label: '浅色' },
                { value: 'system', label: '跟随系统' },
              ]}
              value={settings.theme}
              onChange={(v) => patch({ theme: v })}
            />
          </Row>
          <Row title="强调色" desc="M2 支持自定义强调色">
            <div className="swatches">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  className={accent === c ? 'swatch sel' : 'swatch'}
                  style={{ background: c, color: c }}
                  onClick={() => setAccent(c)}
                >
                  {accent === c && <Icon name="check" size={12} />}
                </button>
              ))}
            </div>
          </Row>
          <Row title="自定义 CSS" desc="注入自定义样式覆盖主题">
            <Button size="sm" disabled title="M2 提供">编辑</Button>
          </Row>
          <Row title="语言">
            <select className="select" defaultValue="zh-CN">
              <option value="zh-CN">简体中文</option>
              <option value="en" disabled>English（M2）</option>
            </select>
          </Row>
          <Row title="启动页">
            <select className="select" defaultValue="dashboard">
              <option value="dashboard">仪表盘</option>
              <option value="proxies">节点</option>
              <option value="profiles">订阅</option>
            </select>
          </Row>
        </Card>

        {/* ---- 关于 ---- */}
        <Card icon={<Icon name="check" />} iconColor="var(--green)" title="关于" flush>
          <Row title="ClashNova">
            <div className="about-ver">
              <span className="v">v2.0.0</span>
              <Badge tone="blue">已是最新</Badge>
              <Button size="sm" variant="primary">检查更新</Button>
            </div>
          </Row>
          <Row title="开源协议" desc="MIT License">
            <span className="link">GitHub 仓库</span>
          </Row>
          <Row title="目录">
            <div className="dir-btns">
              <Button size="sm" onClick={() => void call('open_app_dir', { kind: 'config' })}>
                配置目录
              </Button>
              <Button size="sm" onClick={() => void call('open_app_dir', { kind: 'core' })}>
                内核目录
              </Button>
              <Button size="sm" onClick={() => void call('open_app_dir', { kind: 'logs' })}>
                日志目录
              </Button>
            </div>
          </Row>
          <Row title="重置" desc="恢复全部设置为默认值">
            <Button size="sm" variant="danger" disabled title="M2 提供">恢复默认设置</Button>
          </Row>
        </Card>
      </div>

      <div className="col">
        {/* ---- Clash 内核 ---- */}
        <Card
          icon={<Icon name="cpu" />}
          iconColor="var(--cyan)"
          title="Clash 内核"
          actions={<span className="chip">mihomo {core.version}</span>}
          flush
        >
          <Row title="混合端口" desc="HTTP + SOCKS5 共用端口">
            <Input
              className="num"
              style={{ width: 90 }}
              value={draftValue('mixedPort', String(settings.mixedPort))}
              onChange={(e) => setDraft((d) => ({ ...d, mixedPort: e.target.value }))}
              onBlur={() => commitNumber('mixedPort')}
            />
          </Row>
          <Row title="外部控制" desc="RESTful API 监听地址">
            <Input
              className="num"
              style={{ width: 150 }}
              value={draftValue('externalController', settings.externalController)}
              onChange={(e) => setDraft((d) => ({ ...d, externalController: e.target.value }))}
              onBlur={() => commitText('externalController')}
            />
          </Row>
          <Row title="API 密钥" desc="外部控制鉴权 secret">
            <Input
              type="password"
              style={{ width: 150 }}
              value={draftValue('secret', settings.secret)}
              onChange={(e) => setDraft((d) => ({ ...d, secret: e.target.value }))}
              onBlur={() => commitText('secret')}
            />
          </Row>
          <Row title="允许局域网" desc="局域网设备可经本机代理">
            <Toggle on={settings.allowLan} onChange={(on) => patch({ allowLan: on })} />
          </Row>
          <Row title="IPv6">
            <Toggle on={settings.ipv6} onChange={(on) => patch({ ipv6: on })} />
          </Row>
          <Row title="日志等级">
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
          <Row title="DNS 覆写" desc="使用内置 DNS 配置(M2 可编辑)">
            <Toggle on onChange={() => {}} disabled />
          </Row>
          <Row title="内核版本">
            <Seg
              items={[
                { value: 'stable', label: 'Stable' },
                { value: 'alpha', label: 'Alpha' },
              ]}
              value={coreChannel}
              onChange={setCoreChannel}
            />
            <Button size="sm" onClick={() => void restartCore()}>重启内核</Button>
          </Row>
          <Row title="GeoData" desc="geoip.dat · 更新于 3 天前">
            <Button size="sm" disabled title="M2 提供">立即更新</Button>
          </Row>
          <Row title="UWP 回环豁免" desc="解除商店应用回环限制">
            <Button size="sm" disabled title="M2 提供">打开工具</Button>
          </Row>
          <Row title="Web UI" desc="在浏览器中打开外部控制面板">
            <Button size="sm" disabled title="M2 提供">
              <Icon name="external" size={12} />跳转面板
            </Button>
          </Row>
        </Card>

        {/* ---- 热键 ---- */}
        <Card
          icon={<Icon name="zap" />}
          iconColor="var(--orange)"
          title="热键"
          actions={<Button size="sm" disabled title="M2 提供">添加</Button>}
          flush
        >
          {HOTKEYS.map((h) => (
            <Row key={h.name} title={h.name}>
              <div className="kbd-group" style={{ opacity: 0.6 }} title="M2 提供">
                {h.keys.map((k) => (
                  <span className="kbd" key={k}>{k}</span>
                ))}
              </div>
            </Row>
          ))}
        </Card>
      </div>
    </div>
  )
}
