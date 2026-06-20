import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import App from './App'
import RouteError from './pages/RouteError'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Traffic = lazy(() => import('./pages/Traffic'))
const Connections = lazy(() => import('./pages/Connections'))
const Logs = lazy(() => import('./pages/Logs'))
const Topology = lazy(() => import('./pages/Topology'))
const RouteMap = lazy(() => import('./pages/RouteMap'))
const Proxies = lazy(() => import('./pages/Proxies'))
const Rules = lazy(() => import('./pages/Rules'))
const Providers = lazy(() => import('./pages/Providers'))
const Test = lazy(() => import('./pages/Test'))
const Profiles = lazy(() => import('./pages/Profiles'))
const Config = lazy(() => import('./pages/Config'))
const Settings = lazy(() => import('./pages/Settings'))

function page(Page: LazyExoticComponent<ComponentType>) {
  return (
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  )
}

/**
 * 契约 E 的 11 条路由 + M2 测试页 + 配置查看器, 全部实装。
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: page(Dashboard) },
      { path: 'traffic', element: page(Traffic) },
      { path: 'connections', element: page(Connections) },
      { path: 'logs', element: page(Logs) },
      { path: 'topology', element: page(Topology) },
      { path: 'routemap', element: page(RouteMap) },
      { path: 'proxies', element: page(Proxies) },
      { path: 'rules', element: page(Rules) },
      { path: 'providers', element: page(Providers) },
      { path: 'test', element: page(Test) },
      { path: 'profiles', element: page(Profiles) },
      { path: 'config', element: page(Config) },
      { path: 'settings', element: page(Settings) },
      { path: '*', element: <Navigate to="/dashboard" replace /> },
    ],
  },
])
