import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import './RouteMap.css'
import Globe from 'globe.gl'
// @ts-expect-error local workspace does not ship three type declarations
import * as THREE from 'three'
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
  (worldData as unknown as TopoTopology<Objects>).objects['countries']!,
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

interface RouteStyle {
  line: string
  glow: string
  plane: string
}

interface RouteRegion extends RegionTraffic {
  style: RouteStyle
  lineWidth: number
  planeDuration: number
  planePhase: number
}

interface FlatRoute extends RouteRegion {
  x: number
  y: number
  linePath: string
  planePath: string
}

interface GlobePlaneDatum {
  code: string
  lat: number
  lng: number
  altitude: number
  color: string
  progress: number
  scale: number
  targetLat: number
  targetLng: number
}

/** HTML 标签数据要求对象身份稳定(three-globe 按身份 diff, 否则每帧重建 DOM) */
interface LabelDatum {
  code: string
  name: string
  lat: number
  lng: number
}
const ORIGIN_LABEL: LabelDatum = { code: '__origin', name: '入口 · 本机', lat: ORIGIN.lat, lng: ORIGIN.lng }
const LABEL_CACHE = new Map<string, LabelDatum>()

const ROUTE_STYLES: RouteStyle[] = [
  { line: '#0A84FF', glow: 'rgba(10,132,255,.32)', plane: '#FFD60A' },
  { line: '#64D2FF', glow: 'rgba(100,210,255,.30)', plane: '#FFF3A6' },
  { line: '#34C759', glow: 'rgba(52,199,89,.28)', plane: '#E7FFE9' },
  { line: '#FF9F0A', glow: 'rgba(255,159,10,.30)', plane: '#FFE3B1' },
  { line: '#FF375F', glow: 'rgba(255,55,95,.28)', plane: '#FFD1DC' },
  { line: '#BF5AF2', glow: 'rgba(191,90,242,.30)', plane: '#F1D6FF' },
  { line: '#5E5CE6', glow: 'rgba(94,92,230,.32)', plane: '#DCD9FF' },
  { line: '#30D158', glow: 'rgba(48,209,88,.26)', plane: '#DFFFE6' },
] as const

function hashCode(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

function pickRouteStyle(code: string): RouteStyle {
  return ROUTE_STYLES[hashCode(code) % ROUTE_STYLES.length]
}

function toUnitVector(lat: number, lng: number): [number, number, number] {
  const latRad = (lat * Math.PI) / 180
  const lngRad = (lng * Math.PI) / 180
  const cosLat = Math.cos(latRad)
  return [
    cosLat * Math.cos(lngRad),
    Math.sin(latRad),
    cosLat * Math.sin(lngRad),
  ]
}

function fromUnitVector([x, y, z]: [number, number, number]): { lat: number; lng: number } {
  const length = Math.hypot(x, y, z) || 1
  return {
    lat: (Math.asin(y / length) * 180) / Math.PI,
    lng: (Math.atan2(z / length, x / length) * 180) / Math.PI,
  }
}

function interpolateGreatCircle(
  start: { lat: number; lng: number },
  end: { lat: number; lng: number },
  t: number,
): { lat: number; lng: number } {
  const from = toUnitVector(start.lat, start.lng)
  const to = toUnitVector(end.lat, end.lng)
  const dot = Math.min(1, Math.max(-1, from[0] * to[0] + from[1] * to[1] + from[2] * to[2]))
  const omega = Math.acos(dot)

  if (omega < 1e-6) {
    return {
      lat: start.lat + (end.lat - start.lat) * t,
      lng: start.lng + (end.lng - start.lng) * t,
    }
  }

  const sinOmega = Math.sin(omega)
  const a = Math.sin((1 - t) * omega) / sinOmega
  const b = Math.sin(t * omega) / sinOmega
  return fromUnitVector([
    from[0] * a + to[0] * b,
    from[1] * a + to[1] * b,
    from[2] * a + to[2] * b,
  ])
}

function buildPlaneMesh(color: string): any {
  const group = new THREE.Group()
  const bodyMat = new THREE.MeshPhongMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.22,
    shininess: 60,
    transparent: true,
    opacity: 0.96,
  })
  const accentMat = new THREE.MeshPhongMaterial({
    color: 0xf8fbff,
    emissive: 0xffffff,
    emissiveIntensity: 0.1,
    shininess: 90,
    transparent: true,
    opacity: 0.92,
  })

  const fuselage = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.07, 0.72, 10),
    bodyMat,
  )
  fuselage.rotation.x = -Math.PI / 2
  group.add(fuselage)

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.09, 0.26, 10),
    bodyMat,
  )
  nose.rotation.x = -Math.PI / 2
  nose.position.z = -0.47
  group.add(nose)

  const wing = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.024, 0.18),
    accentMat,
  )
  wing.position.z = 0.01
  group.add(wing)

  const tailWing = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.018, 0.12),
    accentMat,
  )
  tailWing.position.z = 0.24
  tailWing.position.y = 0.035
  group.add(tailWing)

  const tailFin = new THREE.Mesh(
    new THREE.BoxGeometry(0.022, 0.14, 0.12),
    accentMat,
  )
  tailFin.position.z = 0.24
  tailFin.position.y = 0.07
  group.add(tailFin)

  group.userData = {
    bodyMat,
    accentMat,
  }
  group.scale.setScalar(0.72)
  return group
}

