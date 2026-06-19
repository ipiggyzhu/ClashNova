import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import './RouteMap.css'
import Globe from 'globe.gl'
import { geoEquirectangular, geoInterpolate, geoPath } from 'd3-geo'
import * as THREE from 'three'
import * as topojson from 'topojson-client'
import type { Topology as TopoTopology, Objects } from 'topojson-specification'
import type { FeatureCollection, Geometry } from 'geojson'
import worldData from 'world-atlas/countries-110m.json'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Seg from '../components/ui/Seg'
import { useAppStore } from '../stores/app'
import { startLiveStreams, useLiveStore } from '../stores/live'
import type { ConnectionsPayload } from '../types/clash'
import { fmtBytes } from '../utils/format'

/* ---------------- 地理数据 ---------------- */

const LAND: FeatureCollection<Geometry> = topojson.feature(
  worldData as unknown as TopoTopology<Objects>,
  (worldData as unknown as TopoTopology<Objects>).objects.countries!,
) as unknown as FeatureCollection<Geometry>

/** 本机出发点(默认上海; GeoIP mmdb 精确定位列 M4) */
const ORIGIN = { name: 'Local', lat: 31.23, lng: 121.47 }

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

interface RegionTraffic {
  code: string
  name: string
  lat: number
  lng: number
  bytes: number
  color: string
}

interface RoutePoint {
  lat: number
  lng: number
  alt: number
}

interface RoutePath {
  code: string
  name: string
  color: string
  weight: number
  points: RoutePoint[]
}

/** HTML 标签数据要求对象身份稳定(three-globe 按身份 diff, 否则每帧重建 DOM) */
interface LabelDatum {
  code: string
  name: string
  lat: number
  lng: number
  altitude?: number
  nextLat?: number
  nextLng?: number
  nextAltitude?: number
  color?: string
  size?: number
  bearing?: number
  isPlane?: boolean
  isPoint?: boolean
}

const ORIGIN_LABEL: LabelDatum = { code: '__origin', name: ORIGIN.name, lat: ORIGIN.lat, lng: ORIGIN.lng }
const LABEL_CACHE = new Map<string, LabelDatum>()
const PLANE_CACHE = new Map<string, LabelDatum>()
const POINT_CACHE = new Map<string, LabelDatum>()
const PLANE_TEXTURE_CACHE = new Map<string, THREE.CanvasTexture>()
const POINT_TEXTURE_CACHE = new Map<string, THREE.CanvasTexture>()
const ROUTE_COLORS = ['#0A84FF', '#32D74B', '#FF9F0A', '#BF5AF2', '#FF375F', '#64D2FF', '#FFD60A', '#30D158']
const ROUTE_SAMPLE_COUNT = 80
const FLIGHT_DURATION_MS = 11200
const FLIGHT_END_HOLD_MS = 0
const FLIGHT_STAGGER_MS = 700
const MAX_ANIMATION_STEP_MS = 34
const ROUTE_DATA_REFRESH_MS = 1800
const ROUTE_BASE_ALTITUDE = 0.012

function routeColor(code: string): string {
  const hash = [...code].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 0)
  return ROUTE_COLORS[hash % ROUTE_COLORS.length]
}

function buildRegionsFromConnections(payload: ConnectionsPayload): RegionTraffic[] {
  const acc = new Map<string, RegionTraffic>()
  for (const c of payload.connections) {
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

function sameRegionSnapshot(a: RegionTraffic[], b: RegionTraffic[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].code !== b[i].code || a[i].bytes !== b[i].bytes) return false
  }
  return true
}

function toRad(n: number): number {
  return (n * Math.PI) / 180
}

function routeAltitude(lat: number, lng: number): number {
  const dLat = toRad(lat - ORIGIN.lat)
  const dLng = toRad(lng - ORIGIN.lng)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(ORIGIN.lat)) * Math.cos(toRad(lat)) * Math.sin(dLng / 2) ** 2
  const centralAngle = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)))
  return 0.018 + Math.min(0.12, (centralAngle / Math.PI) * 0.14)
}

function flightAltitude(routeArcAltitude: number, phase: number): number {
  return ROUTE_BASE_ALTITUDE + Math.sin(Math.PI * phase) * routeArcAltitude
}

function routeLane(index: number): number {
  const step = Math.floor(index / 2) + 1
  return (index % 2 === 0 ? 1 : -1) * step
}

