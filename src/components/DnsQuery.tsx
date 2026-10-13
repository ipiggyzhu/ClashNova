import { useRef, useState } from 'react'
import Badge from './ui/Badge'
import Button from './ui/Button'
import Card from './ui/Card'
import Icon from './ui/Icon'
import Input from './ui/Input'
import { queryDns } from '../services/api'
import { useAppStore } from '../stores/app'
import type { DnsQueryResult } from '../types/clash'

const QUERY_TYPES = ['A', 'AAAA', 'CNAME', 'HTTPS', 'MX', 'TXT', 'NS']
const RR_NAMES: Record<number, string> = { 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 15: 'MX', 16: 'TXT', 28: 'AAAA', 65: 'HTTPS' }
const RCODE_NAMES: Record<number, string> = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' }

/** 经 mihomo /dns/query 解析域名, 用于核对 Fake-IP、nameserver-policy 与 DNS 覆写是否生效 */
export default function DnsQuery() {
  const coreRunning = useAppStore((s) => s.coreStatus.running)
  const [name, setName] = useState('')
  const [type, setType] = useState('A')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<(DnsQueryResult & { query: string; type: string; ms: number }) | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)

  const run = async (): Promise<void> => {
    const host = name.trim().replace(/^https?:\/\//i, '').split(/[/?#]/)[0] ?? ''
    if (!host || /\s/.test(host)) {
      setError('请输入域名，例如 www.google.com')
      return
    }
    const current = ++seq.current
    setBusy(true)
    setError('')
    const started = performance.now()
    try {
      const next = await queryDns(host, type)
      if (current === seq.current) setResult({ ...next, query: host, type, ms: Math.round(performance.now() - started) })
    } catch (reason) {
      if (current !== seq.current) return
      setResult(null)
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message.endsWith('HTTP 500') ? `${message}（内核 DNS 未启用或上游解析失败）` : message)
    } finally {
      if (current === seq.current) setBusy(false)
    }
  }

  return (
    <Card className="dns-query" title="DNS 查询" icon={<Icon name="search" />}>
      <p className="media-note">经内核 DNS 模块解析(含 Fake-IP、hosts 与 nameserver-policy)，结果与应用实际拿到的一致。</p>
      <div className="dns-query-bar">
        <Input
          aria-label="查询域名"
          placeholder="域名，例如 www.google.com"
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy && coreRunning) void run() }}
        />
        <select className="select" aria-label="记录类型" value={type} onChange={(e) => setType(e.target.value)}>
          {QUERY_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <Button variant="primary" onClick={() => void run()} disabled={busy || !coreRunning}>
          {busy ? '查询中…' : '查询'}
        </Button>
      </div>
      {!coreRunning && <p className="media-note">内核已停止，请先启动 mihomo。</p>}
      {error && <p className="media-error" role="alert">{error}</p>}
      {result && (
        <div className="dns-query-result" aria-live="polite">
          <div className="dns-query-meta">
            <Badge tone={result.status === 0 ? 'green' : 'orange'}>{RCODE_NAMES[result.status] ?? `RCODE ${result.status}`}</Badge>
            <span>{result.query} · {result.type} · {result.ms} ms</span>
          </div>
          {result.answers.length === 0 ? (
            <p className="media-note">无应答记录</p>
          ) : (
            <table className="tbl">
              <thead><tr><th>名称</th><th>类型</th><th>TTL</th><th>数据</th></tr></thead>
              <tbody>
                {result.answers.map((answer, i) => (
                  <tr key={`${answer.name}-${answer.type}-${answer.data}-${i}`}>
                    <td>{answer.name}</td>
                    <td>{RR_NAMES[answer.type] ?? answer.type}</td>
                    <td className="num">{answer.TTL}</td>
                    <td className="dns-data">{answer.data}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  )
}
