import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './components/layout/Sidebar'
import Topbar from './components/layout/Topbar'
import { useAppStore } from './stores/app'

/** 应用壳层: 侧边栏 + 顶栏 + 内容区(路由出口);负责自定义 CSS 注入 */
export default function App() {
  const customCss = useAppStore((s) => s.settings.customCss)

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
