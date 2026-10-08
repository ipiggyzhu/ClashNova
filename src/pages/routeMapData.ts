import * as topojson from 'topojson-client'
import type { Topology as TopoTopology, Objects } from 'topojson-specification'
import type { FeatureCollection, Geometry } from 'geojson'
import worldData from 'world-atlas/countries-110m.json'
import type { ConnectionsPayload } from '../types/clash'

/* ---------------- 地理数据 ---------------- */

export const LAND: FeatureCollection<Geometry> = topojson.feature(
  worldData as unknown as TopoTopology<Objects>,
  (worldData as unknown as TopoTopology<Objects>).objects.countries!,
) as unknown as FeatureCollection<Geometry>

/** 本机出发点(默认上海; GeoIP mmdb 精确定位列 M4) */
export const ORIGIN = { name: 'Local', lat: 31.23, lng: 121.47 }

/** 出口地区识别表: 节点名匹配 → 经纬度 */
const REGIONS: { code: string; name: string; lat: number; lng: number; match: RegExp }[] = [
  { code: 'HK', name: 'Hong Kong', lat: 22.32, lng: 114.17, match: /HK|香港|🇭🇰|Hong ?Kong/i },
  { code: 'TW', name: 'Taiwan', lat: 25.03, lng: 121.57, match: /TW|台湾|🇹🇼|Taiwan/i },
  { code: 'JP', name: 'Japan', lat: 35.68, lng: 139.69, match: /JP|日本|🇯🇵|Japan|Tokyo/i },
  { code: 'SG', name: 'Singapore', lat: 1.35, lng: 103.82, match: /SG|新加坡|🇸🇬|Singapore/i },
  { code: 'KR', name: 'South Korea', lat: 37.57, lng: 126.98, match: /KR|韩国|🇰🇷|Korea|Seoul/i },
  { code: 'US', name: 'United States', lat: 37.77, lng: -122.42, match: /US|美国|🇺🇸|United States|America/i },
  { code: 'DE', name: 'Germany', lat: 50.11, lng: 8.68, match: /DE|德国|🇩🇪|German|Frankfurt/i },
  { code: 'GB', name: 'United Kingdom', lat: 51.51, lng: -0.13, match: /UK|GB|英国|🇬🇧|London/i },
  { code: 'FR', name: 'France', lat: 48.86, lng: 2.35, match: /FR|法国|🇫🇷|France|Paris/i },
  { code: 'NL', name: 'Netherlands', lat: 52.37, lng: 4.9, match: /NL|荷兰|🇳🇱|Netherlands/i },
  { code: 'RU', name: 'Russia', lat: 55.76, lng: 37.62, match: /RU|俄罗斯|🇷🇺|Russia|Moscow/i },
  { code: 'IN', name: 'India', lat: 19.08, lng: 72.88, match: /IN\b|印度|🇮🇳|India|Mumbai/i },
  { code: 'AU', name: 'Australia', lat: -33.87, lng: 151.21, match: /AU|澳大利亚|🇦🇺|Australia|Sydney/i },
  { code: 'CA', name: 'Canada', lat: 43.65, lng: -79.38, match: /CA\b|加拿大|🇨🇦|Canada/i },
  { code: 'TR', name: 'Turkey', lat: 41.01, lng: 28.98, match: /TR|土耳其|🇹🇷|Turkey|Istanbul/i },
  { code: 'MY', name: 'Malaysia', lat: 3.14, lng: 101.69, match: /MY|马来西亚|🇲🇾|Malaysia/i },
  { code: 'BR', name: 'Brazil', lat: -23.55, lng: -46.63, match: /BR|巴西|🇧🇷|Brazil/i },
]
const REGION_ORDER = new Map(REGIONS.map((region, index) => [region.code, index]))

export interface RegionTraffic {
  code: string
  name: string
  lat: number
  lng: number
  bytes: number
  color: string
}

const ROUTE_COLORS = ['#0A84FF', '#32D74B', '#FF9F0A', '#BF5AF2', '#FF375F', '#64D2FF', '#FFD60A', '#30D158']
export const FLIGHT_DURATION_MS = 11200
export const FLIGHT_END_HOLD_MS = 0
export const FLIGHT_STAGGER_MS = 700

function routeColor(code: string): string {
  const hash = [...code].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 0)
  return ROUTE_COLORS[hash % ROUTE_COLORS.length]
}

export function buildRegionsFromConnections(payload: ConnectionsPayload): RegionTraffic[] {
  const acc = new Map<string, RegionTraffic>()
  for (const c of payload.connections) {
    // mihomo chains 原始顺序为出口节点在前、入口组在后。
    const exit = c.chains[0] ?? ''
    if (!exit || exit === 'DIRECT' || exit === 'REJECT') continue
    const region = REGIONS.find((r) => r.match.test(exit))
    if (!region) continue
    const slot = acc.get(region.code) ?? { ...region, bytes: 0, color: routeColor(region.code) }
    slot.bytes += c.upload + c.download
    acc.set(region.code, slot)
  }
  return [...acc.values()].sort(
    (a, b) => (REGION_ORDER.get(a.code) ?? 999) - (REGION_ORDER.get(b.code) ?? 999),
  )
}

export function sameRegionSnapshot(a: RegionTraffic[], b: RegionTraffic[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].code !== b[i].code || a[i].bytes !== b[i].bytes) return false
  }
  return true
}
