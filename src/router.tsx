import { createBrowserRouter, Navigate } from 'react-router-dom'
import App from './App'
import Dashboard from './pages/Dashboard'
import Connections from './pages/Connections'
import Logs from './pages/Logs'
import Proxies from './pages/Proxies'
import Rules from './pages/Rules'
import Profiles from './pages/Profiles'
import Settings from './pages/Settings'
import Placeholder from './pages/Placeholder'

/**
 * 契约 E: 11 条路由。
 * M1 实装 dashboard/connections/logs/proxies/rules/profiles/settings;
 * traffic/topology/routemap/providers 为 M3 占位。
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'traffic', element: <Placeholder title="流量统计" /> },
      { path: 'connections', element: <Connections /> },
      { path: 'logs', element: <Logs /> },
      { path: 'topology', element: <Placeholder title="拓扑" /> },
      { path: 'routemap', element: <Placeholder title="路由地图" /> },
      { path: 'proxies', element: <Proxies /> },
      { path: 'rules', element: <Rules /> },
      { path: 'providers', element: <Placeholder title="提供者" /> },
      { path: 'profiles', element: <Profiles /> },
      { path: 'settings', element: <Settings /> },
      { path: '*', element: <Navigate to="/dashboard" replace /> },
    ],
  },
])
