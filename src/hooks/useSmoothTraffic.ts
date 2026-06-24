import { useMemo } from 'react'
import type { TrafficPoint } from '../types/clash'

interface SmoothTrafficOptions {
  frameMs?: number
  displayFrameMs?: number
  smoothingMs?: number
}

interface SmoothTrafficState {
  current: TrafficPoint
  display: TrafficPoint
  upPts: number[]
  downPts: number[]
}

function withTail(points: number[], tail: number): number[] {
  const next = points.length >= 2 ? [...points] : [0, 0]
  next[next.length - 1] = tail
  return next
}

/**
 * Keeps realtime traffic on the same cadence as mihomo samples.
 * Callers may still use the returned point for charts, but the displayed speed is not interpolated.
 */
export function useSmoothTraffic(
  target: TrafficPoint,
  history: TrafficPoint[],
  _options: SmoothTrafficOptions = {},
): SmoothTrafficState {
  const current = useMemo<TrafficPoint>(
    () => ({
      ...target,
      up: Math.max(0, Number.isFinite(target.up) ? target.up : 0),
      down: Math.max(0, Number.isFinite(target.down) ? target.down : 0),
    }),
    [target],
  )

  const upPts = useMemo(() => withTail(history.map((p) => p.up), current.up), [history, current.up])
  const downPts = useMemo(() => withTail(history.map((p) => p.down), current.down), [history, current.down])

  return { current, display: current, upPts, downPts }
}
