import { useCallback, useEffect, useRef, useState } from 'react'

/** 可见时刷新，合并并发请求，查询参数变化/卸载后丢弃旧响应。query 必须 useCallback。 */
export function usePollingQuery<T>(query: () => Promise<T>, initial: T, intervalMs = 15_000) {
  const [data, setData] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const refreshRef = useRef<() => Promise<void>>(async () => undefined)
  const refresh = useCallback(() => refreshRef.current(), [])

  useEffect(() => {
    let disposed = false
    let running: Promise<void> | null = null
    setData(initial)
    setError(null)
    const update = (): Promise<void> => {
      if (disposed || document.hidden) return Promise.resolve()
      if (running) return running
      setLoading(true)
      running = query().then((value) => {
        if (!disposed) { setData(value); setError(null) }
      }, (reason: unknown) => {
        if (!disposed) setError(String(reason))
      }).finally(() => {
        running = null
        if (!disposed) setLoading(false)
      })
      return running
    }
    refreshRef.current = update
    void update()
    const timer = window.setInterval(() => { void update() }, intervalMs)
    const onRefresh = (): void => { void update() }
    document.addEventListener('visibilitychange', onRefresh)
    window.addEventListener('clashnova-traffic-updated', onRefresh)
    window.addEventListener('clashnova-api-config-changed', onRefresh)
    return () => {
      disposed = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onRefresh)
      window.removeEventListener('clashnova-traffic-updated', onRefresh)
      window.removeEventListener('clashnova-api-config-changed', onRefresh)
    }
  }, [query, initial, intervalMs])

  return { data, error, loading, refresh }
}
