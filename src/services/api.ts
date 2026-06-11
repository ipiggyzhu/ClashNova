/**
 * mihomo REST 封装 — 锁定契约 C。
 * base = http://127.0.0.1:9097, header `Authorization: Bearer {secret}`。
 * mock 模式直接返回 mock.ts 造数。
 */
import type { ProxiesPayload, RuleItem } from '../types/clash'
import { isMock } from './ipc'
import {
  mockCloseAllConnections,
  mockCloseConnection,
  mockProxies,
  mockRules,
  mockSelectProxy,
  mockSettings,
  mockTestDelay,
} from './mock'

interface ApiConfig { baseUrl: string; secret: string }

const config: ApiConfig = {
  baseUrl: 'http://127.0.0.1:9097',
  secret: mockSettings().secret,
}

/** 设置页修改外部控制地址/密钥后调用, 同步 REST/WS 连接参数 */
export function configureApi(externalController: string, secret: string): void {
  config.baseUrl = `http://${externalController}`
  config.secret = secret
}

/** ws.ts 复用同一份连接参数 */
export function apiConfig(): Readonly<ApiConfig> {
  return config
}

const DELAY_TEST_URL = 'https://www.gstatic.com/generate_204'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  return request('GET', '/proxies')
}

/** GET /rules */
export async function getRules(): Promise<RuleItem[]> {
  if (isMock) {
    await mockDelayMs()
    return mockRules()
  }
  const payload = await request<{ rules: RuleItem[] }>('GET', '/rules')
  return payload.rules
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
