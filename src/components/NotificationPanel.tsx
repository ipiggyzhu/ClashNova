import { useEffect } from 'react'
import type { RefObject } from 'react'
import './NotificationPanel.css'
import Button from './ui/Button'
import Icon from './ui/Icon'
import { useDialogFocus } from './ui/Dialog'
import type { IconName } from './ui/Icon'
import { useT } from '../i18n'
import { useNotificationStore } from '../stores/notifications'
import type { NotificationType } from '../stores/notifications'

interface NotificationPanelProps {
  onClose: () => void
  triggerRef: RefObject<HTMLButtonElement>
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

export default function NotificationPanel({ onClose, triggerRef }: NotificationPanelProps) {
  const t = useT()
  const panelRef = useDialogFocus(onClose, false)
  const notifications = useNotificationStore((s) => s.notifications)
  const markAsRead = useNotificationStore((s) => s.markAsRead)
  const markAllAsRead = useNotificationStore((s) => s.markAllAsRead)
  const remove = useNotificationStore((s) => s.remove)
  const clearAll = useNotificationStore((s) => s.clearAll)

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose, panelRef, triggerRef])

  const handleNotificationClick = (id: string, read: boolean) => {
    if (!read) markAsRead(id)
  }

  return (
    <div className="notif-panel" id="notification-panel" ref={panelRef} role="dialog" aria-label={t('通知')} tabIndex={-1}>
      <div className="notif-head">
        <span>{t('通知')}</span>
        <span className="spacer" />
        {notifications.length > 0 && (
          <>
            <Button size="sm" onClick={markAllAsRead}>
              {t('全部已读')}
            </Button>
            <Button size="sm" onClick={() => {
              panelRef.current?.querySelector<HTMLButtonElement>('.notif-close')?.focus()
              clearAll()
            }}>
              {t('清空')}
            </Button>
          </>
        )}
        <button type="button" className="icon-btn notif-close" aria-label={t('关闭通知')} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
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
            >
              <button type="button" className="notif-open" onClick={() => handleNotificationClick(notif.id, notif.read)}
                aria-label={`${notif.title} · ${notif.read ? t('已读') : t('未读')}`}>
                <span className="notif-icon" style={{ color: TYPE_COLORS[notif.type] }}>
                  <Icon name={TYPE_ICONS[notif.type]} size={16} />
                </span>
                <span className="notif-content">
                  <span className="notif-title">{notif.title}</span>
                  <span className="notif-message">{notif.message}</span>
                  <span className="notif-time">{formatTime(notif.timestamp)}</span>
                </span>
              </button>
              <button
                type="button"
                className="notif-remove"
                onClick={(e) => {
                  e.stopPropagation()
                  const row = e.currentTarget.closest('.notif-item')
                  const next = row?.nextElementSibling ?? row?.previousElementSibling
                  const target = next?.querySelector<HTMLButtonElement>('.notif-open')
                    ?? panelRef.current?.querySelector<HTMLButtonElement>('.notif-close')
                  target?.focus()
                  remove(notif.id)
                }}
                aria-label={`${t('删除通知')}：${notif.title}`}
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
