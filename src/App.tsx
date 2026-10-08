import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './components/layout/Sidebar'
import Topbar from './components/layout/Topbar'
import { useAppStore, watchSystemTheme } from './stores/app'
import { isMock } from './services/ipc'
import { useNotificationStore } from './stores/notifications'

/** 应用壳层: 侧边栏 + 顶栏 + 内容区(路由出口);负责自定义 CSS 注入 */
export default function App() {
  const customCss = useAppStore((s) => s.settings.customCss)

  useEffect(watchSystemTheme, [])

  useEffect(() => {
    const refresh = (): void => {
      if (!document.hidden) void useAppStore.getState().refreshCoreStatus().catch(() => undefined)
    }
    void useAppStore.getState().loadAll().catch(() => undefined)
    const timer = window.setInterval(refresh, 5000)
    document.addEventListener('visibilitychange', refresh)
    let disposed = false
    const unlisteners: (() => void)[] = []
    if (!isMock) {
      void import('@tauri-apps/api/event').then(async ({ listen }) => {
        const register = async (listener: Promise<() => void>): Promise<void> => {
          const stop = await listener
          if (disposed) stop()
          else unlisteners.push(stop)
        }
        await Promise.all([
          register(
          listen('settings-changed', () => {
            void useAppStore.getState().loadAll().catch(() => undefined)
          })),
          register(
          listen<{ title: string; message: string }>('operation-error', ({ payload }) => {
            useNotificationStore.getState().add('error', payload.title, payload.message)
          })),
          register(
          listen('traffic-updated', () => {
            window.dispatchEvent(new CustomEvent('clashnova-traffic-updated'))
          })),
        ])
      }).catch(() => undefined)
    }
    return () => {
      disposed = true
      unlisteners.forEach((stop) => stop())
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  useEffect(() => {
    let el = document.getElementById('custom-css') as HTMLStyleElement | null
    if (!customCss) {
      el?.remove()
      return
    }
    if (!el) {
      el = document.createElement('style')
      el.id = 'custom-css'
      document.head.appendChild(el)
    }
    el.textContent = customCss
  }, [customCss])

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <Topbar />
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