function syncPlaneMeshAppearance(obj: any, color: string, scale: number): void {
  const mats = obj.userData as {
    bodyMat?: any
    accentMat?: any
  }
  mats.bodyMat?.color.set(color)
  mats.bodyMat?.emissive.set(color)
  if (mats.bodyMat) mats.bodyMat.emissiveIntensity = 0.22
  mats.accentMat?.color.set(0xf8fbff)
  mats.accentMat?.emissive.set(0xffffff)
  if (mats.accentMat) mats.accentMat.emissiveIntensity = 0.1
  obj.scale.setScalar(scale)
}

function updatePlaneMesh(globe: any, obj: any, datum: GlobePlaneDatum): void {
  const current = globe.getCoords(datum.lat, datum.lng, datum.altitude)
  const nextProgress = Math.min(0.999, datum.progress + 0.02)
  const nextGeo = interpolateGreatCircle(
    { lat: datum.targetLat, lng: datum.targetLng },
    ORIGIN,
    nextProgress,
  )
  const nextAltitude = 0.038 + Math.sin(nextProgress * Math.PI) * 0.17
  const next = globe.getCoords(nextGeo.lat, nextGeo.lng, nextAltitude)

  obj.position.set(current.x, current.y, current.z)
  obj.up.set(current.x, current.y, current.z).normalize()
  obj.lookAt(next.x, next.y, next.z)
  syncPlaneMeshAppearance(obj, datum.color, datum.scale)
}

/** 球面主题配色: 浅色=蓝色海洋球, 深色=暗夜科技球 */
const GLOBE_THEMES = {
  light: {
    globe: '#2468c4',
    hex: 'rgba(255,255,255,0.82)',
    atmosphere: '#8fc0ff',
  },
  dark: {
    globe: '#15151a',
    hex: 'rgba(125,165,255,0.32)',
    atmosphere: '#3a7bd5',
  },
} as const

