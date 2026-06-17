import { useEffect, useMemo, useRef, useState } from 'react'
import './RouteMap.css'
import Globe from 'globe.gl'
import { geoEquirectangular, geoPath } from 'd3-geo'
import * as topojson from 'topojson-client'
import type { Topology as TopoTopology, Objects } from 'topojson-specification'
import type { FeatureCollection, Geometry } from 'geojson'
import worldData from 'world-atlas/countries-110m.json'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Seg from '../components/ui/Seg'
import { useAppStore } from '../stores/app'
import { startLiveStreams, useLiveStore } from '../stores/live'
import { fmtBytes } from '../utils/format'

/* ---------------- 地理数据 ---------------- */

const LAND: FeatureCollection<Geometry> = topojson.feature(
  worldData as unknown as TopoTopology<Objects>,
  (worldData as unknown as TopoTopology<Objects>).objects.countries!,
) as unknown as FeatureCollection<Geometry>

/** 本机出发点(默认上海; GeoIP mmdb 精确定位列 M4) */
const ORIGIN = { name: '本机', lat: 31.23, lng: 121.47 }

/** 出口地区识别表: 节点名匹配 → 经纬度 */
const REGIONS: { code: string; name: string; lat: number; lng: number; match: RegExp }[] = [
  { code: 'HK', name: '香港', lat: 22.32, lng: 114.17, match: /HK|香港|🇭🇰|Hong ?Kong/i },
  { code: 'TW', name: '台湾', lat: 25.03, lng: 121.57, match: /TW|台湾|🇹🇼|Taiwan/i },
  { code: 'JP', name: '日本', lat: 35.68, lng: 139.69, match: /JP|日本|🇯🇵|Japan|Tokyo/i },
  { code: 'SG', name: '新加坡', lat: 1.35, lng: 103.82, match: /SG|新加坡|🇸🇬|Singapore/i },
  { code: 'KR', name: '韩国', lat: 37.57, lng: 126.98, match: /KR|韩国|🇰🇷|Korea|Seoul/i },
  { code: 'US', name: '美国', lat: 37.77, lng: -122.42, match: /US|美国|🇺🇸|United States|America/i },
  { code: 'DE', name: '德国', lat: 50.11, lng: 8.68, match: /DE|德国|🇩🇪|German|Frankfurt/i },
  { code: 'GB', name: '英国', lat: 51.51, lng: -0.13, match: /UK|GB|英国|🇬🇧|London/i },
  { code: 'FR', name: '法国', lat: 48.86, lng: 2.35, match: /FR|法国|🇫🇷|France|Paris/i },
  { code: 'NL', name: '荷兰', lat: 52.37, lng: 4.9, match: /NL|荷兰|🇳🇱|Netherlands/i },
  { code: 'RU', name: '俄罗斯', lat: 55.76, lng: 37.62, match: /RU|俄罗斯|🇷🇺|Russia|Moscow/i },
  { code: 'IN', name: '印度', lat: 19.08, lng: 72.88, match: /IN\b|印度|🇮🇳|India|Mumbai/i },
  { code: 'AU', name: '澳大利亚', lat: -33.87, lng: 151.21, match: /AU|澳大利亚|🇦🇺|Australia|Sydney/i },
  { code: 'CA', name: '加拿大', lat: 43.65, lng: -79.38, match: /CA\b|加拿大|🇨🇦|Canada/i },
  { code: 'TR', name: '土耳其', lat: 41.01, lng: 28.98, match: /TR|土耳其|🇹🇷|Turkey|Istanbul/i },
  { code: 'MY', name: '马来西亚', lat: 3.14, lng: 101.69, match: /MY|马来西亚|🇲🇾|Malaysia/i },
  { code: 'BR', name: '巴西', lat: -23.55, lng: -46.63, match: /BR|巴西|🇧🇷|Brazil/i },
]

interface RegionTraffic {
  code: string
  name: string
  lat: number
  lng: number
  bytes: number
}

/** HTML 标签数据要求对象身份稳定(three-globe 按身份 diff, 否则每帧重建 DOM) */
interface LabelDatum {
  code: string
  name: string
  lat: number
  lng: number
}

const ORIGIN_LABEL: LabelDatum = { code: '__origin', name: '本机', lat: ORIGIN.lat, lng: ORIGIN.lng }
const LABEL_CACHE = new Map<string, LabelDatum>()

/** 球面主题配色: 浅色=蓝色海洋球, 深色=暗夜科技球 */
const GLOBE_THEMES = {
  light: {
    globe: '#2468c4',
    hex: 'rgba(255,255,255,0.82)',
    atmosphere: '#8fc0ff',
    arc: ['#FFD60A', '#64D2FF'],
    point: '#eaf4ff',
  },
  dark: {
    globe: '#15151a',
    hex: 'rgba(125,165,255,0.32)',
    atmosphere: '#3a7bd5',
    arc: ['#0A84FF', '#64D2FF'],
    point: '#64D2FF',
  },
} as const

