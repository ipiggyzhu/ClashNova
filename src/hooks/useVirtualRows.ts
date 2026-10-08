import { useEffect, useRef, useState } from 'react'

/** 固定行高列表，仅挂载可视区和少量预渲染行。 */
export function useVirtualRows(count: number, rowHeight: number, headerHeight = 0) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 400 })
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let frame = 0
    const measure = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        setViewport({ top: container.scrollTop, height: container.clientHeight })
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    container.addEventListener('scroll', measure, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      container.removeEventListener('scroll', measure)
    }
  }, [])

  const size = Math.ceil(viewport.height / rowHeight) + 12
  const start = Math.max(0, Math.min(count - size, Math.floor((viewport.top - headerHeight) / rowHeight) - 6))
  const end = Math.min(count, start + size)
  return { containerRef, start, end, before: start * rowHeight, after: (count - end) * rowHeight }
}
