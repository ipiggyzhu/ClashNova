import { useCallback, useEffect, useState } from 'react'
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

function fmtDate(ms?: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 已用流量数值(GB 级展示, fmtBytes 带单位则取主数字) */
function usedShort(bytes: number): string {
  return fmtBytes(bytes).replace(/\s*[A-Z]+$/i, '')
}

export default function Providers() {
  const [proxyPv, setProxyPv] = useState<ProxyProviderItem[]>([])
  const [rulePv, setRulePv] = useState<RuleProviderItem[]>([])
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    const [pp, rp] = await Promise.all([getProxyProviders(), getRuleProviders()])
    setProxyPv(pp)
    setRulePv(rp)
  }, [])

  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  const withBusy = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy((prev) => new Set(prev).add(key))
    try {
      await fn()
      await refresh()
    } finally {
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const updateAll = async (): Promise<void> => {
    await withBusy('__all__', async () => {
      await Promise.allSettled([
        ...proxyPv.map((p) => updateProxyProvider(p.name)),
        ...rulePv.map((p) => updateRuleProvider(p.name)),
      ])
    })
  }

  return (
    <div className="pg-providers">
      <div className="sec-head">
        代理提供者
        <span className="spacer" />
        <Button size="sm" onClick={() => void updateAll()} disabled={busy.has('__all__')}>
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
                      {p.subscription ? usedShort(p.subscription.used) : '—'}
                      {p.subscription && <span className="unit">GB</span>}
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
                        <b>{usedShort(p.subscription.used)}</b> / {fmtBytes(p.subscription.total)}
                      </span>
                    </div>
                    <div className="pv-bar"><i style={{ width: `${pct}%` }} /></div>
                  </div>
                )}
                <div className="pv-foot">
                  <Button
                    size="sm"
                    disabled={busy.has(`u:${p.name}`)}
                    onClick={() => void withBusy(`u:${p.name}`, () => updateProxyProvider(p.name))}
                  >
                    {busy.has(`u:${p.name}`) ? '更新中…' : '更新'}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy.has(`h:${p.name}`)}
                    onClick={() => void withBusy(`h:${p.name}`, () => healthcheckProvider(p.name))}
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
                      disabled={busy.has(`r:${p.name}`)}
                      onClick={() => void withBusy(`r:${p.name}`, () => updateRuleProvider(p.name))}
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