export default function RouteMap() {
  const connections = useLiveStore((s) => s.connections)
  const theme = useAppStore((s) => s.settings.theme)
  const [sysLight, setSysLight] = useState(
    () => window.matchMedia('(prefers-color-scheme: light)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (e: MediaQueryListEvent): void => setSysLight(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolvedTheme: 'dark' | 'light' =
    theme === 'system' ? (sysLight ? 'light' : 'dark') : theme
  const [view, setView] = useState<'globe' | 'flat'>(
    new URLSearchParams(location.search).get('view') === 'flat' ? 'flat' : 'globe',
  )
  const hostRef = useRef<HTMLDivElement | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globeRef = useRef<any>(null)

  useEffect(() => startLiveStreams(), [])

  const regions = useMemo<RegionTraffic[]>(() => {
    const acc = new Map<string, RegionTraffic>()
    for (const c of connections.connections) {
      const exit = c.chains[0] ?? ''
      if (!exit || exit === 'DIRECT' || exit === 'REJECT') continue
      const region = REGIONS.find((r) => r.match.test(exit))
      if (!region) continue
      const slot = acc.get(region.code) ?? { ...region, bytes: 0 }
      slot.bytes += c.upload + c.download
      acc.set(region.code, slot)
    }
    return [...acc.values()].sort((a, b) => b.bytes - a.bytes)
  }, [connections.connections])

  const maxBytes = Math.max(1, ...regions.map((r) => r.bytes))

  const labelKey = regions.map((r) => r.code).join(',')
  const labels = useMemo<LabelDatum[]>(
    () => [
      ORIGIN_LABEL,
      ...regions.map((r) => {
        let l = LABEL_CACHE.get(r.code)
        if (!l) {
          l = { code: r.code, name: r.name, lat: r.lat, lng: r.lng }
          LABEL_CACHE.set(r.code, l)
        }
        return l
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labelKey],
  )

  useEffect(() => {
    if (view !== 'globe' || !hostRef.current) return
    const el = hostRef.current
    const pal = GLOBE_THEMES[resolvedTheme]
    const globe = new Globe(el, { animateIn: true })
      .backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true)
      .atmosphereColor(pal.atmosphere)
      .atmosphereAltitude(0.16)
      .hexPolygonsData(LAND.features)
      .hexPolygonResolution(3)
      .hexPolygonMargin(0.6)
      .hexPolygonColor(() => pal.hex)
      .width(el.clientWidth)
      .height(el.clientHeight)

    globe.globeMaterial().color.set(pal.globe)
    globe.controls().autoRotate = true
    globe.controls().autoRotateSpeed = 0.55
    globe.pointOfView({ lat: 24, lng: 110, altitude: 1.85 }, 0)
    globeRef.current = globe

    const ro = new ResizeObserver(() => {
      globe.width(el.clientWidth).height(el.clientHeight)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      globeRef.current = null
      globe._destructor()
      el.innerHTML = ''
    }
  }, [view, resolvedTheme])

  useEffect(() => {
    const globe = globeRef.current
    if (!globe) return
    const pal = GLOBE_THEMES[resolvedTheme]

    const arcMidpoints = regions.map((r) => {
      const midLat = (ORIGIN.lat + r.lat) / 2
      const midLng = (ORIGIN.lng + r.lng) / 2
      return {
        code: `plane-${r.code}`,
        name: '✈️',
        lat: midLat,
        lng: midLng,
        isPlane: true,
      }
    })

    globe
      .arcsData(
        regions.map((r) => ({
          startLat: ORIGIN.lat,
          startLng: ORIGIN.lng,
          endLat: r.lat,
          endLng: r.lng,
          weight: r.bytes,
        })),
      )
      .arcColor(() => [...pal.arc])
      .arcAltitudeAutoScale(0.42)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .arcStroke((d: any) => 0.35 + (d.weight / maxBytes) * 1.1)
      .arcDashLength(0.45)
      .arcDashGap(0.9)
      .arcDashAnimateTime(2400)
      .pointsData([
        { ...ORIGIN, size: 0.9, color: '#FF9F0A' },
        ...regions.map((r) => ({
          ...r,
          size: 0.5 + (r.bytes / maxBytes) * 0.9,
          color: pal.point,
        })),
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .pointColor((d: any) => d.color)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .pointRadius((d: any) => d.size * 0.45)
      .pointAltitude(0.012)
      .htmlElementsData([...labels, ...arcMidpoints])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .htmlElement((d: any) => {
        const wrap = document.createElement('div')
        if (d.isPlane) {
          wrap.className = 'globe-plane'
          wrap.textContent = '✈️'
        } else {
          wrap.className = d.code === '__origin' ? 'globe-label globe-label--origin' : 'globe-label'
          const text = document.createElement('span')
          text.textContent = d.name
          wrap.appendChild(text)
        }
        return wrap
      })
      .htmlAltitude(0.025)

    if (typeof globe.htmlElementVisibilityModifier === 'function') {
      globe.htmlElementVisibilityModifier((label: HTMLElement, isVisible: boolean) => {
        label.style.opacity = isVisible ? '1' : '0'
      })
    }
  }, [regions, labels, maxBytes, view, resolvedTheme])

  const FLAT_W = 1100
  const FLAT_H = 540
  const flat = useMemo(() => {
    const projection = geoEquirectangular().fitExtent(
      [
        [10, 10],
        [FLAT_W - 10, FLAT_H - 10],
      ],
      LAND,
    )
    const path = geoPath(projection)
    const land = LAND.features.map((f) => path(f) ?? '').filter(Boolean)
    const origin = projection([ORIGIN.lng, ORIGIN.lat]) ?? [0, 0]
    const targets = regions.map((r) => {
      const [x, y] = projection([r.lng, r.lat]) ?? [0, 0]
      return { ...r, x, y }
    })
    return { land, origin, targets }
  }, [regions])

  return (
    <div className="pg-routemap">
      <Card
        className="map-card"
        icon={<Icon name="routemap" />}
        iconColor="var(--cyan)"
        title="路由地图"
        actions={
          <>
            <span className="chip">
              <span className="num">{regions.length}</span> 个目的地区域 · 实时
            </span>
            <Seg
              items={[
                { value: 'globe', label: '球面视图' },
                { value: 'flat', label: '平面视图' },
              ]}
              value={view}
              onChange={(v) => setView(v as 'globe' | 'flat')}
            />
          </>
        }
        flush
      >
        <div className="map-body">
          {view === 'globe' ? (
            <div className="globe-host" ref={hostRef} />
          ) : (
            <svg
              className="flat-svg"
              viewBox={`0 0 ${FLAT_W} ${FLAT_H}`}
              preserveAspectRatio="xMidYMid meet"
            >
              <defs>
                <linearGradient id="rm-arc" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stopColor="#0A84FF" />
                  <stop offset="1" stopColor="#64D2FF" />
                </linearGradient>
              </defs>
              {flat.land.map((d, i) => (
                <path className="land" d={d} key={i} />
              ))}
              {flat.targets.map((t) => {
                const [ox, oy] = flat.origin
                const mx = (ox + t.x) / 2
                const my = Math.min(oy, t.y) - Math.abs(t.x - ox) * 0.18 - 26
                const angle = Math.atan2(t.y - oy, t.x - ox) * (180 / Math.PI)
                return (
                  <g key={t.code}>
                    <path
                      d={`M${ox},${oy} Q${mx},${my} ${t.x},${t.y}`}
                      fill="none"
                      stroke="url(#rm-arc)"
                      strokeWidth={1 + (t.bytes / maxBytes) * 2.4}
                      strokeLinecap="round"
                      opacity={0.8}
                    />
                    <g transform={`translate(${mx}, ${my}) rotate(${angle}) scale(0.7)`}>
                      <path
                        d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"
                        transform="translate(-12, -12)"
                        fill="#FFD60A"
                        opacity={0.9}
                      />
                    </g>
                    <circle cx={t.x} cy={t.y} r={3 + (t.bytes / maxBytes) * 3} fill="#64D2FF" />
                    <text x={t.x + 8} y={t.y + 4}>{t.name}</text>
                    <text className="sub" x={t.x + 8} y={t.y + 16}>{fmtBytes(t.bytes)}</text>
                  </g>
                )
              })}
              <circle cx={flat.origin[0]} cy={flat.origin[1]} r={5} fill="#FF9F0A" />
              <text x={flat.origin[0] + 9} y={flat.origin[1] + 4}>本机</text>
            </svg>
          )}
          {regions.length === 0 && <div className="empty">暂无经代理出站的活跃连接</div>}
        </div>
        <div className="map-legend">
          {regions.slice(0, 8).map((r) => (
            <span className="lg" key={r.code}>
              <i />
              {r.name} <b>{fmtBytes(r.bytes)}</b>
            </span>
          ))}
          <span className="lg-hint">弧线宽度 ∝ 累计流量 · 拖拽旋转 / 滚轮缩放</span>
        </div>
      </Card>
    </div>
  )
}
