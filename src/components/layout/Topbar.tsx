import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useT } from '../../i18n'
import { useAppStore } from '../../stores/app'
import { useNotificationStore } from '../../stores/notifications'
import type { OutboundMode } from '../../types/clash'
import NotificationPanel from '../NotificationPanel'
import Icon from '../ui/Icon'
import Seg from '../ui/Seg'

/** 路由段 → 页面标题(契约 E 的 11 条路由) */
export const PAGE_TITLES: Record<string, string> = {
  dashboard: '仪表盘',
  traffic: '流量统计',
  connections: '连接',
  logs: '日志',
  topology: '拓扑',
  routemap: '路由地图',
  proxies: '节点',
  rules: '规则',
  providers: '提供者',
  test: '测试',
  profiles: '订阅',
  settings: '设置',
}

const MODE_ITEMS: { value: OutboundMode; label: string }[] = [
  { value: 'direct', label: '直连' },
  { value: 'rule', label: '规则' },
  { value: 'global', label: '全局' },
]

export default function Topbar() {
  const t = useT()
  const { pathname } = useLocation()
  const seg = pathname.replace(/^\/+/, '').split('/')[0] || 'dashboard'
  const title = t(PAGE_TITLES[seg] ?? 'ClashNova')

  const mode = useAppStore((s) => s.settings.mode)
  const theme = useAppStore((s) => s.settings.theme)
  const setMode = useAppStore((s) => s.setMode)
  const setTheme = useAppStore((s) => s.setTheme)

  const unreadCount = useNotificationStore((s) => s.unreadCount)
  const [showNotifications, setShowNotifications] = useState(false)

  /** system 主题按当前系统外观解析后再取反 */
  const resolvedTheme: 'dark' | 'light' =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme

  const toggleTheme = () => {
    void setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }

  return (
    <header className="topbar">
      <h1>{title}</h1>
      <div className="spacer" />
      <Seg
        items={MODE_ITEMS.map((m) => ({ ...m, label: t(m.label) }))}
        value={mode}
        onChange={(m) => void setMode(m)}
      />
      <div style={{ position: 'relative' }}>
        <button
          className="icon-btn"
          type="button"
          title={t('通知')}
          onClick={() => setShowNotifications(!showNotifications)}
        >
          <Icon name="bell" />
          {unreadCount > 0 && <span className="badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
        </button>
        {showNotifications && <NotificationPanel onClose={() => setShowNotifications(false)} />}
      </div>
      <button className="icon-btn" type="button" title={t('切换主题')} onClick={toggleTheme}>
        <Icon name={resolvedTheme === 'dark' ? 'sun' : 'moon'} />
      </button>
    </header>
  )
}
