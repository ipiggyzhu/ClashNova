import { useEffect, useRef } from 'react'
import './NotificationPanel.css'
import Button from './ui/Button'
import Icon from './ui/Icon'
import type { IconName } from './ui/Icon'
import { useT } from '../i18n'
import { useNotificationStore } from '../stores/notifications'
import type { NotificationType } from '../stores/notifications'

interface NotificationPanelProps {
  onClose: () => void
}

const TYPE_ICONS: Record<NotificationType, IconName> = {
  info: 'bell',
  success: 'check',
  warning: 'bell',
  error: 'x',
}

const TYPE_COLORS: Record<NotificationType, string> = {
  info: 'var(--accent)',
  success: 'var(--green)',
  warning: 'var(--orange)',
  error: 'var(--red)',
}

function formatTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days < 30) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString('zh-CN')
}

export default function NotificationPanel({ onClose }: NotificationPanelProps) {
  const t = useT()
  const panelRef = useRef<HTMLDivElement>(null)
  const notifications = useNotificationStore((s) => s.notifications)
  const markAsRead = useNotificationStore((s) => s.markAsRead)
  const markAllAsRead = useNotificationStore((s) => s.markAllAsRead)
  const remove = useNotificationStore((s) => s.remove)
  const clearAll = useNotificationStore((s) => s.clearAll)

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  const handleNotificationClick = (id: string, read: boolean) => {
    if (!read) markAsRead(id)
  }

  return (
    <div className="notif-panel" ref={panelRef}>
      <div className="notif-head">
        <span>{t('通知')}</span>
        <span className="spacer" />
        {notifications.length > 0 && (
          <>
            <Button size="sm" onClick={markAllAsRead}>
              {t('全部已读')}
            </Button>
            <Button size="sm" onClick={clearAll}>
              {t('清空')}
            </Button>
          </>
        )}
      </div>

      <div className="notif-body">
        {notifications.length === 0 ? (
          <div className="notif-empty">
            <Icon name="bell" size={32} />
            <span>{t('暂无通知')}</span>
          </div>
        ) : (
          notifications.map((notif) => (
            <div
              key={notif.id}
              className={notif.read ? 'notif-item read' : 'notif-item'}
              onClick={() => handleNotificationClick(notif.id, notif.read)}
            >
              <div className="notif-icon" style={{ color: TYPE_COLORS[notif.type] }}>
                <Icon name={TYPE_ICONS[notif.type]} size={16} />
              </div>
              <div className="notif-content">
                <div className="notif-title">{notif.title}</div>
                <div className="notif-message">{notif.message}</div>
                <div className="notif-time">{formatTime(notif.timestamp)}</div>
              </div>
              <button
                className="notif-remove"
                onClick={(e) => {
                  e.stopPropagation()
                  remove(notif.id)
                }}
                title={t('删除')}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