function buildRoutePath(region: RegionTraffic, index: number): RoutePath {
  const interpolate = geoInterpolate([ORIGIN.lng, ORIGIN.lat], [region.lng, region.lat])
  const dLat = region.lat - ORIGIN.lat
  const dLng = region.lng - ORIGIN.lng
  const dist = Math.hypot(dLat, dLng) || 1
  const perpLat = -dLng / dist
  const perpLng = dLat / dist
  const lane = routeLane(index)
  const offsetDeg = lane * Math.max(1.2, Math.min(5, 32 / (dist + 6)))
  const arcAlt = routeAltitude(region.lat, region.lng)
  const points: RoutePoint[] = []

  for (let i = 0; i <= ROUTE_SAMPLE_COUNT; i += 1) {
    const phase = i / ROUTE_SAMPLE_COUNT
    const [lng, lat] = interpolate(phase)
    const curve = Math.sin(Math.PI * phase) ** 0.72
    points.push({
      lat: lat + perpLat * offsetDeg * curve,
      lng: lng + perpLng * offsetDeg * curve,
      alt: flightAltitude(arcAlt, phase),
    })
  }
  return {
    code: region.code,
    name: region.name,
    color: region.color,
    weight: region.bytes,
    points,
  }
}

function flightPhase(now: number, start: number, index: number, count: number): number {
  const offset = count > 1 ? index * FLIGHT_STAGGER_MS : 0
  const elapsed = (((now - start - offset) % FLIGHT_DURATION_MS) + FLIGHT_DURATION_MS) % FLIGHT_DURATION_MS
  return elapsed / FLIGHT_DURATION_MS
}

function sampleRoute(path: RoutePath, phase: number): { point: RoutePoint; nextPoint: RoutePoint; bearing: number } {
  const clamped = Math.max(0, Math.min(1, phase))
  const scaled = clamped * (path.points.length - 1)
  const idx = Math.min(path.points.length - 2, Math.floor(scaled))
  const t = scaled - idx
  const a = path.points[idx]
  const b = path.points[idx + 1]
  const point = {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
    alt: a.alt + (b.alt - a.alt) * t,
  }
  return {
    point,
    nextPoint: b,
    bearing: (Math.atan2(b.lat - a.lat, b.lng - a.lng) * 180) / Math.PI,
  }
}

function planeTexture(color: string): THREE.CanvasTexture {
  const cached = PLANE_TEXTURE_CACHE.get(color)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 96
  const ctx = canvas.getContext('2d')!
  ctx.translate(48, 48)
  ctx.shadowColor = color
  ctx.shadowBlur = 12
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(26, 0)
  ctx.bezierCurveTo(19, -3.2, 10, -4.6, 1, -4.8)
  ctx.lineTo(-10, -21)
  ctx.bezierCurveTo(-12, -24, -16, -22, -14.5, -18.5)
  ctx.lineTo(-7.5, -4.2)
  ctx.lineTo(-20, -4.8)
  ctx.lineTo(-27, -10)
  ctx.bezierCurveTo(-29, -11.5, -31, -9, -29, -7)
  ctx.lineTo(-18, 0)
  ctx.lineTo(-29, 7)
  ctx.bezierCurveTo(-31, 9, -29, 11.5, -27, 10)
  ctx.lineTo(-20, 4.8)
  ctx.lineTo(-7.5, 4.2)
  ctx.lineTo(-14.5, 18.5)
  ctx.bezierCurveTo(-16, 22, -12, 24, -10, 21)
  ctx.lineTo(1, 4.8)
  ctx.bezierCurveTo(10, 4.6, 19, 3.2, 26, 0)
  ctx.closePath()
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(255,255,255,.45)'
  ctx.beginPath()
  ctx.moveTo(12, 0)
  ctx.bezierCurveTo(6, -1.2, 0, -1.3, -6, -1)
  ctx.lineTo(-2.8, 0)
  ctx.lineTo(-6, 1)
  ctx.bezierCurveTo(0, 1.3, 6, 1.2, 12, 0)
  ctx.closePath()
  ctx.fill()
  const texture = new THREE.CanvasTexture(canvas)
  PLANE_TEXTURE_CACHE.set(color, texture)
  return texture
}

