/**
 * mihomo REST 封装 — 锁定契约 C。
 * base = http://127.0.0.1:9097, header `Authorization: Bearer {secret}`。
 * mock 模式直接返回 mock.ts 造数。
 */
import type {
  ConnectionsPayload,
  DnsAnswer,
  DnsQueryResult,
  OutboundMode,
  ProxiesPayload,
  ProxyProviderItem,
  RuleItem,
  RuleProviderItem,
} from '../types/clash'
import { call, isMock } from './ipc'
import { createTaskQueue } from '../utils/taskQueue'
import {
  mockCloseAllConnections,
  mockCloseConnection,
  mockCloseGroupConnections,
  mockProxies,
  mockProxyProviders,
  mockQueryDns,
  mockRuleProviders,
  mockRules,
  mockSelectProxy,
  mockSettings,
  mockTestDelay,
  mockTestGroupDelay,
  mockUpdateProxyProvider,
  mockUpdateRuleProvider,
} from './mock'

interface ApiConfig { baseUrl: string; secret: string }

const config: ApiConfig = {
  baseUrl: 'http://127.0.0.1:9097',
  secret: mockSettings().secret,
}
let configReady = isMock
let configuring: Promise<void> | null = null
let configRevision = 0
const activeRequests = new Set<AbortController>()
const queueDelay = createTaskQueue<number>(8)

/** 设置页修改外部控制地址/密钥后调用, 同步 REST/WS 连接参数 */
export function configureApi(externalController: string, secret: string): void {
  const changed = config.baseUrl !== `http://${externalController}` || config.secret !== secret
  config.baseUrl = `http://${externalController}`
  config.secret = secret
  configReady = true
  if (changed) {
    configRevision += 1
    for (const controller of activeRequests) controller.abort()
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('clashnova-api-config-changed'))
    }
  }
}

/** ws.ts 复用同一份连接参数 */
export function apiConfig(): Readonly<ApiConfig> {
  return { ...config }
}

export const DEFAULT_DELAY_TEST_URL = 'https://www.gstatic.com/generate_204'

export async function ensureConfigured(): Promise<void> {
  if (configReady) return
  if (!configuring) {
    const revision = configRevision
    configuring = call('get_settings').then((settings) => {
      if (revision === configRevision) configureApi(settings.externalController, settings.secret)
    }).finally(() => { configuring = null })
  }
  await configuring
}

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  await ensureConfigured()
  const revision = configRevision
  // 内核停止后，监听端口可能已被其他进程占用；状态确认前不发送认证头。
  if (!(await call('core_status')).running) throw new Error('内核未运行')
  if (revision !== configRevision) throw new DOMException('控制器配置已变更', 'AbortError')
  const controller = new AbortController()
  activeRequests.add(controller)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${config.baseUrl}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.secret}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`mihomo API ${method} ${path.split('?')[0]} 失败: HTTP ${res.status}`)
    }
    const text = res.status === 204 ? '' : await res.text()
    if (revision !== configRevision) throw new DOMException('控制器配置已变更', 'AbortError')
    return (text ? JSON.parse(text) : undefined) as T
  } finally {
    clearTimeout(timer)
    activeRequests.delete(controller)
  }
}

function recordOrEmpty<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {}
}

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function outboundModeOrUndefined(value: unknown): OutboundMode | undefined {
  return value === 'rule' || value === 'global' || value === 'direct' ? value : undefined
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
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
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

/**
 * 测速超时的错误标记。mihomo 对测速超时回 504, 本地等待超过 timeout+2s 会 abort,
 * 两者都归为超时; 其余错误(内核未运行、节点不支持该测速等)算失败。界面据此区分文案。
 */
export const DELAY_TIMEOUT = 'DELAY_TIMEOUT'

export function isDelayTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === DELAY_TIMEOUT
}

/** GET /proxies/{name}/delay — 单节点测延迟(ms); 超时抛 DELAY_TIMEOUT, 其余失败抛普通错误 */
export async function testDelay(name: string, timeout = 5000, url = DEFAULT_DELAY_TEST_URL): Promise<number> {
  await ensureConfigured()
  const revision = configRevision
  return queueDelay(`${revision}:${name}`, async () => {
    if (revision !== configRevision) throw new DOMException('控制器配置已变更', 'AbortError')
    if (isMock) {
      await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 450))
      const delay = mockTestDelay(name)
      if (delay > timeout) throw new Error(DELAY_TIMEOUT)
      return delay
    }
    const qs = `timeout=${timeout}&url=${encodeURIComponent(url)}`
    let payload: { delay: number }
    try {
      payload = await request<{ delay: number }>(
        'GET', `/proxies/${encodeURIComponent(name)}/delay?${qs}`, undefined, timeout + 2000,
      )
    } catch (error) {
      if (error instanceof DOMException) {
        if (error.name === 'AbortError' && revision === configRevision) throw new Error(DELAY_TIMEOUT)
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      if (message.endsWith('HTTP 504') || /abort/i.test(message)) throw new Error(DELAY_TIMEOUT)
      throw error
    }
    if (!Number.isFinite(payload.delay) || payload.delay <= 0) throw new Error('测速失败')
    return payload.delay
  })
}

