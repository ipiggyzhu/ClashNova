import { useEffect, useMemo, useRef } from 'react'
import Globe, { type GlobeInstance } from 'globe.gl'
import { geoEquirectangular, geoGraticule10, geoInterpolate, geoPath } from 'd3-geo'
import * as THREE from 'three'
import { useAppStore } from '../stores/app'
import { sunPosAt } from '../utils/solar'
import { LAND, ORIGIN, FLIGHT_DURATION_MS, FLIGHT_STAGGER_MS, type RegionTraffic } from './routeMapData'

interface RoutePoint {
  lat: number
  lng: number
  alt: number
}

interface RoutePath {
  code: string
  name: string
  color: string
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

const ROUTE_SAMPLE_COUNT = 80
const MAX_ANIMATION_STEP_MS = 34
const ROUTE_BASE_ALTITUDE = 0.012
const SUN_UPDATE_MS = 60000

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

function planeTexture(color: string, cache: Map<string, THREE.CanvasTexture>): THREE.CanvasTexture {
  const cached = cache.get(color)
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
  cache.set(color, texture)
  return texture
}

function pointTexture(color: string, cache: Map<string, THREE.CanvasTexture>): THREE.CanvasTexture {
  const cached = cache.get(color)
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
  cache.set(color, texture)
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
const VECTOR_EARTH_CANVASES = new Map<'day' | 'night', HTMLCanvasElement>()

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
function vectorEarthCanvas(variant: 'day' | 'night'): HTMLCanvasElement {
  const cached = VECTOR_EARTH_CANVASES.get(variant)
  if (cached) return cached
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

  VECTOR_EARTH_CANVASES.set(variant, canvas)
  return canvas
}

function buildVectorEarthTexture(variant: 'day' | 'night'): THREE.CanvasTexture {
  // 只缓存绘制结果；每个实例持有自己的 GPU 纹理，卸载时照常释放。
  const texture = new THREE.CanvasTexture(vectorEarthCanvas(variant))
  texture.colorSpace = THREE.NoColorSpace
  texture.anisotropy = 8
  texture.needsUpdate = true
  return texture
}

export default function RouteMapGlobe({ regions }: { regions: RegionTraffic[] }) {
  const resolvedTheme = useAppStore((s) => s.resolvedTheme)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const globeRef = useRef<GlobeInstance | null>(null)
  const globeObjectRef = useRef(new Map<string, THREE.Sprite>())
  const labelCache = useRef(new Map<string, LabelDatum>())
  const planeCache = useRef(new Map<string, LabelDatum>())
  const pointCache = useRef(new Map<string, LabelDatum>())
  const planeTextures = useRef(new Map<string, THREE.CanvasTexture>())
  const pointTextures = useRef(new Map<string, THREE.CanvasTexture>())
  const originLabel = useRef<LabelDatum>({ code: '__origin', name: ORIGIN.name, lat: ORIGIN.lat, lng: ORIGIN.lng })
  const maxBytes = Math.max(1, ...regions.map((region) => region.bytes))

  const routePathKey = regions.map((r) => `${r.code}:${r.lat}:${r.lng}:${r.color}`).join('|')
  const routePaths = useMemo<RoutePath[]>(
    () => regions.map((region, index) => buildRoutePath(region, index)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routePathKey],
  )

  const labelKey = regions.map((r) => r.code).join(',')
  const labels = useMemo<LabelDatum[]>(
    () => [
      originLabel.current,
      ...regions.map((r) => {
        let l = labelCache.current.get(r.code)
        if (!l) {
          l = { code: r.code, name: r.name, lat: r.lat, lng: r.lng }
          labelCache.current.set(r.code, l)
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
    if (!hostRef.current) return
    const el = hostRef.current
    const globe = new Globe(el, {
      animateIn: true,
      rendererConfig: { antialias: true, alpha: true, powerPreference: 'high-performance' },
    })
      .backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true)
      .atmosphereColor(GLOBE_THEMES[useAppStore.getState().resolvedTheme].atmosphere)
      .atmosphereAltitude(0.16)
      .width(el.clientWidth)
      .height(el.clientHeight)

    // 昼夜写实地球: 用自定义着色器混合白昼/夜晚贴图, 沿真实晨昏线切换。
    // 仅替换地球贴图模型, 大气层/弧线/飞机/标签/尺寸/自转均保持不变。
    const dayNightMaterial = new THREE.ShaderMaterial({
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
    const maxAniso = globe.renderer().capabilities.getMaxAnisotropy()
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
      tex?.dispose()
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

    globe.renderer().setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    globe.controls().autoRotate = true
    globe.controls().autoRotateSpeed = 0.28
    globe.pointOfView({ lat: 24, lng: 110, altitude: 1.85 }, 0)
    globeRef.current = globe

    // 太阳位置每分钟更新；视角补偿跟随控件变化，不另开一条逐帧计算链。
    let sunTimer: number | undefined
    const updateSun = (): void => {
      if (globeRef.current !== globe) return
      const [sunLng, sunLat] = sunPosAt(Date.now())
      dayNightMaterial.uniforms.sunPosition.value.set(sunLng, sunLat)
    }
    const updateRotation = (): void => {
      const pov = globe.pointOfView()
      dayNightMaterial.uniforms.globeRotation.value.set(pov.lng, pov.lat)
    }
    globe.onZoom(updateRotation)
    const syncVisibility = (): void => {
      window.clearInterval(sunTimer)
      sunTimer = undefined
      if (document.hidden) {
        globe.pauseAnimation()
        return
      }
      updateSun()
      updateRotation()
      globe.resumeAnimation()
      sunTimer = window.setInterval(updateSun, SUN_UPDATE_MS)
    }
    syncVisibility()
    document.addEventListener('visibilitychange', syncVisibility)

    const ro = new ResizeObserver(() => {
      globe.width(el.clientWidth).height(el.clientHeight)
    })
    ro.observe(el)
    return () => {
      window.clearInterval(sunTimer)
      document.removeEventListener('visibilitychange', syncVisibility)
      ro.disconnect()
      globeRef.current = null
      globeObjectRef.current.clear()
      // uniform 纹理由本组件持有，材质/自定义图层由 globe 的析构流程释放。
      disposeTexture(dayNightMaterial.uniforms.dayTexture.value as THREE.Texture | null)
      disposeTexture(dayNightMaterial.uniforms.nightTexture.value as THREE.Texture | null)
      globe._destructor()
      planeTextures.current.clear()
      pointTextures.current.clear()
      labelCache.current.clear()
      planeCache.current.clear()
      pointCache.current.clear()
      el.innerHTML = ''
    }
  }, [])

  useEffect(() => {
    globeRef.current?.atmosphereColor(GLOBE_THEMES[resolvedTheme].atmosphere)
  }, [resolvedTheme])

  useEffect(() => {
    const globe = globeRef.current
    if (!globe) return

    globe
      .arcsData([])
      .pathsData(routePaths)
      .pathPoints((d) => (d as RoutePath).points)
      .pathPointLat((p: RoutePoint) => p.lat)
      .pathPointLng((p: RoutePoint) => p.lng)
      .pathPointAlt((p: RoutePoint) => p.alt)
      .pathColor((d: object) => (d as RoutePath).color)
      .pathDashLength(1)
      .pathDashGap(0)
      .pathDashAnimateTime(0)
      .pathTransitionDuration(0)
      .pointsData([])
      .htmlElement((datum) => {
        const d = datum as LabelDatum
        const wrap = document.createElement('div')
        wrap.className = d.code === '__origin' ? 'globe-label globe-label--origin' : 'globe-label'
        const text = document.createElement('span')
        text.textContent = d.name
        wrap.appendChild(text)
        return wrap
      })
      .htmlAltitude((d) => (d as LabelDatum).altitude ?? 0.025)
      .customThreeObject((datum) => {
        const d = datum as LabelDatum
        if (d.isPoint) {
          const material = new THREE.SpriteMaterial({
            map: pointTexture(d.color ?? '#FF9F0A', pointTextures.current),
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
          map: planeTexture(d.color ?? '#FFD60A', planeTextures.current),
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
      .customThreeObjectUpdate((obj, datum) => {
        const d = datum as LabelDatum
        if (d.isPlane) return
        const coords = globe.getCoords(d.lat, d.lng, d.altitude ?? ROUTE_BASE_ALTITUDE)
        Object.assign(obj.position, coords)
        // 固定端点由深度测试遮挡，不把初次视角的朝向永久写入 visible。
      })

    if (typeof globe.htmlElementVisibilityModifier === 'function') {
      globe.htmlElementVisibilityModifier((label: HTMLElement, isVisible: boolean) => {
        label.style.opacity = isVisible ? '1' : '0'
      })
    }
  }, [routePaths])

  useEffect(() => {
    const weights = new Map(regions.map((region) => [region.code, region.bytes]))
    // 流量只更新线宽；路径采样和飞机动画不因计数刷新而重建。
    globeRef.current?.pathStroke((datum) =>
      0.35 + ((weights.get((datum as RoutePath).code) ?? 0) / maxBytes) * 0.65,
    )
  }, [regions, maxBytes])

  useEffect(() => {
    if (!globeRef.current) return
    const globe = globeRef.current
    globe.htmlElementsData(labels)

    const pointData = [
      (() => {
        const code = 'point-__origin'
        let point = pointCache.current.get(code)
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
          pointCache.current.set(code, point)
        }
        return point
      })(),
      ...routePaths.map((route) => {
        const lastPoint = route.points[route.points.length - 1]
        const code = `point-${route.code}`
        let point = pointCache.current.get(code)
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
          pointCache.current.set(code, point)
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
      let plane = planeCache.current.get(code)
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
        planeCache.current.set(code, plane)
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

    const updatePlaneSprite = (plane: LabelDatum, camera: ReturnType<GlobeInstance['camera']>) => {
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
      if (cancelled || document.hidden || globeRef.current !== globe) return
      const rawDelta = lastFrameTime === 0 ? 16.7 : now - lastFrameTime
      lastFrameTime = now
      animationClock += Math.min(Math.max(rawDelta, 0), MAX_ANIMATION_STEP_MS)
      const camera = globe.camera()
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

    const syncVisibility = (): void => {
      window.cancelAnimationFrame(frame)
      lastFrameTime = 0
      if (!document.hidden) frame = window.requestAnimationFrame(tick)
    }
    syncVisibility()
    document.addEventListener('visibilitychange', syncVisibility)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', syncVisibility)
    }
  }, [labels, routePaths])

  return <div className="globe-host" ref={hostRef} />
}
