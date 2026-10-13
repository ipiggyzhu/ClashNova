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
    let generation = 0
    let running: Promise<void> | null = null
    setData(initial)
    setError(null)
    const update = (): Promise<void> => {
      if (disposed || document.hidden) return Promise.resolve()
      if (running) return running
      const current = generation
      setLoading(true)
      running = query().then((value) => {
        if (!disposed && current === generation) { setData(value); setError(null) }
      }, (reason: unknown) => {
        if (!disposed && current === generation) setError(String(reason))
      }).finally(() => {
        running = null
        if (!disposed && current === generation) setLoading(false)
      })
      return running
    }
    refreshRef.current = update
    void update()
    const timer = window.setInterval(() => { void update() }, intervalMs)
    const onRefresh = (): void => { void update() }
    const reconfigure = (): void => {
      generation += 1
      setData(initial)
      setError(null)
      // 旧请求结束后重查，不能把配置切换合并进已失效的请求。
      void (running ?? Promise.resolve()).then(update)
    }
    document.addEventListener('visibilitychange', onRefresh)
    window.addEventListener('clashnova-traffic-updated', onRefresh)
    window.addEventListener('clashnova-api-config-changed', reconfigure)
    return () => {
      disposed = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onRefresh)
      window.removeEventListener('clashnova-traffic-updated', onRefresh)
      window.removeEventListener('clashnova-api-config-changed', reconfigure)
    }
  }, [query, initial, intervalMs])

  return { data, error, loading, refresh }
}
