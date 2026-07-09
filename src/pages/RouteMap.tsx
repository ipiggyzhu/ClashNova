import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import './RouteMap.css'
import Globe from 'globe.gl'
import { geoEquirectangular, geoGraticule10, geoInterpolate, geoPath } from 'd3-geo'
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
import { sunPosAt } from '../utils/solar'

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

interface FlatTarget extends RegionTraffic {
  x: number
  y: number
  labelX: number
  labelY: number
  routeD: string
  nearIndex: number
  nearCount: number
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
const FLAT_PLANE_SCALE = 0.45
const FLAT_NEAR_DISTANCE = 92

function routeColor(code: string): string {
  const hash = [...code].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 0)
  return ROUTE_COLORS[hash % ROUTE_COLORS.length]
}

function buildRegionsFromConnections(payload: ConnectionsPayload): RegionTraffic[] {
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

function flatRouteD(
  origin: [number, number],
  target: { x: number; y: number },
  nearIndex: number,
  nearCount: number,
): string {
  const [ox, oy] = origin
  const dx = target.x - ox
  const dy = target.y - oy
  const dist = Math.hypot(dx, dy) || 1
  if (nearIndex < 0 || nearCount < 2) {
    const mx = (ox + target.x) / 2
    const my = Math.min(oy, target.y) - Math.abs(dx) * 0.18 - 26
    return `M${ox},${oy} Q${mx},${my} ${target.x},${target.y}`
  }

  const lane = nearIndex - (nearCount - 1) / 2
  const nx = -dy / dist
  const ny = dx / dist
  const mx = (ox + target.x) / 2 + nx * lane * 34
  const my = (oy + target.y) / 2 + ny * lane * 34 - 42
  return `M${ox},${oy} Q${mx},${my} ${target.x},${target.y}`
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

/**
 * 昼夜地球着色器: 把白昼贴图与夜晚贴图沿真实晨昏线混合。
 * sunPosition 为太阳直下点(经纬度), globeRotation 为当前视角经纬度(补偿球体自转)。
 * 昼面为 Blue Marble 自然色地表贴图, 夜面为 Black Marble 城市灯火贴图(均为 public/ 下 JPEG);
 * 矢量贴图(buildVectorEarthTexture)仅在 JPEG 加载完成前/离线兜底时占位。
 * 着色器仅沿真实晨昏线混合, 不做额外提亮/增辉。旋转/晨昏线数学取自 globe.gl 官方 day-night 示例。
 */
const DAY_NIGHT_VERTEX_SHADER = `
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const DAY_NIGHT_FRAGMENT_SHADER = `
  #define PI 3.141592653589793
  uniform sampler2D dayTexture;
  uniform sampler2D nightTexture;
  uniform vec2 sunPosition;
  uniform vec2 globeRotation;
  varying vec3 vNormal;
  varying vec2 vUv;

  float toRad(in float a) {
    return a * PI / 180.0;
  }

  vec3 Polar2Cartesian(in vec2 c) { // [lng, lat]
    float theta = toRad(90.0 - c.x);
    float phi = toRad(90.0 - c.y);
    return vec3(
      sin(phi) * cos(theta),
      cos(phi),
      sin(phi) * sin(theta)
    );
  }

  void main() {
    float invLon = toRad(globeRotation.x);
    float invLat = -toRad(globeRotation.y);
    mat3 rotX = mat3(
      1, 0, 0,
      0, cos(invLat), -sin(invLat),
      0, sin(invLat), cos(invLat)
    );
    mat3 rotY = mat3(
      cos(invLon), 0, sin(invLon),
      0, 1, 0,
      -sin(invLon), 0, cos(invLon)
    );
    vec3 rotatedSunDirection = rotX * rotY * Polar2Cartesian(sunPosition);
    float intensity = dot(normalize(vNormal), normalize(rotatedSunDirection));

    // 昼面 Blue Marble 自然色地表, 夜面 Black Marble 城市灯火(灯火已烘焙进贴图),
    // 着色器只负责沿真实晨昏线混合两者, 不做额外提取/增辉(否则会把灯火过曝)。
    vec3 dayColor = texture2D(dayTexture, vUv).rgb;
    vec3 nightColor = texture2D(nightTexture, vUv).rgb;

    // 晨昏线: smoothstep 过渡, 昼夜自然衔接又保持清晰分界
    float blendFactor = smoothstep(-0.10, 0.10, intensity);

    vec3 color = mix(nightColor, dayColor, blendFactor);
    gl_FragColor = vec4(color, 1.0);
  }
`

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

/* ---------------- 高德夜间矢量地球贴图 ---------------- */

const VECTOR_EARTH_W = 4096
const VECTOR_EARTH_H = 2048

/** 主要城市(经度, 纬度): 用于夜面城市点缀 */
const MAJOR_CITIES: [number, number][] = [
  [116.4, 39.9], [121.47, 31.23], [113.26, 23.13], [114.06, 22.54],
  [104.07, 30.57], [108.94, 34.34], [120.15, 30.28], [126.63, 45.75],
  [139.69, 35.68], [126.98, 37.57], [121.57, 25.03], [103.82, 1.35],
  [100.5, 13.75], [106.7, 10.78], [77.21, 28.61], [72.88, 19.08],
  [55.27, 25.2], [51.39, 35.69], [31.24, 30.04], [28.98, 41.01],
  [37.62, 55.75], [2.35, 48.86], [-0.13, 51.51], [13.4, 52.52],
  [12.5, 41.9], [4.9, 52.37], [-3.7, 40.42], [18.07, 59.33],
  [-74.0, 40.71], [-87.65, 41.85], [-118.24, 34.05], [-122.42, 37.77],
  [-99.13, 19.43], [-46.63, -23.55], [-58.38, -34.6], [-70.65, -33.45],
  [151.21, -33.87], [144.96, -37.81], [174.76, -36.85], [18.42, -33.92],
]

/**
 * 现画一张高德夜间矢量风格的地球贴图 (等距投影 = 球体 UV 展开图, 直接贴上经纬度即对齐)。
 * 深色海洋底 + 陆地填充 + 青蓝发光海岸线 + 极淡经纬网 + 城市点缀。
 * variant: 'night' 更暗、辉光更强; 'day' 稍亮。全离线, 用已装的 world-atlas 数据。
 */
function buildVectorEarthTexture(variant: 'day' | 'night'): THREE.CanvasTexture {
  const W = VECTOR_EARTH_W
  const H = VECTOR_EARTH_H
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const night = variant === 'night'

  // 海洋底: 近黑深蓝竖向渐变(高德夜间的暗底, 压得更暗让青色线条更跳)
  const ocean = ctx.createLinearGradient(0, 0, 0, H)
  if (night) {
    ocean.addColorStop(0, '#03060c')
    ocean.addColorStop(0.5, '#040a14')
    ocean.addColorStop(1, '#03060c')
  } else {
    ocean.addColorStop(0, '#071120')
    ocean.addColorStop(0.5, '#0a1a2d')
    ocean.addColorStop(1, '#071120')
  }
  ctx.fillStyle = ocean
  ctx.fillRect(0, 0, W, H)

  // 全球等距投影: 经度 -180..180 → x 0..W, 纬度 90..-90 → y 0..H
  const projection = geoEquirectangular()
    .scale(W / (2 * Math.PI))
    .translate([W / 2, H / 2])
  const path = geoPath(projection, ctx)

  // 经纬网: 极淡青色冷光网格
  ctx.beginPath()
  path(geoGraticule10())
  ctx.strokeStyle = night ? 'rgba(52,150,168,0.10)' : 'rgba(70,165,185,0.13)'
  ctx.lineWidth = 1
  ctx.stroke()

  // 陆地填充: 略带青调的深色, 与高德夜间陆块一致
  ctx.beginPath()
  for (const f of LAND.features) path(f)
  ctx.fillStyle = night ? '#0b2230' : '#123043'
  ctx.fill()

  // 海岸线发光描边(高德夜间标志性青色辉光, 两层叠加增强)。
  // 偏 teal/cyan 而非蓝, 更贴高德夜间路网/岸线的青色调。
  ctx.save()
  ctx.beginPath()
  for (const f of LAND.features) path(f)
  ctx.shadowColor = night ? 'rgba(38,190,205,0.95)' : 'rgba(60,195,210,0.82)'
  ctx.shadowBlur = night ? 16 : 12
  ctx.strokeStyle = night ? 'rgba(64,208,222,0.82)' : 'rgba(96,205,220,0.75)'
  ctx.lineWidth = 2.4
  ctx.stroke()
  ctx.shadowBlur = night ? 6 : 4
  ctx.strokeStyle = night ? 'rgba(158,232,240,0.94)' : 'rgba(178,236,242,0.88)'
  ctx.lineWidth = 1.1
  ctx.stroke()
  ctx.restore()

  // 城市标记: 高德夜间为干净的矢量线条图, 城市仅以极小的青色圆点点缀,
  // 不做金色"太空灯火"辉光(那会破坏矢量地图的干净感)。
  ctx.save()
  for (const [lng, lat] of MAJOR_CITIES) {
    const p = projection([lng, lat])
    if (!p) continue
    const [x, y] = p
    ctx.fillStyle = night ? 'rgba(120,215,228,0.7)' : 'rgba(140,220,232,0.6)'
    ctx.beginPath()
    ctx.arc(x, y, night ? 1.4 : 1.2, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.NoColorSpace
  texture.anisotropy = 8
  texture.needsUpdate = true
  return texture
}

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
      .width(el.clientWidth)
      .height(el.clientHeight)

    // 昼夜写实地球: 用自定义着色器混合白昼/夜晚贴图, 沿真实晨昏线切换。
    // 仅替换地球贴图模型, 大气层/弧线/飞机/标签/尺寸/自转均保持不变。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ShaderMaterial = (THREE as any).ShaderMaterial
    const dayNightMaterial = new ShaderMaterial({
      uniforms: {
        dayTexture: { value: null },
        nightTexture: { value: null },
        sunPosition: { value: new THREE.Vector2() },
        globeRotation: { value: new THREE.Vector2() },
      },
      vertexShader: DAY_NIGHT_VERTEX_SHADER,
      fragmentShader: DAY_NIGHT_FRAGMENT_SHADER,
    })
    globe.globeMaterial(dayNightMaterial)

    // 写实卫星地球: 昼面用 Blue Marble(自然色地表), 夜面用 Black Marble(城市灯火)。
    // 两张均为 public/ 下的 4096x2048 等距投影 JPEG, 着色器沿真实晨昏线混合。
    // 矢量贴图(buildVectorEarthTexture)保留为占位/离线兜底: JPEG 异步加载完成前先显示,
    // 加载失败(离线/文件缺失)时也不会出现白球。
    const maxAniso = globe.renderer?.().capabilities.getMaxAnisotropy?.() ?? 8
    const tuneTexture = (tex: THREE.Texture, srgb: boolean): void => {
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
      tex.anisotropy = maxAniso
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = true
      tex.needsUpdate = true
    }

    const fallbackDay = buildVectorEarthTexture('day')
    const fallbackNight = buildVectorEarthTexture('night')
    tuneTexture(fallbackDay, false)
    tuneTexture(fallbackNight, false)
    dayNightMaterial.uniforms.dayTexture.value = fallbackDay
    dayNightMaterial.uniforms.nightTexture.value = fallbackNight
    dayNightMaterial.needsUpdate = true

    // 释放 GPU 显存: three.js 不会因材质 dispose 递归释放 uniform 持有的纹理, 需手动 dispose。
    const disposeTexture = (tex: THREE.Texture | null | undefined): void => {
      ;(tex as unknown as { dispose?: () => void } | null | undefined)?.dispose?.()
    }

    // 异步加载真实卫星照片, 就绪后热替换进 uniforms(仍在同一 globe 实例时才生效)。
    const loader = new THREE.TextureLoader()
    const swapTexture = (uniform: 'dayTexture' | 'nightTexture', url: string): void => {
      loader
        .loadAsync(url)
        .then((tex) => {
          if (globeRef.current !== globe) {
            disposeTexture(tex)
            return
          }
          tuneTexture(tex, true)
          // 热替换成功: 释放被顶掉的兜底纹理, 避免它上传 GPU 后被丢弃仍占显存。
          const prev = dayNightMaterial.uniforms[uniform].value as THREE.Texture | null
          dayNightMaterial.uniforms[uniform].value = tex
          dayNightMaterial.needsUpdate = true
          if (prev !== tex) disposeTexture(prev)
        })
        .catch(() => {
          /* 离线/文件缺失: 保留矢量兜底贴图 */
        })
    }
    swapTexture('dayTexture', '/earth-day.jpg')
    swapTexture('nightTexture', '/earth-night.jpg')

    globe.renderer?.().setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    globe.controls().autoRotate = true
    globe.controls().autoRotateSpeed = 0.28
    globe.pointOfView({ lat: 24, lng: 110, altitude: 1.85 }, 0)
    globeRef.current = globe

    // 每帧刷新太阳直下点(真实时区昼夜)与视角补偿, 让晨昏线固定在地理正确的位置。
    let sunRaf = 0
    const updateSun = (): void => {
      if (globeRef.current !== globe) return
      const [sunLng, sunLat] = sunPosAt(Date.now())
      dayNightMaterial.uniforms.sunPosition.value.set(sunLng, sunLat)
      const pov = globe.pointOfView()
      dayNightMaterial.uniforms.globeRotation.value.set(pov.lng, pov.lat)
      sunRaf = window.requestAnimationFrame(updateSun)
    }
    sunRaf = window.requestAnimationFrame(updateSun)

    const ro = new ResizeObserver(() => {
      globe.width(el.clientWidth).height(el.clientHeight)
    })
    ro.observe(el)
    return () => {
      window.cancelAnimationFrame(sunRaf)
      ro.disconnect()
      globeRef.current = null
      globeObjectRef.current.clear()
      // 释放昼夜地球的 GPU 资源: uniform 里当前持有的两张纹理(兜底或已热替换的 JPEG)+ 材质本身。
      // _destructor() 不会递归 dispose 这些, 不手动释放会在每次 [view, resolvedTheme] 切换时泄漏显存。
      disposeTexture(dayNightMaterial.uniforms.dayTexture.value as THREE.Texture | null)
      disposeTexture(dayNightMaterial.uniforms.nightTexture.value as THREE.Texture | null)
      ;(dayNightMaterial as unknown as { dispose?: () => void }).dispose?.()
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
        originLabel: { x: 0, y: 0 },
        targets: [] as FlatTarget[],
        focusTargets: [] as FlatTarget[],
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
    const projected = regions.map((r) => {
      const [x, y] = projection([r.lng, r.lat]) ?? [0, 0]
      return { ...r, x, y, color: r.color }
    })
    const near = projected
      .filter((t) => Math.hypot(t.x - origin[0], t.y - origin[1]) < FLAT_NEAR_DISTANCE)
      .sort((a, b) => a.y - b.y || a.x - b.x)
    const nearOrder = new Map(near.map((t, index) => [t.code, index]))
    const targets = projected.map((t) => {
      const nearIndex = nearOrder.get(t.code) ?? -1
      const nearCount = near.length
      const lane = nearIndex >= 0 && nearCount > 1 ? nearIndex - (nearCount - 1) / 2 : 0
      const labelX = Math.max(18, Math.min(FLAT_W - 18, t.x + (nearIndex >= 0 ? 28 : 9)))
      const labelY = Math.max(18, Math.min(FLAT_H - 18, t.y + (nearIndex >= 0 ? lane * 21 - 19 : 4)))
      return {
        ...t,
        nearIndex,
        nearCount,
        labelX,
        labelY,
        routeD: flatRouteD(origin, t, nearIndex, nearCount),
      }
    })
    const focusTargets = targets.filter((t) => t.nearIndex >= 0)
    return {
      land,
      origin,
      originLabel: {
        x: Math.max(18, Math.min(FLAT_W - 18, origin[0] + 11)),
        y: Math.max(18, Math.min(FLAT_H - 18, origin[1] + (focusTargets.length ? 24 : 4))),
      },
      targets,
      focusTargets,
    }
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
                const flightMs = FLIGHT_DURATION_MS + FLIGHT_END_HOLD_MS
                const flightDelay = `${(index * FLIGHT_STAGGER_MS) / 1000}s`
                return (
                  <g key={t.code} style={{ color: t.color }}>
                    <path
                      className="route-glow"
                      d={t.routeD}
                      fill="none"
                      stroke={t.color}
                      strokeWidth={5 + (t.bytes / maxBytes) * 4}
                      strokeLinecap="round"
                    />
                    <path
                      id={`rm-route-${t.code}`}
                      className="route-line"
                      d={t.routeD}
                      fill="none"
                      stroke={t.color}
                      strokeWidth={1 + (t.bytes / maxBytes) * 2.4}
                      strokeLinecap="round"
                    />
                    <path
                      className="route-trace"
                      d={t.routeD}
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
                      <g transform={`scale(${FLAT_PLANE_SCALE})`}>
                        <path
                          d="M15.6 0C11.4-1.9 6-2.8.6-2.9L-6-12.6c-1.2-1.8-3.6-.8-2.7 1.2l4.2 8.5-7.5-.3-4.2-3.1c-1.2-.9-2.4.6-1.2 1.8L-10.8 0l-6.6 4.5c-1.2 1.2 0 2.7 1.2 1.8l4.2-3.1 7.5-.3-4.2 8.5c-.9 2 1.5 3 2.7 1.2L.6 2.9C6 2.8 11.4 1.9 15.6 0Z"
                          fill="currentColor"
                          opacity={0.96}
                        />
                      </g>
                    </g>
                    <circle className="endpoint-halo" cx={t.x} cy={t.y} r={9} fill={t.color} />
                    <circle className="endpoint-dot" cx={t.x} cy={t.y} r={3 + (t.bytes / maxBytes) * 3} fill={t.color} />
                    {t.nearIndex >= 0 && (
                      <path
                        className="label-leader"
                        d={`M${t.x + 6},${t.y} L${t.labelX - 5},${t.labelY - 4}`}
                      />
                    )}
                    <text className="node-label" x={t.labelX} y={t.labelY}>{t.name}</text>
                  </g>
                )
              })}
              <circle className="origin-halo" cx={flat.origin[0]} cy={flat.origin[1]} r={10} />
              <circle cx={flat.origin[0]} cy={flat.origin[1]} r={5} fill="#FF9F0A" />
              {flat.focusTargets.length > 0 && (
                <path
                  className="label-leader"
                  d={`M${flat.origin[0] + 6},${flat.origin[1]} L${flat.originLabel.x - 5},${flat.originLabel.y - 4}`}
                />
              )}
              <text className="node-label origin-label" x={flat.originLabel.x} y={flat.originLabel.y}>{ORIGIN.name}</text>
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