function pointTexture(color: string): THREE.CanvasTexture {
  const cached = POINT_TEXTURE_CACHE.get(color)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.translate(32, 32)
  ctx.shadowColor = color
  ctx.shadowBlur = 12
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(0, 0, 12, 0, Math.PI * 2)
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(255,255,255,.78)'
  ctx.beginPath()
  ctx.arc(-3, -4, 3.2, 0, Math.PI * 2)
  ctx.fill()
  const texture = new THREE.CanvasTexture(canvas)
  POINT_TEXTURE_CACHE.set(color, texture)
  return texture
}

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
  const theme = useAppStore((s) => s.settings.theme)
  const [regions, setRegions] = useState<RegionTraffic[]>(() =>
    buildRegionsFromConnections(useLiveStore.getState().connections),
  )
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
  const globeObjectRef = useRef(new Map<string, THREE.Sprite>())

  useEffect(() => {
    const release = startLiveStreams()
    const refresh = (): void => {
      const nextRegions = buildRegionsFromConnections(useLiveStore.getState().connections)
      startTransition(() => {
        setRegions((prev) => (sameRegionSnapshot(prev, nextRegions) ? prev : nextRegions))
      })
    }
    refresh()
    const timer = window.setInterval(refresh, ROUTE_DATA_REFRESH_MS)
    return () => {
      window.clearInterval(timer)
      release()
    }
  }, [])

  const maxBytes = Math.max(1, ...regions.map((r) => r.bytes))
  const legendRegions = useMemo(
    () => [...regions].sort((a, b) => b.bytes - a.bytes),
    [regions],
  )
  const routePathKey = regions.map((r) => `${r.code}:${r.lat}:${r.lng}:${r.color}`).join('|')
  const routePaths = useMemo<RoutePath[]>(
    () => regions.map((region, index) => buildRoutePath(region, index)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routePathKey],
  )

  const labelKey = regions.map((r) => r.code).join(',')
  const labels = useMemo<LabelDatum[]>(
    () => [
      ORIGIN_LABEL,
      ...regions.map((r) => {
        let l = LABEL_CACHE.get(r.code)
        if (!l) {
          l = { code: r.code, name: r.name, lat: r.lat, lng: r.lng }
          LABEL_CACHE.set(r.code, l)
        } else {
          l.name = r.name
          l.lat = r.lat
          l.lng = r.lng
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
    const globe = new Globe(el, {
      animateIn: true,
      rendererConfig: { antialias: true, alpha: true, powerPreference: 'high-performance' },
    })
      .backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true)
      .atmosphereColor(GLOBE_THEMES[resolvedTheme].atmosphere)
      .atmosphereAltitude(0.16)
      .hexPolygonsData(LAND.features)
      .hexPolygonResolution(3)
      .hexPolygonMargin(0.6)
      .hexPolygonColor(() => GLOBE_THEMES[resolvedTheme].hex)
      .width(el.clientWidth)
      .height(el.clientHeight)

    globe.globeMaterial().color.set(GLOBE_THEMES[resolvedTheme].globe)
    globe.renderer?.().setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1))
    globe.controls().autoRotate = true
    globe.controls().autoRotateSpeed = 0.28
    globe.pointOfView({ lat: 24, lng: 110, altitude: 1.85 }, 0)
    globeRef.current = globe

    const ro = new ResizeObserver(() => {
      globe.width(el.clientWidth).height(el.clientHeight)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      globeRef.current = null
      globeObjectRef.current.clear()
      globe._destructor()
      el.innerHTML = ''
    }
  }, [view, resolvedTheme])

  useEffect(() => {
    const globe = globeRef.current
    if (!globe) return

    globe
      .arcsData([])
      .pathsData(routePaths)
      .pathPoints((d: RoutePath) => d.points)
      .pathPointLat((p: RoutePoint) => p.lat)
      .pathPointLng((p: RoutePoint) => p.lng)
      .pathPointAlt((p: RoutePoint) => p.alt)
      .pathColor((d: RoutePath) => d.color)
      .pathStroke((d: RoutePath) => 0.35 + (d.weight / maxBytes) * 0.65)
      .pathDashLength(1)
      .pathDashGap(0)
      .pathDashAnimateTime(0)
      .pathTransitionDuration(0)
      .pointsData([])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .pointColor((d: any) => d.color)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .pointRadius((d: any) => d.size * 0.45)
      .pointAltitude(ROUTE_BASE_ALTITUDE)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .htmlElement((d: any) => {
        const wrap = document.createElement('div')
        wrap.className = d.code === '__origin' ? 'globe-label globe-label--origin' : 'globe-label'
        const text = document.createElement('span')
        text.textContent = d.name
        wrap.appendChild(text)
        return wrap
      })
      .htmlAltitude((d: any) => d.altitude ?? 0.025)
      .customThreeObject((d: LabelDatum) => {
        if (d.isPoint) {
          const material = new THREE.SpriteMaterial({
            map: pointTexture(d.color ?? '#FF9F0A'),
            transparent: true,
            depthTest: true,
            depthWrite: false,
          })
          const sprite = new THREE.Sprite(material)
          sprite.userData = { current: new THREE.Vector3(), next: new THREE.Vector3() }
          const scale = 2.8 + (d.size ?? 1) * 2.4
          sprite.scale.set(scale, scale, 1)
          globeObjectRef.current.set(d.code, sprite)
          return sprite
        }
        const material = new THREE.SpriteMaterial({
          map: planeTexture(d.color ?? '#FFD60A'),
          transparent: true,
          depthTest: true,
          depthWrite: false,
        })
        material.rotation = toRad(d.bearing ?? 0)
        const sprite = new THREE.Sprite(material)
        sprite.userData = { current: new THREE.Vector3(), next: new THREE.Vector3() }
        sprite.scale.set(7.1, 7.1, 1)
        globeObjectRef.current.set(d.code, sprite)
        return sprite
      })
      .customThreeObjectUpdate((obj: THREE.Object3D, d: LabelDatum) => {
        if (d.isPlane) return
        const coords = globe.getCoords(d.lat, d.lng, d.altitude ?? ROUTE_BASE_ALTITUDE)
        Object.assign(obj.position, coords)
        const material = (obj as THREE.Sprite).material as THREE.SpriteMaterial
        const camera = globe.camera?.()
        if (camera) {
          const cameraPos = camera.position
          const pointLen = Math.hypot(coords.x, coords.y, coords.z)
          const cameraLen = Math.hypot(cameraPos.x, cameraPos.y, cameraPos.z)
          const facing =
            pointLen > 0 &&
            cameraLen > 0 &&
            (coords.x * cameraPos.x + coords.y * cameraPos.y + coords.z * cameraPos.z) /
              (pointLen * cameraLen) >
              -0.015
          obj.visible = facing
          if (!facing) return
        }
        if (d.nextLat !== undefined && d.nextLng !== undefined) {
          const nextCoords = globe.getCoords(d.nextLat, d.nextLng, d.nextAltitude ?? d.altitude ?? ROUTE_BASE_ALTITUDE)
          if (camera) {
            const sprite = obj as THREE.Sprite
            const current = sprite.userData.current as THREE.Vector3
            const next = sprite.userData.next as THREE.Vector3
            current.x = coords.x
            current.y = coords.y
            current.z = coords.z
            next.x = nextCoords.x
            next.y = nextCoords.y
            next.z = nextCoords.z
            current.project(camera)
            next.project(camera)
            const rotation = Math.atan2(next.y - current.y, next.x - current.x)
            if (Number.isFinite(rotation)) material.rotation = rotation
          }
        } else {
          material.rotation = toRad(d.bearing ?? 0)
        }
      })

    if (typeof globe.htmlElementVisibilityModifier === 'function') {
      globe.htmlElementVisibilityModifier((label: HTMLElement, isVisible: boolean) => {
        label.style.opacity = isVisible ? '1' : '0'
      })
    }
    // Route geometry should not be rebuilt on every traffic counter refresh; it makes the planes stutter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routePaths, view, resolvedTheme])

  useEffect(() => {
    if (view !== 'globe' || !globeRef.current) return
    const globe = globeRef.current
    globe.htmlElementsData(labels)

    const pointData = [
      (() => {
        const code = 'point-__origin'
        let point = POINT_CACHE.get(code)
        if (!point) {
          point = {
            code,
            name: ORIGIN.name,
            lat: ORIGIN.lat,
            lng: ORIGIN.lng,
            altitude: ROUTE_BASE_ALTITUDE,
            color: '#FF9F0A',
            size: 0.9,
            isPoint: true,
          }
          POINT_CACHE.set(code, point)
        }
        return point
      })(),
      ...routePaths.map((route) => {
        const lastPoint = route.points[route.points.length - 1]
        const code = `point-${route.code}`
        let point = POINT_CACHE.get(code)
        if (!point) {
          point = {
            code,
            name: route.name,
            lat: lastPoint.lat,
            lng: lastPoint.lng,
            altitude: ROUTE_BASE_ALTITUDE,
            color: route.color,
            size: 0.95,
            isPoint: true,
          }
          POINT_CACHE.set(code, point)
        }
        point.name = route.name
        point.lat = lastPoint.lat
        point.lng = lastPoint.lng
        point.color = route.color
        return point
      }),
    ]

    const planeData = routePaths.map((route, index) => {
      const { point, nextPoint, bearing } = sampleRoute(route, index === 0 ? 0 : 0.001)
      const code = `plane-${route.code}`
      let plane = PLANE_CACHE.get(code)
      if (!plane) {
        plane = {
          code,
          name: 'plane',
          lat: point.lat,
          lng: point.lng,
          altitude: point.alt,
          nextLat: nextPoint.lat,
          nextLng: nextPoint.lng,
          nextAltitude: nextPoint.alt,
          color: route.color,
          bearing,
          isPlane: true,
        }
        PLANE_CACHE.set(code, plane)
      }
      plane.color = route.color
      return plane
    })
    const layerData = [...pointData, ...planeData]
    globe.customLayerData(layerData)

    if (routePaths.length === 0) return

    let animationClock = 0
    let lastFrameTime = 0
    let frame = 0
    let cancelled = false

    const updatePlaneSprite = (plane: LabelDatum, camera: { position: { x: number; y: number; z: number } } | undefined) => {
      const sprite = globeObjectRef.current.get(plane.code)
      if (!sprite) return
      const coords = globe.getCoords(plane.lat, plane.lng, plane.altitude ?? ROUTE_BASE_ALTITUDE)
      Object.assign(sprite.position, coords)
      if (camera) {
        const cameraPos = camera.position
        const pointLen = Math.hypot(coords.x, coords.y, coords.z)
        const cameraLen = Math.hypot(cameraPos.x, cameraPos.y, cameraPos.z)
        const facing =
          pointLen > 0 &&
          cameraLen > 0 &&
          (coords.x * cameraPos.x + coords.y * cameraPos.y + coords.z * cameraPos.z) /
            (pointLen * cameraLen) >
            -0.015
        sprite.visible = facing
        if (!facing) return
      }
      if (plane.nextLat === undefined || plane.nextLng === undefined) return
      const nextCoords = globe.getCoords(
        plane.nextLat,
        plane.nextLng,
        plane.nextAltitude ?? plane.altitude ?? ROUTE_BASE_ALTITUDE,
      )
      const current = sprite.userData.current as THREE.Vector3
      const next = sprite.userData.next as THREE.Vector3
      current.x = coords.x
      current.y = coords.y
      current.z = coords.z
      next.x = nextCoords.x
      next.y = nextCoords.y
      next.z = nextCoords.z
      if (camera) {
        current.project(camera)
        next.project(camera)
        const rotation = Math.atan2(next.y - current.y, next.x - current.x)
        if (Number.isFinite(rotation)) sprite.material.rotation = rotation
      }
    }

    const tick = (now: number) => {
      if (cancelled || globeRef.current !== globe) return
      const rawDelta = lastFrameTime === 0 ? 16.7 : now - lastFrameTime
      lastFrameTime = now
      animationClock += Math.min(Math.max(rawDelta, 0), MAX_ANIMATION_STEP_MS)
      const camera = globe.camera?.()
      for (let index = 0; index < routePaths.length; index += 1) {
        const route = routePaths[index]
        const plane = planeData[index]
        const phase = flightPhase(animationClock, 0, index, routePaths.length)
        const { point, nextPoint, bearing } = sampleRoute(route, phase)
        plane.lat = point.lat
        plane.lng = point.lng
        plane.altitude = point.alt
        plane.nextLat = nextPoint.lat
        plane.nextLng = nextPoint.lng
        plane.nextAltitude = nextPoint.alt
        plane.color = route.color
        plane.bearing = bearing
        updatePlaneSprite(plane, camera)
      }
      frame = window.requestAnimationFrame(tick)
    }

    frame = window.requestAnimationFrame(tick)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
    }
  }, [labels, routePaths, view])

  const FLAT_W = 1100
  const FLAT_H = 540
  const flat = useMemo(() => {
    if (view !== 'flat') {
      return {
        land: [] as string[],
        origin: [0, 0] as [number, number],
        targets: [] as Array<RegionTraffic & { x: number; y: number; color: string }>,
      }
    }
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
      return { ...r, x, y, color: r.color }
    })
    return { land, origin, targets }
  }, [regions, view])

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
              {flat.land.map((d, i) => (
                <path className="land" d={d} key={i} />
              ))}
              {flat.targets.map((t, index) => {
                const [ox, oy] = flat.origin
                const mx = (ox + t.x) / 2
                const my = Math.min(oy, t.y) - Math.abs(t.x - ox) * 0.18 - 26
                const flightMs = FLIGHT_DURATION_MS + FLIGHT_END_HOLD_MS
                const flightDelay = `${(index * FLIGHT_STAGGER_MS) / 1000}s`
                return (
                  <g key={t.code} style={{ color: t.color }}>
                    <path
                      className="route-glow"
                      d={`M${ox},${oy} Q${mx},${my} ${t.x},${t.y}`}
                      fill="none"
                      stroke={t.color}
                      strokeWidth={5 + (t.bytes / maxBytes) * 4}
                      strokeLinecap="round"
                    />
                    <path
                      id={`rm-route-${t.code}`}
                      className="route-line"
                      d={`M${ox},${oy} Q${mx},${my} ${t.x},${t.y}`}
                      fill="none"
                      stroke={t.color}
                      strokeWidth={1 + (t.bytes / maxBytes) * 2.4}
                      strokeLinecap="round"
                    />
                    <path
                      className="route-trace"
                      d={`M${ox},${oy} Q${mx},${my} ${t.x},${t.y}`}
                      fill="none"
                      stroke={t.color}
                      strokeWidth={0.8}
                      strokeLinecap="round"
                    />
                    <g className="route-plane">
                      <animateMotion
                        dur={`${flightMs}ms`}
                        repeatCount="indefinite"
                        rotate="auto"
                        begin={flightDelay}
                        calcMode="linear"
                      >
                        <mpath href={`#rm-route-${t.code}`} />
                      </animateMotion>
                      <path
                        d="M15.6 0C11.4-1.9 6-2.8.6-2.9L-6-12.6c-1.2-1.8-3.6-.8-2.7 1.2l4.2 8.5-7.5-.3-4.2-3.1c-1.2-.9-2.4.6-1.2 1.8L-10.8 0l-6.6 4.5c-1.2 1.2 0 2.7 1.2 1.8l4.2-3.1 7.5-.3-4.2 8.5c-.9 2 1.5 3 2.7 1.2L.6 2.9C6 2.8 11.4 1.9 15.6 0Z"
                        fill="currentColor"
                        opacity={0.96}
                      />
                    </g>
                    <circle className="endpoint-halo" cx={t.x} cy={t.y} r={9} fill={t.color} />
                    <circle className="endpoint-dot" cx={t.x} cy={t.y} r={3 + (t.bytes / maxBytes) * 3} fill={t.color} />
                    <text x={t.x + 8} y={t.y + 4}>{t.name}</text>
                  </g>
                )
              })}
              <circle className="origin-halo" cx={flat.origin[0]} cy={flat.origin[1]} r={10} />
              <circle cx={flat.origin[0]} cy={flat.origin[1]} r={5} fill="#FF9F0A" />
              <text x={flat.origin[0] + 9} y={flat.origin[1] + 4}>{ORIGIN.name}</text>
            </svg>
          )}
          {regions.length === 0 && <div className="empty">暂无经代理出站的活跃连接</div>}
        </div>
        <div className="map-legend">
          {legendRegions.slice(0, 8).map((r) => (
            <span className="lg" key={r.code}>
              <i style={{ background: r.color }} />
              {r.name} <b>{fmtBytes(r.bytes)}</b>
            </span>
          ))}
          <span className="lg-hint">弧线宽度 ∝ 累计流量 · 拖拽旋转 / 滚轮缩放</span>
        </div>
      </Card>
    </div>
  )
}
