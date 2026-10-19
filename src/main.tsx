import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './router'
import { isMock } from './services/ipc'
import './styles/tokens.css'
import './styles/base.css'

// 与 tray::show_main_window 一致: 仅 Windows 主窗口透明并启用系统 Acrylic, 其它环境保持不透明背景。
if (!isMock && navigator.userAgent.includes('Windows')) document.documentElement.dataset['backdrop'] = 'acrylic'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
