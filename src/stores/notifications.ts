/**
 * 通知中心 — 系统消息、订阅更新、内核事件等通知。
 */
import { create } from 'zustand'

export type NotificationType = 'info' | 'success' | 'warning' | 'error'

export interface Notification {
  id: string
  type: NotificationType
  title: string
  message: string
  timestamp: number
  read: boolean
}

interface NotificationStore {
  notifications: Notification[]
  unreadCount: number
  /** 添加通知 */
  add: (type: NotificationType, title: string, message: string) => void
  /** 标记为已读 */
  markAsRead: (id: string) => void
  /** 标记全部已读 */
  markAllAsRead: () => void
  /** 清除单条通知 */
  remove: (id: string) => void
  /** 清除全部通知 */
  clearAll: () => void
}

let notificationId = 0

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],
  unreadCount: 0,

  add: (type, title, message) => {
    const id = `notif-${++notificationId}`
    const notification: Notification = {
      id,
      type,
      title,
      message,
      timestamp: Date.now(),
      read: false,
    }
    set((state) => ({
      notifications: [notification, ...state.notifications],
      unreadCount: state.unreadCount + 1,
    }))
  },

  markAsRead: (id) =>
    set((state) => {
      const notif = state.notifications.find((n) => n.id === id)
      if (!notif || notif.read) return state
      return {
        notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
        unreadCount: Math.max(0, state.unreadCount - 1),
      }
    }),

  markAllAsRead: () =>
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    })),

  remove: (id) =>
    set((state) => {
      const notif = state.notifications.find((n) => n.id === id)
      return {
        notifications: state.notifications.filter((n) => n.id !== id),
        unreadCount: notif && !notif.read ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
      }
    }),

  clearAll: () =>
    set({
      notifications: [],
      unreadCount: 0,
    }),
}))
