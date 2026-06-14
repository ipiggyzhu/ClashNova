import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useT } from '../../i18n'
import { useAppStore } from '../../stores/app'
import { useNotificationStore } from '../../stores/notifications'
import type { OutboundMode } from '../../types/clash'
import NotificationPanel from '../NotificationPanel'
import Icon from '../ui/Icon'
import Seg from '../ui/Seg'

/** 路由段 → 页面标题(契约 E 的 11 条路由 + 配置文件) */
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
  config: '配置文件',
  settings: '设置',
}

const MODE_ITEMS: { value: OutboundMode; label: string }[] = [
  { value: 'direct', label: '直连' },
  { value: 'rule', label: '规则' },
  { value: 'global', label: '全局' },
]

/** 仅在 Tauri 环境下执行窗口操作, 浏览器/mock 下静默忽略 */
async function winAction(action: 'minimize' | 'toggleMaximize' | 'close'): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const win = getCurrentWindow()
  if (action === 'minimize') await win.minimize()
  else if (action === 'toggleMaximize') await win.toggleMaximize()
  else await win.close()
}

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
      <div className="win-ctrl">
        <button type="button" title={t('最小化')} onClick={() => void winAction('minimize')}>
          <Icon name="minimize" />
        </button>
        <button type="button" title={t('最大化')} onClick={() => void winAction('toggleMaximize')}>
          <Icon name="maximize" />
        </button>
        <button
          type="button"
          className="close"
          title={t('关闭')}
          onClick={() => void winAction('close')}
        >
          <Icon name="x" />
        </button>
      </div>
    </header>
  )
}
