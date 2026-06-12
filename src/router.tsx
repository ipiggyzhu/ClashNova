import { createBrowserRouter, Navigate } from 'react-router-dom'
import App from './App'
import Dashboard from './pages/Dashboard'
import Connections from './pages/Connections'
import Logs from './pages/Logs'
import Proxies from './pages/Proxies'
import Providers from './pages/Providers'
import RouteMap from './pages/RouteMap'
import Rules from './pages/Rules'
import Profiles from './pages/Profiles'
import Settings from './pages/Settings'
import Test from './pages/Test'
import Topology from './pages/Topology'
import Traffic from './pages/Traffic'

/**
 * 契约 E 的 11 条路由 + M2 测试页, 全部实装(M3 完成后无占位)。
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'traffic', element: <Traffic /> },
      { path: 'connections', element: <Connections /> },
      { path: 'logs', element: <Logs /> },
      { path: 'topology', element: <Topology /> },
      { path: 'routemap', element: <RouteMap /> },
      { path: 'proxies', element: <Proxies /> },
      { path: 'rules', element: <Rules /> },
      { path: 'providers', element: <Providers /> },
      { path: 'test', element: <Test /> },
      { path: 'profiles', element: <Profiles /> },
      { path: 'settings', element: <Settings /> },
      { path: '*', element: <Navigate to="/dashboard" replace /> },
    ],
  },
])
