import { lazy, startTransition, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import './RouteMap.css'
import { geoEquirectangular, geoPath } from 'd3-geo'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Seg from '../components/ui/Seg'
import { startLiveStreams, useLiveStore } from '../stores/live'
import { fmtBytes } from '../utils/format'
import {
  LAND, ORIGIN, FLIGHT_DURATION_MS, FLIGHT_END_HOLD_MS, FLIGHT_STAGGER_MS,
  buildRegionsFromConnections, sameRegionSnapshot, type RegionTraffic,
} from './routeMapData'

const RouteMapGlobe = lazy(() => import('./RouteMapGlobe'))
const FLAT_W = 1100
const FLAT_H = 540
const FLAT_PLANE_SCALE = 0.45
const FLAT_NEAR_DISTANCE = 92
const ROUTE_DATA_REFRESH_MS = 1800

interface FlatTarget extends RegionTraffic {
  x: number
  y: number
  labelX: number
  labelY: number
  routeD: string
  nearIndex: number
  nearCount: number
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

let flatBase: ReturnType<typeof buildFlatBase> | undefined

function buildFlatBase() {
  const projection = geoEquirectangular().fitExtent(
    [[10, 10], [FLAT_W - 10, FLAT_H - 10]],
    LAND,
  )
  const path = geoPath(projection)
  return {
    projection,
    land: LAND.features.map((feature) => path(feature) ?? '').filter(Boolean),
    origin: projection([ORIGIN.lng, ORIGIN.lat]) ?? [0, 0] as [number, number],
  }
}

export default function RouteMap() {
  const [regions, setRegions] = useState<RegionTraffic[]>(() =>
    buildRegionsFromConnections(useLiveStore.getState().connections),
  )
  const [view, setView] = useState<'globe' | 'flat'>(
    new URLSearchParams(location.search).get('view') === 'flat' ? 'flat' : 'globe',
  )
  const flatRef = useRef<SVGSVGElement | null>(null)

  useEffect(() => {
    const release = startLiveStreams(['connections'])
    let timer: number | undefined
    const refresh = (): void => {
      const nextRegions = buildRegionsFromConnections(useLiveStore.getState().connections)
      startTransition(() => {
        setRegions((prev) => (sameRegionSnapshot(prev, nextRegions) ? prev : nextRegions))
      })
    }
    const syncVisibility = (): void => {
      window.clearInterval(timer)
      timer = undefined
      if (document.hidden) return
      refresh()
      timer = window.setInterval(refresh, ROUTE_DATA_REFRESH_MS)
    }
    syncVisibility()
    document.addEventListener('visibilitychange', syncVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', syncVisibility)
      release()
    }
  }, [])

  useEffect(() => {
    if (view !== 'flat' || !flatRef.current) return
    const svg = flatRef.current
    const syncVisibility = (): void => {
      svg.dataset.paused = String(document.hidden)
      if (document.hidden) svg.pauseAnimations()
      else svg.unpauseAnimations()
    }
    syncVisibility()
    document.addEventListener('visibilitychange', syncVisibility)
    return () => document.removeEventListener('visibilitychange', syncVisibility)
  }, [view])

  const maxBytes = Math.max(1, ...regions.map((r) => r.bytes))
  const legendRegions = useMemo(
    () => [...regions].sort((a, b) => b.bytes - a.bytes),
    [regions],
  )
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
    const { projection, land, origin } = flatBase ??= buildFlatBase()
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
            <Suspense fallback={<div className="empty" role="status">正在加载球面视图…</div>}>
              <RouteMapGlobe regions={regions} />
            </Suspense>
          ) : (
            <svg
              ref={flatRef}
              className="flat-svg"
              aria-label="路由平面地图"
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