export default function RouteMap() {
  const connections = useLiveStore((s) => s.connections)
  const theme = useAppStore((s) => s.settings.theme)
  // system 主题跟随 OS 明暗切换
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
  const globePlaneFrameRef = useRef<number | null>(null)
  const globePlaneCacheRef = useRef<Map<string, GlobePlaneDatum>>(new Map())

  useEffect(() => startLiveStreams(), [])

  /* 活跃连接 → 出口地区流量聚合 */
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
  const routeRegions = useMemo<RouteRegion[]>(
    () => regions.map((r) => {
      const hash = hashCode(r.code)
      return {
        ...r,
        style: pickRouteStyle(r.code),
        lineWidth: 0.35 + (r.bytes / maxBytes) * 1.1,
        planeDuration: 8 + ((hash >> 2) % 5),
        planePhase: (hash % 100) / 100,
      }
    }),
    [regions, maxBytes],
  )

  /* 标签数据: 地区集合不变时保持对象/数组身份稳定 */
  const labelKey = routeRegions.map((r) => r.code).join(',')
  const labels = useMemo<LabelDatum[]>(
    () => [
      ORIGIN_LABEL,
      ...routeRegions.map((r) => {
        let l = LABEL_CACHE.get(r.code)
        if (!l) {
          l = { code: r.code, name: r.name, lat: r.lat, lng: r.lng }
          LABEL_CACHE.set(r.code, l)
        }
        return l
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- regions 身份每帧变化, 以地区集合为准
    [labelKey],
  )

  /* ---------------- 3D 球面视图 ---------------- */
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
      if (globePlaneFrameRef.current !== null) {
        window.cancelAnimationFrame(globePlaneFrameRef.current)
        globePlaneFrameRef.current = null
      }
      globeRef.current = null
      globe._destructor()
      el.innerHTML = ''
    }
  }, [view, resolvedTheme])

  /* 球面数据更新(弧线/端点随连接刷新) */
  useEffect(() => {
    const globe = globeRef.current
    if (!globe) return
    if (globePlaneFrameRef.current !== null) {
      window.cancelAnimationFrame(globePlaneFrameRef.current)
      globePlaneFrameRef.current = null
    }

    const planeCache = globePlaneCacheRef.current
    const activeCodes = new Set(routeRegions.map((r) => r.code))
    for (const code of [...planeCache.keys()]) {
      if (!activeCodes.has(code)) planeCache.delete(code)
    }

    const planeData = routeRegions.map((r) => {
      let datum = planeCache.get(r.code)
      if (!datum) {
        datum = {
          code: r.code,
          lat: r.lat,
          lng: r.lng,
          altitude: 0.038,
          color: r.style.plane,
          progress: 0,
          scale: 0.72,
          targetLat: r.lat,
          targetLng: r.lng,
        }
        planeCache.set(r.code, datum)
      }
      datum.color = r.style.plane
      datum.scale = 0.62 + (r.bytes / maxBytes) * 0.24
      datum.targetLat = r.lat
      datum.targetLng = r.lng
      return datum
    })

    const syncPlaneData = (now: number): void => {
      planeData.forEach((datum, index) => {
        const route = routeRegions[index]
        const progress = ((now / (route.planeDuration * 1000)) + route.planePhase) % 1
        const geo = interpolateGreatCircle(
          { lat: route.lat, lng: route.lng },
          ORIGIN,
          progress,
        )
        datum.progress = progress
        datum.lat = geo.lat
        datum.lng = geo.lng
        datum.altitude = 0.038 + Math.sin(progress * Math.PI) * 0.17
        datum.color = route.style.plane
        datum.scale = 0.62 + (route.bytes / maxBytes) * 0.24
      })
      globe.customLayerData([...planeData])
    }

    globe
      .arcsData(
        routeRegions.map((r) => ({
          startLat: r.lat,
          startLng: r.lng,
          endLat: ORIGIN.lat,
          endLng: ORIGIN.lng,
          weight: r.bytes,
          lineWidth: r.lineWidth,
          color: [r.style.line, r.style.plane],
          duration: r.planeDuration * 1000,
          gap: r.planePhase,
        })),
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .arcColor((d: any) => d.color)
      .arcAltitudeAutoScale(0.42)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .arcStroke((d: any) => d.lineWidth ?? (0.35 + (d.weight / maxBytes) * 1.1))
      .arcDashLength(0.45)
      .arcDashGap(0.9)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .arcDashInitialGap((d: any) => d.gap)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .arcDashAnimateTime((d: any) => d.duration)
      .pointsData([
        { ...ORIGIN, size: 0.9, color: '#FF9F0A' },
        ...routeRegions.map((r) => ({
          ...r,
          size: 0.5 + (r.bytes / maxBytes) * 0.9,
          color: r.style.line,
        })),
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .pointColor((d: any) => d.color)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .pointRadius((d: any) => d.size * 0.45)
      .pointAltitude(0.012)
      .htmlTransitionDuration(0)
      // 文字标签走 HTML 层: three.js 内置字体无中文字形(会渲染成 ??);
      // CSS2DRenderer 每帧覆写外层 transform, 偏移要做在内层元素上
      .htmlElementsData(labels)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .htmlLat((d: any) => d.lat)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .htmlLng((d: any) => d.lng)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .htmlAltitude((d: any) => (d.code === '__origin' ? 0.038 : 0.028))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .htmlElement((d: any) => {
        const wrap = document.createElement('div')
        wrap.className = d.code === '__origin' ? 'globe-label globe-label--origin' : 'globe-label'
        const text = document.createElement('span')
        text.textContent = d.name
        wrap.appendChild(text)
        return wrap
      })
      .customThreeObject((d: GlobePlaneDatum) => buildPlaneMesh(d.color))
      .customThreeObjectUpdate((obj: any, d: GlobePlaneDatum) => {
        updatePlaneMesh(globe, obj, d)
      })
      .customLayerData([...planeData])
    // 转到球背面的标签隐藏(旧版本无此 API 时跳过)
    if (typeof globe.htmlElementVisibilityModifier === 'function') {
      globe.htmlElementVisibilityModifier((label: HTMLElement, isVisible: boolean) => {
        label.style.opacity = isVisible ? '1' : '0'
      })
    }

    const animatePlanes = (): void => {
      syncPlaneData(performance.now())
      globePlaneFrameRef.current = window.requestAnimationFrame(animatePlanes)
    }

    syncPlaneData(performance.now())
    if (planeData.length > 0) {
      globePlaneFrameRef.current = window.requestAnimationFrame(animatePlanes)
    }

    return () => {
      if (globePlaneFrameRef.current !== null) {
        window.cancelAnimationFrame(globePlaneFrameRef.current)
        globePlaneFrameRef.current = null
      }
    }
  }, [routeRegions, labels, maxBytes, view, resolvedTheme])

  /* ---------------- 2D 平面视图 ---------------- */
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
    const routes: FlatRoute[] = routeRegions.map((r) => {
      const [x, y] = projection([r.lng, r.lat]) ?? [0, 0]
      const bend = Math.max(42, Math.min(130, Math.abs(x - origin[0]) * 0.18))
      const my = Math.min(origin[1], y) - bend - 18
      return {
        ...r,
        lineWidth: 1.2 + (r.bytes / maxBytes) * 2.9,
        x,
        y,
        linePath: `M${origin[0]},${origin[1]} Q${(origin[0] + x) / 2},${my} ${x},${y}`,
        planePath: `M${x},${y} Q${(origin[0] + x) / 2},${my} ${origin[0]},${origin[1]}`,
      }
    })
    return { land, origin, routes }
  }, [routeRegions, maxBytes])

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
              <span className="num">{regions.length}</span> 个出口地区 · 实时
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
              <defs />
              {flat.land.map((d, i) => (
                <path className="land" d={d} key={i} />
              ))}
              {flat.routes.map((t) => {
                return (
                  <g key={t.code}>
                    <path
                      className="route-line route-line--glow"
                      d={t.linePath}
                      stroke={t.style.glow}
                      strokeWidth={t.lineWidth + 4}
                      opacity={0.38}
                    />
                    <path
                      className="route-path"
                      id={`rm-plane-path-${t.code}`}
                      d={t.planePath}
                      fill="none"
                    />
                    <path
                      className="route-line"
                      d={t.linePath}
                      stroke={t.style.line}
                      strokeWidth={t.lineWidth}
                      opacity={0.95}
                    />
                    <g className="route-plane">
                      <animateMotion dur={`${t.planeDuration}s`} repeatCount="indefinite" rotate="auto">
                        <mpath href={`#rm-plane-path-${t.code}`} xlinkHref={`#rm-plane-path-${t.code}`} />
                      </animateMotion>
                      <path
                        d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"
                        transform="translate(-12, -12) scale(0.68)"
                        fill={t.style.plane}
                        opacity={0.9}
                      />
                    </g>
                    <circle
                      className="route-node route-node--target"
                      cx={t.x}
                      cy={t.y}
                      r={3 + (t.bytes / maxBytes) * 3}
                      fill={t.style.line}
                    />
                    <text className="route-label" x={t.x + 8} y={t.y + 4}>{t.name}</text>
                    <text className="route-label sub" x={t.x + 8} y={t.y + 16}>{fmtBytes(t.bytes)}</text>
                  </g>
                )
              })}
              <circle className="route-node route-node--origin" cx={flat.origin[0]} cy={flat.origin[1]} r={5} />
              <text className="route-label route-label--origin" x={flat.origin[0] + 9} y={flat.origin[1] + 4}>入口 · 本机</text>
            </svg>
          )}
          {regions.length === 0 && <div className="empty">暂无经代理出站的活跃连接</div>}
        </div>
        <div className="map-legend">
          {routeRegions.slice(0, 8).map((r) => (
            <span
              className="lg"
              key={r.code}
              style={{ '--route-color': r.style.line } as CSSProperties}
            >
              <i />
              {r.name} <b>{fmtBytes(r.bytes)}</b>
            </span>
          ))}
          <span className="lg-hint">线宽 ∝ 累计流量 · 拖拽旋转 / 滚轮缩放</span>
        </div>
      </Card>
    </div>
  )
}
