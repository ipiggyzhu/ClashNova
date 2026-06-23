import { useEffect, useMemo, useRef, useState } from 'react'
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

const DEFAULT_FRAME_MS = 80
const DEFAULT_DISPLAY_FRAME_MS = 1000
const DEFAULT_SMOOTHING_MS = 320

function expStep(from: number, to: number, dtMs: number, smoothingMs: number): number {
  if (!Number.isFinite(to)) return 0
  const alpha = 1 - Math.exp(-dtMs / smoothingMs)
  const next = from + (to - from) * alpha
  return Math.abs(next - to) < 1 ? to : next
}

function withTail(points: number[], tail: number): number[] {
  const next = points.length >= 2 ? [...points] : [0, 0]
  next[next.length - 1] = tail
  return next
}

/**
 * Smooths 1 Hz mihomo traffic frames into a higher-frequency visual signal.
 * It does not invent real throughput; it eases the visible value toward the latest core sample.
 */
export function useSmoothTraffic(
  target: TrafficPoint,
  history: TrafficPoint[],
  options: SmoothTrafficOptions = {},
): SmoothTrafficState {
  const frameMs = options.frameMs ?? DEFAULT_FRAME_MS
  const displayFrameMs = options.displayFrameMs ?? DEFAULT_DISPLAY_FRAME_MS
  const smoothingMs = options.smoothingMs ?? DEFAULT_SMOOTHING_MS
  const targetRef = useRef<TrafficPoint>(target)
  const valueRef = useRef<TrafficPoint>(target)
  const lastFrameRef = useRef(0)
  const lastDisplayFrameRef = useRef(0)
  const [current, setCurrent] = useState<TrafficPoint>(target)
  const [display, setDisplay] = useState<TrafficPoint>(target)

  useEffect(() => {
    targetRef.current = {
      up: Math.max(0, target.up),
      down: Math.max(0, target.down),
    }
  }, [target.up, target.down])

  useEffect(() => {
    let raf = 0
    let last = performance.now()

    const tick = (now: number): void => {
      const dt = Math.max(1, now - last)
      last = now
      const from = valueRef.current
      const to = targetRef.current
      const next = {
        up: expStep(from.up, to.up, dt, smoothingMs),
        down: expStep(from.down, to.down, dt, smoothingMs),
      }
      valueRef.current = next

      if (now - lastFrameRef.current >= frameMs) {
        lastFrameRef.current = now
        setCurrent(next)
      }
      if (now - lastDisplayFrameRef.current >= displayFrameMs) {
        lastDisplayFrameRef.current = now
        setDisplay(next)
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [displayFrameMs, frameMs, smoothingMs])

  const upPts = useMemo(() => withTail(history.map((p) => p.up), current.up), [history, current.up])
  const downPts = useMemo(() => withTail(history.map((p) => p.down), current.down), [history, current.down])

  return { current, display, upPts, downPts }
}
