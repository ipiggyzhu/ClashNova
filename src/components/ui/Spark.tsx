import { useLayoutEffect, useMemo, useRef, useState } from 'react'

let sparkSeq = 0

export interface SparkProps {
  /** 数据点序列(>=2 个才渲染) */
  pts: number[]
  color?: string
  /** 高度(px), 默认 48 */
  h?: number
  /** 是否绘制渐变面积填充 */
  fill?: boolean
  /** 是否绘制末端圆点 */
  dot?: boolean
  className?: string
}

/**
 * 迷你曲线(Spark)组件。
 * 算法移植自 design/shell-tail.html 的 Catmull-Rom 平滑渲染器:
 * 容器测宽(ResizeObserver 自适应) → 归一化坐标 → C 段三次贝塞尔拼接。
 */
export default function Spark({
  pts,
  color = '#0A84FF',
  h = 48,
  fill = false,
  dot = false,
  className,
}: SparkProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const gradId = useRef('')
  if (!gradId.current) gradId.current = `sg${sparkSeq++}`

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      setW(el.clientWidth || el.parentElement?.clientWidth || 280)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const geo = useMemo(() => {
    if (w <= 0 || pts.length < 2) return null
    const max = Math.max(...pts) * 1.15 || 1
    const min = 0
    const stepX = w / (pts.length - 1)
    const xy: [number, number][] = pts.map((p, i) => [
      i * stepX,
      h - 4 - ((p - min) / (max - min)) * (h - 10),
    ])
    /* Catmull-Rom 平滑 */
    let d = `M${xy[0][0]},${xy[0][1]}`
    for (let i = 0; i < xy.length - 1; i++) {
      const p0 = xy[i - 1] || xy[i]
      const p1 = xy[i]
      const p2 = xy[i + 1]
      const p3 = xy[i + 2] || p2
      d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${
        p2[0] - (p3[0] - p1[0]) / 6
      },${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`
    }
    return { d, last: xy[xy.length - 1] }
  }, [pts, w, h])

  return (
    <div ref={ref} className={className ? `spark ${className}` : 'spark'}>
      {geo && (
        <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          {fill && (
            <>
              <defs>
                <linearGradient id={gradId.current} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={color} stopOpacity=".32" />
                  <stop offset="1" stopColor={color} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                d={`${geo.d} L${w},${h} L0,${h} Z`}
                fill={`url(#${gradId.current})`}
                stroke="none"
              />
            </>
          )}
          <path d={geo.d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
          {dot && (
            <circle
              cx={geo.last[0] - 2}
              cy={geo.last[1]}
              r="3.5"
              fill={color}
              stroke="rgba(255,255,255,.85)"
              strokeWidth="1.5"
            />
          )}
        </svg>
      )}
    </div>
  )
}
