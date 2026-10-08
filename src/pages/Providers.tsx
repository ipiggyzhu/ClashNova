import { useCallback, useEffect, useRef, useState } from 'react'
import './Providers.css'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import {
  getProxyProviders,
  getRuleProviders,
  healthcheckProvider,
  updateProxyProvider,
  updateRuleProvider,
} from '../services/api'
import type { ProxyProviderItem, RuleProviderItem } from '../types/clash'
import { fmtBytes, fmtRelTime } from '../utils/format'
import { createTaskQueue } from '../utils/taskQueue'

const queueProvider = createTaskQueue<void>(3)

function fmtDate(ms?: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function Providers() {
  const [proxyPv, setProxyPv] = useState<ProxyProviderItem[]>([])
  const [rulePv, setRulePv] = useState<RuleProviderItem[]>([])
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const busyRef = useRef(new Set<string>())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [result, setResult] = useState('')
  const alive = useRef(true)
  const refreshFlight = useRef<Promise<void> | null>(null)

  const refresh = useCallback(async () => {
    if (refreshFlight.current) return refreshFlight.current
    const task = Promise.allSettled([getProxyProviders(), getRuleProviders()]).then(([pp, rp]) => {
      if (!alive.current) return
      if (pp.status === 'fulfilled') setProxyPv(pp.value)
      if (rp.status === 'fulfilled') setRulePv(rp.value)
      setErrors((previous) => ({ ...previous,
        'load:proxy': pp.status === 'rejected' ? `代理提供者加载失败：${String(pp.reason)}` : '',
        'load:rule': rp.status === 'rejected' ? `规则提供者加载失败：${String(rp.reason)}` : '',
      }))
    }).finally(() => { refreshFlight.current = null })
    refreshFlight.current = task
    return task
  }, [])

  useEffect(() => {
    alive.current = true
    const update = (): void => { if (alive.current && !document.hidden) void refresh() }
    const reconfigure = (): void => { void (refreshFlight.current ?? Promise.resolve()).then(update) }
    update()
    const timer = window.setInterval(update, 30_000)
    window.addEventListener('clashnova-api-config-changed', reconfigure)
    document.addEventListener('visibilitychange', update)
    return () => {
      alive.current = false
      window.clearInterval(timer)
      window.removeEventListener('clashnova-api-config-changed', reconfigure)
      document.removeEventListener('visibilitychange', update)
    }
  }, [refresh])

  const withBusy = async (key: string, fn: () => Promise<void>, refreshAfter = true): Promise<void> => {
    if (busyRef.current.has(key)) return
    busyRef.current.add(key)
    setBusy(new Set(busyRef.current))
    setErrors((previous) => ({ ...previous, [key]: '' }))
    try {
      await queueProvider(key, fn)
      if (refreshAfter) {
        await refreshFlight.current
        await refresh()
      }
    } catch (error) {
      if (alive.current) setErrors((previous) => ({ ...previous, [key]: `${key.slice(2)}：${String(error)}` }))
      throw error
    } finally {
      busyRef.current.delete(key)
      if (alive.current) setBusy(new Set(busyRef.current))
    }
  }

  const updateAll = async (): Promise<void> => {
    if (busyRef.current.size) return
    busyRef.current.add('__all__')
    setBusy(new Set(busyRef.current))
    setResult('')
    try {
      const results = await Promise.allSettled([
        ...proxyPv.map((p) => withBusy(`u:${p.name}`, () => updateProxyProvider(p.name), false)),
        ...rulePv.map((p) => withBusy(`r:${p.name}`, () => updateRuleProvider(p.name), false)),
      ])
      const failures = results.filter((item) => item.status === 'rejected').length
      if (alive.current) setResult(`更新完成：${results.length - failures} 项成功，${failures} 项失败`)
      await refreshFlight.current
      await refresh()
    } finally {
      busyRef.current.delete('__all__')
      if (alive.current) setBusy(new Set(busyRef.current))
    }
  }

  return (
    <div className="pg-providers">
      {Object.entries(errors).filter(([, message]) => message).map(([key, message]) => <div key={key} role="alert">{message}</div>)}
      {result && <div role="status">{result}</div>}
      <div className="sec-head">
        代理提供者
        <span className="spacer" />
        <Button size="sm" onClick={() => void updateAll()} disabled={busy.size > 0 || proxyPv.length + rulePv.length === 0}>
          <Icon name="refresh" size={13} />
          {busy.has('__all__') ? '更新中…' : '全部更新'}
        </Button>
      </div>

      {proxyPv.length === 0 ? (
        <Card>
          <div className="empty">当前订阅未定义 proxy-providers</div>
        </Card>
      ) : (
        <div className="grid2">
          {proxyPv.map((p) => {
            const pct =
              p.subscription && p.subscription.total > 0
                ? Math.min(100, (p.subscription.used / p.subscription.total) * 100)
                : null
            return (
              <Card
                key={p.name}
                icon={<Icon name="providers" />}
                iconColor="var(--purple)"
                title={p.name}
                actions={
                  <>
                    <span className="chip">{p.vehicleType}</span>
                    <span className="pv-meta">更新于 {fmtRelTime(p.updatedAt ?? 0)}</span>
                  </>
                }
              >
                <div className="pv-stats">
                  <div className="pv-stat">
                    <span className="stat-num num">{p.nodeCount}</span>
                    <span className="stat-label"><Icon name="proxies" size={12} />节点</span>
                  </div>
                  <div className="pv-stat">
                    <span className="stat-num num">
                      {p.subscription ? fmtBytes(p.subscription.used) : '—'}
                    </span>
                    <span className="stat-label"><Icon name="traffic" size={12} />已用</span>
                  </div>
                  <div className="pv-stat">
                    <span className="stat-num num sm">{fmtDate(p.subscription?.expireAt)}</span>
                    <span className="stat-label"><Icon name="clock" size={12} />到期</span>
                  </div>
                </div>
                {pct !== null && p.subscription && (
                  <div className="pv-traffic">
                    <div className="pv-traffic-top">
                      <span>已用流量 · {Math.round(pct)}%</span>
                      <span className="num">
                        <b>{fmtBytes(p.subscription.used)}</b> / {fmtBytes(p.subscription.total)}
                      </span>
                    </div>
                    <div className="pv-bar"><i style={{ width: `${pct}%` }} /></div>
                  </div>
                )}
                <div className="pv-foot">
                  <Button
                    size="sm"
                    disabled={busy.has('__all__') || busy.has(`u:${p.name}`)}
                    onClick={() => void withBusy(`u:${p.name}`, () => updateProxyProvider(p.name)).catch(() => undefined)}
                  >
                    {busy.has(`u:${p.name}`) ? '更新中…' : '更新'}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy.has('__all__') || busy.has(`h:${p.name}`)}
                    onClick={() => void withBusy(`h:${p.name}`, () => healthcheckProvider(p.name)).catch(() => undefined)}
                  >
                    {busy.has(`h:${p.name}`) ? '检查中…' : '健康检查'}
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <div className="sec-head">规则提供者</div>

      <Card flush>
        {rulePv.length === 0 ? (
          <div className="empty">当前订阅未定义 rule-providers</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>名称</th>
                <th>行为</th>
                <th>类型</th>
                <th className="ta-r">规则数</th>
                <th>更新于</th>
                <th className="ta-r">操作</th>
              </tr>
            </thead>
            <tbody>
              {rulePv.map((p) => (
                <tr key={p.name}>
                  <td className="mono">{p.name}</td>
                  <td><span className={`chip bh-${p.behavior}`}>{p.behavior}</span></td>
                  <td><span className="chip">{p.vehicleType}</span></td>
                  <td className="num ta-r">{p.ruleCount.toLocaleString()}</td>
                  <td className="t3">{fmtRelTime(p.updatedAt ?? 0)}</td>
                  <td className="ta-r">
                    <button
                      className="icon-btn"
                      title="刷新"
                      disabled={busy.has('__all__') || busy.has(`r:${p.name}`)}
                      onClick={() => void withBusy(`r:${p.name}`, () => updateRuleProvider(p.name)).catch(() => undefined)}
                    >
                      <Icon name="refresh" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