/**
 * GET /group/{name}/delay — 内核并发测整组, 返回 {成员: 延迟}; 超时成员不出现在结果里。
 * mihomo 全部超时时回 504, 这里按空结果处理。URLTest/Fallback 组测完会清掉手动固定的节点并重选。
 */
export async function testGroupDelay(
  group: string, timeout = 5000, url = DEFAULT_DELAY_TEST_URL,
): Promise<Record<string, number>> {
  if (isMock) {
    await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 600))
    return mockTestGroupDelay(group, timeout)
  }
  const qs = `timeout=${timeout}&url=${encodeURIComponent(url)}`
  try {
    const payload = await request<Record<string, unknown> | null>(
      'GET', `/group/${encodeURIComponent(group)}/delay?${qs}`, undefined, timeout + 3000,
    )
    const result: Record<string, number> = {}
    for (const [name, delay] of Object.entries(recordOrEmpty<unknown>(payload))) {
      if (typeof delay === 'number' && delay > 0) result[name] = delay
    }
    return result
  } catch (error) {
    if (error instanceof Error && error.message.endsWith('HTTP 504')) return {}
    throw error
  }
}

/**
 * 切换节点后关闭链路经过该组的旧连接, 让新连接立即走新节点。
 * 清理失败不影响切换结果, 错误吞掉。
 */
export async function closeGroupConnections(group: string): Promise<void> {
  if (isMock) {
    mockCloseGroupConnections(group)
    return
  }
  try {
    const payload = await request<Partial<ConnectionsPayload> | null>('GET', '/connections')
    const ids = arrayOrEmpty<{ id?: unknown; chains?: unknown }>(payload?.connections)
      .filter((conn) => typeof conn.id === 'string' && Array.isArray(conn.chains) && conn.chains.includes(group))
      .map((conn) => conn.id as string)
    for (let i = 0; i < ids.length; i += 8) {
      await Promise.all(ids.slice(i, i + 8).map((id) => closeConnection(id).catch(() => undefined)))
    }
  } catch {
    // 切换已成功; 旧连接会在自然结束后释放。
  }
}

/** PATCH /configs body {mode} — 切换出站模式 */
export async function patchMode(mode: string): Promise<void> {
  if (isMock) {
    await mockDelayMs()
    return
  }
  await request('PATCH', '/configs', { mode })
}

/** GET /configs — 只暴露 ClashNova 需要跟随的低风险运行态字段 */
export async function getRuntimeConfigs(): Promise<{ mode?: OutboundMode }> {
  if (isMock) {
    await mockDelayMs()
    return { mode: mockSettings().mode }
  }
  const payload = await request<Record<string, unknown> | null>('GET', '/configs')
  return {
    mode: outboundModeOrUndefined(payload?.mode),
  }
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

/** POST /cache/fakeip/flush — 清空 Fake-IP 映射池 */
export async function flushFakeIp(): Promise<void> {
  if (isMock) {
    await mockDelayMs()
    return
  }
  await request('POST', '/cache/fakeip/flush')
}

/** POST /cache/dns/flush — 清空内核 DNS 缓存 */
export async function flushDnsCache(): Promise<void> {
  if (isMock) {
    await mockDelayMs()
    return
  }
  await request('POST', '/cache/dns/flush')
}

/** GET /dns/query?name=&type= — 经内核 DNS 解析; 内核未启用 DNS 时 mihomo 回 500 */
export async function queryDns(name: string, type = 'A'): Promise<DnsQueryResult> {
  if (isMock) {
    await mockDelayMs()
    return mockQueryDns(name, type)
  }
  const qs = `name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`
  const payload = await request<{ Status?: unknown; Answer?: unknown } | null>('GET', `/dns/query?${qs}`)
  return {
    status: typeof payload?.Status === 'number' ? payload.Status : -1,
    answers: arrayOrEmpty<Partial<DnsAnswer>>(payload?.Answer).map((answer) => ({
      name: typeof answer.name === 'string' ? answer.name : '',
      type: typeof answer.type === 'number' ? answer.type : 0,
      TTL: typeof answer.TTL === 'number' ? answer.TTL : 0,
      data: typeof answer.data === 'string' ? answer.data.trim() : '',
    })),
  }
}

/* ---------------- 提供者(M2) ---------------- */

/** POST /configs/geo — 让内核更新 GeoData 数据库 */
export async function updateGeo(): Promise<void> {
  if (isMock) {
    await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 1200))
    return
  }
  await request('POST', '/configs/geo', undefined, 180_000)
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
  await request('PUT', `/providers/proxies/${encodeURIComponent(name)}`, undefined, 60_000)
}

/** PUT /providers/rules/{name} — 远程更新规则提供者 */
export async function updateRuleProvider(name: string): Promise<void> {
  if (isMock) {
    await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 500))
    mockUpdateRuleProvider(name)
    return
  }
  await request('PUT', `/providers/rules/${encodeURIComponent(name)}`, undefined, 60_000)
}

/** GET /providers/proxies/{name}/healthcheck */
export async function healthcheckProvider(name: string): Promise<void> {
  if (isMock) {
    await new Promise((resolve) => setTimeout(resolve, 600 + Math.random() * 900))
    return
  }
  await request('GET', `/providers/proxies/${encodeURIComponent(name)}/healthcheck`, undefined, 90_000)
}
