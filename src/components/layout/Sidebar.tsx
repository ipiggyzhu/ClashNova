import { useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { useT } from '../../i18n'
import { useAppStore } from '../../stores/app'
import { startLiveStreams, useLiveStore } from '../../stores/live'
import Icon from '../ui/Icon'
import type { IconName } from '../ui/Icon'

interface NavEntry {
  key: IconName
  label: string
  /** 路由段缺省取 key */
  to?: string
}

interface NavGroup {
  group: string
  items: NavEntry[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    group: '概览',
    items: [
      { key: 'dashboard', label: '仪表盘' },
      { key: 'traffic', label: '流量统计' },
      { key: 'connections', label: '连接' },
      { key: 'logs', label: '日志' },
    ],
  },
  {
    group: '可视化',
    items: [
      { key: 'topology', label: '拓扑' },
      { key: 'routemap', label: '路由地图' },
    ],
  },
  {
    group: '代理',
    items: [
      { key: 'proxies', label: '节点' },
      { key: 'rules', label: '规则' },
      { key: 'providers', label: '提供者' },
      { key: 'zap', label: '测试', to: 'test' },
    ],
  },
  {
    group: '配置',
    items: [
      { key: 'profiles', label: '订阅' },
      { key: 'settings', label: '设置' },
    ],
  },
]

/** 内核状态轮询间隔(ms) */
const CORE_POLL_MS = 5000

export default function Sidebar() {
  const t = useT()
  const core = useAppStore((s) => s.coreStatus)
  const memInuse = useLiveStore((s) => s.memory.inuse)
  const loadAll = useAppStore((s) => s.loadAll)
  const refreshCoreStatus = useAppStore((s) => s.refreshCoreStatus)

  useEffect(() => startLiveStreams(), [])

  useEffect(() => {
    void loadAll().catch(() => undefined)
    const timer = setInterval(() => {
      void refreshCoreStatus().catch(() => undefined)
    }, CORE_POLL_MS)
    return () => clearInterval(timer)
  }, [loadAll, refreshCoreStatus])

  // 内核停止后 WS 不再推帧, 不能沿用最后一帧的陈旧内存值
  const memMb = core.running ? Math.round((memInuse || core.memoryBytes) / 1024 / 1024) : 0
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo">
          <Icon name="logo" />
        </div>
        <div>
          <div className="brand-name">ClashNova</div>
          <div className="brand-ver">v{__APP_VERSION__}</div>
        </div>
      </div>
      <nav className="nav">
        {NAV_GROUPS.map((g) => (
          <div className="nav-group" key={g.group}>
            <div className="nav-title">{t(g.group)}</div>
            {g.items.map((it) => (
              <NavLink
                key={it.key}
                to={`/${it.to ?? it.key}`}
                className={({ isActive }) => (isActive ? 'nav-item on' : 'nav-item')}
              >
                <Icon name={it.key} />
                {t(it.label)}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="side-foot">
        <div className="kernel-chip">
          <span
            className="dot"
            style={
              core.running
                ? undefined
                : { background: 'var(--red)', boxShadow: '0 0 6px var(--red)' }
            }
          />
          <div style={{ flex: 1 }}>
            <b>{core.running ? t('Mihomo 运行中') : t('Mihomo 已停止')}</b>
            <br />
            <span>
              {core.version !== '—' && `${core.version} · `}
              {t('内存')} {memMb} MB
            </span>
          </div>
        </div>
      </div>
    </aside>
  )
}
