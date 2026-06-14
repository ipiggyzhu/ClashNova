/**
 * mihomo REST 封装 — 锁定契约 C。
 * base = http://127.0.0.1:9097, header `Authorization: Bearer {secret}`。
 * mock 模式直接返回 mock.ts 造数。
 */
import type { ProxiesPayload, ProxyProviderItem, RuleItem, RuleProviderItem } from '../types/clash'
import { call, isMock } from './ipc'
import {
  mockCloseAllConnections,
  mockCloseConnection,
  mockProxies,
  mockProxyProviders,
  mockRuleProviders,
  mockRules,
  mockSelectProxy,
  mockSettings,
  mockTestDelay,
  mockUpdateProxyProvider,
  mockUpdateRuleProvider,
} from './mock'

interface ApiConfig { baseUrl: string; secret: string }

const config: ApiConfig = {
  baseUrl: 'http://127.0.0.1:9097',
  secret: mockSettings().secret,
}
let configReady = isMock

/** 设置页修改外部控制地址/密钥后调用, 同步 REST/WS 连接参数 */
export function configureApi(externalController: string, secret: string): void {
  config.baseUrl = `http://${externalController}`
  config.secret = secret
  configReady = true
}

/** ws.ts 复用同一份连接参数 */
export function apiConfig(): Readonly<ApiConfig> {
  return config
}

const DELAY_TEST_URL = 'https://www.gstatic.com/generate_204'

async function ensureConfigured(): Promise<void> {
  if (configReady) return
  const settings = await call('get_settings')
  configureApi(settings.externalController, settings.secret)
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  await ensureConfigured()
  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.secret}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`mihomo API ${method} ${path} 失败: HTTP ${res.status}`)
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

function recordOrEmpty<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {}
}

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

const mockDelayMs = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 120))

/** GET /version */
export async function getVersion(): Promise<{ version: string; meta?: boolean }> {
  if (isMock) {
    await mockDelayMs()
    return { version: 'v1.19.2', meta: true }
  }
  return request('GET', '/version')
}

/** GET /proxies */
export async function getProxies(): Promise<ProxiesPayload> {
  if (isMock) {
    await mockDelayMs()
    return mockProxies()
  }
  const rawPayload = await request<Partial<ProxiesPayload> | null>('GET', '/proxies')
  const payload: ProxiesPayload = {
    proxies: recordOrEmpty(rawPayload?.proxies),
  }
  // Some mihomo configs keep provider nodes only under /providers/proxies.
  // Merge them into the proxy dictionary so groups that reference provider nodes render normally.
  try {
    const providersPayload = await request<{ providers?: Record<string, RawProxyProvider> } | null>(
      'GET',
      '/providers/proxies',
    )
    for (const provider of Object.values(recordOrEmpty<RawProxyProvider>(providersPayload?.providers))) {
      if (provider.vehicleType === 'Compatible') continue
      for (const proxy of arrayOrEmpty(provider.proxies)) {
        if (!isProxyLike(proxy) || payload.proxies[proxy.name]) continue
        payload.proxies[proxy.name] = {
          ...proxy,
          history: arrayOrEmpty(proxy.history),
        }
      }
    }
  } catch {
    // /proxies is still useful when provider details are unavailable.
  }
  return payload
}

/** GET /rules */
export async function getRules(): Promise<RuleItem[]> {
  if (isMock) {
    await mockDelayMs()
    return mockRules()
  }
  const payload = await request<{ rules?: RuleItem[] } | null>('GET', '/rules')
  return arrayOrEmpty(payload?.rules)
}

/** PUT /proxies/{group} body {name} — 切换组内选中节点 */
export async function selectProxy(group: string, name: string): Promise<void> {
  if (isMock) {
    await mockDelayMs()
    mockSelectProxy(group, name)
    return
  }
  await request('PUT', `/proxies/${encodeURIComponent(group)}`, { name })
}

/** GET /proxies/{name}/delay — 单节点测延迟(ms); 超时抛错 */
export async function testDelay(name: string, timeout = 5000): Promise<number> {
  if (isMock) {
    await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 450))
    const delay = mockTestDelay(name)
    if (delay > 2000) throw new Error('超时')
    return delay
  }
  const qs = `timeout=${timeout}&url=${encodeURIComponent(DELAY_TEST_URL)}`
  const payload = await request<{ delay: number }>(
    'GET',
    `/proxies/${encodeURIComponent(name)}/delay?${qs}`,
  )
  return payload.delay
}

