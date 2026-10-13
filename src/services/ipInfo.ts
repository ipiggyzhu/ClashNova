/**
 * 出口 IP 查询 — 由 WebView 直接请求公共 IP 服务(均返回 Access-Control-Allow-Origin: *)。
 * WebView 跟随系统代理 / TUN, 因此结果是"本机当前网络看到的出口", 而非某个指定节点。
 * 依次尝试多个服务, 任一成功即返回。
 */
import { isMock } from './ipc'

export interface IpInfo {
  ip: string
  country: string
  countryCode: string
  region: string
  city: string
  isp: string
  asn: string
  source: string
}

type Json = Record<string, unknown>

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
const obj = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {})
const asn = (value: unknown): string => {
  const raw = text(value)
  if (!raw) return ''
  return /^AS/i.test(raw) ? raw.split(/\s+/)[0]!.toUpperCase() : `AS${raw}`
}

const PROVIDERS: { name: string; url: string; parse: (j: Json) => IpInfo | null }[] = [
  {
    name: 'ip.sb',
    url: 'https://api.ip.sb/geoip',
    parse: (j) => ({
      ip: text(j.ip), country: text(j.country), countryCode: text(j.country_code),
      region: text(j.region), city: text(j.city),
      isp: text(j.isp) || text(j.organization), asn: asn(j.asn), source: 'ip.sb',
    }),
  },
  {
    name: 'ipwho.is',
    url: 'https://ipwho.is/',
    parse: (j) => {
      if (j.success === false) return null
      const conn = obj(j.connection)
      return {
        ip: text(j.ip), country: text(j.country), countryCode: text(j.country_code),
        region: text(j.region), city: text(j.city),
        isp: text(conn.isp) || text(conn.org), asn: asn(conn.asn), source: 'ipwho.is',
      }
    },
  },
  {
    name: 'ipapi.is',
    url: 'https://api.ipapi.is/',
    parse: (j) => {
      const company = obj(j.company)
      const location = obj(j.location)
      const asnInfo = obj(j.asn)
      return {
        ip: text(j.ip),
        country: text(location.country) || text(j.country),
        countryCode: text(location.country_code),
        region: text(location.state) || text(j.region),
        city: text(location.city) || text(j.city),
        isp: text(company.name) || text(j.company) || text(asnInfo.org),
        asn: asn(asnInfo.asn) || asn(j.asn),
        source: 'ipapi.is',
      }
    },
  },
]

export async function fetchIpInfo(signal?: AbortSignal): Promise<IpInfo> {
  if (isMock) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    return {
      ip: '203.0.113.42', country: 'Japan', countryCode: 'JP', region: 'Tokyo', city: 'Tokyo',
      isp: 'Example Transit', asn: 'AS64500', source: 'mock',
    }
  }
  const errors: string[] = []
  for (const provider of PROVIDERS) {
    if (signal?.aborted) break
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort)
    const timer = setTimeout(abort, 6000)
    try {
      const res = await fetch(provider.url, { cache: 'no-store', signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const info = provider.parse(obj(await res.json()))
      if (info?.ip) return info
      throw new Error('响应缺少 IP')
    } catch (error) {
      errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  throw new Error(signal?.aborted ? '已取消' : `出口 IP 查询失败(${errors.join('; ')})`)
}

/** 隐私遮罩: IPv4 保留前两段, IPv6 保留前两组 */
export function maskIp(ip: string): string {
  if (ip.includes(':')) return `${ip.split(':').slice(0, 2).join(':')}:****`
  const parts = ip.split('.')
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.*.*` : ip
}