/** PATCH /configs body {mode} — 切换出站模式 */
export async function patchMode(mode: string): Promise<void> {
  if (isMock) {
    await mockDelayMs()
    return
  }
  await request('PATCH', '/configs', { mode })
}

/** DELETE /connections/{id} — 关闭单个连接 */
export async function closeConnection(id: string): Promise<void> {
  if (isMock) {
    await mockDelayMs()
    mockCloseConnection(id)
    return
  }
  await request('DELETE', `/connections/${encodeURIComponent(id)}`)
}

/** DELETE /connections — 关闭全部连接 */
export async function closeAllConnections(): Promise<void> {
  if (isMock) {
    await mockDelayMs()
    mockCloseAllConnections()
    return
  }
  await request('DELETE', '/connections')
}

/* ---------------- 提供者(M2) ---------------- */

/** POST /configs/geo — 让内核更新 GeoData 数据库 */
export async function updateGeo(): Promise<void> {
  if (isMock) {
    await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 1200))
    return
  }
  await request('POST', '/configs/geo')
}

/** mihomo 提供者原始结构(仅取所需字段) */
interface RawProxyProvider {
  name: string
  vehicleType: string
  proxies?: unknown[]
  updatedAt?: string
  subscriptionInfo?: { Upload?: number; Download?: number; Total?: number; Expire?: number }
}

interface RawRuleProvider {
  name: string
  behavior: string
  vehicleType: string
  ruleCount: number
  updatedAt?: string
}

function toMillis(iso?: string): number | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}

type ProviderProxyNode = Partial<ProxiesPayload['proxies'][string]> & { name: string; type: string }

function isProxyLike(value: unknown): value is ProviderProxyNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

/** GET /providers/proxies — 过滤 mihomo 内置的 Compatible 提供者 */
export async function getProxyProviders(): Promise<ProxyProviderItem[]> {
  if (isMock) {
    await mockDelayMs()
    return mockProxyProviders()
  }
  const payload = await request<{ providers?: Record<string, RawProxyProvider> } | null>(
    'GET',
    '/providers/proxies',
  )
  return Object.values(recordOrEmpty<RawProxyProvider>(payload?.providers))
    .filter((p) => p.vehicleType !== 'Compatible')
    .map((p) => {
      const sub = p.subscriptionInfo
      return {
        name: p.name,
        vehicleType: p.vehicleType,
        nodeCount: arrayOrEmpty(p.proxies).length,
        updatedAt: toMillis(p.updatedAt),
        subscription:
          sub && sub.Total
            ? {
                used: (sub.Upload ?? 0) + (sub.Download ?? 0),
                total: sub.Total,
                ...(sub.Expire ? { expireAt: sub.Expire * 1000 } : {}),
              }
            : undefined,
      }
    })
}

/** GET /providers/rules */
export async function getRuleProviders(): Promise<RuleProviderItem[]> {
  if (isMock) {
    await mockDelayMs()
    return mockRuleProviders()
  }
  const payload = await request<{ providers?: Record<string, RawRuleProvider> } | null>(
    'GET',
    '/providers/rules',
  )
  return Object.values(recordOrEmpty<RawRuleProvider>(payload?.providers)).map((p) => ({
    name: p.name,
    behavior: p.behavior,
    vehicleType: p.vehicleType,
    ruleCount: p.ruleCount,
    updatedAt: toMillis(p.updatedAt),
  }))
}

/** PUT /providers/proxies/{name} — 远程更新代理提供者 */
export async function updateProxyProvider(name: string): Promise<void> {
  if (isMock) {
    await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 600))
    mockUpdateProxyProvider(name)
    return
  }
  await request('PUT', `/providers/proxies/${encodeURIComponent(name)}`)
}

/** PUT /providers/rules/{name} — 远程更新规则提供者 */
export async function updateRuleProvider(name: string): Promise<void> {
  if (isMock) {
    await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 500))
    mockUpdateRuleProvider(name)
    return
  }
  await request('PUT', `/providers/rules/${encodeURIComponent(name)}`)
}

/** GET /providers/proxies/{name}/healthcheck */
export async function healthcheckProvider(name: string): Promise<void> {
  if (isMock) {
    await new Promise((resolve) => setTimeout(resolve, 600 + Math.random() * 900))
    return
  }
  await request('GET', `/providers/proxies/${encodeURIComponent(name)}/healthcheck`)
}
