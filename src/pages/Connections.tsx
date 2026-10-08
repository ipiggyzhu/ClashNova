import { useEffect, useMemo, useRef, useState } from 'react'
import './Connections.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Seg from '../components/ui/Seg'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { closeAllConnections, closeConnection } from '../services/api'
import { startLiveStreams, useLiveStore } from '../stores/live'
import type { ConnItem } from '../types/clash'
import { fmtBytes, fmtDuration, fmtSpeed } from '../utils/format'

const PROC_COLORS = ['#64D2FF', '#BF5AF2', '#FF9F0A', '#32D74B', '#FF375F', '#FFD60A', '#40C8E0']
interface ConnRateSample {
  upload: number
  download: number
  at: number
}

interface ConnVisualRow {
  upload: number
  download: number
  up: number
  down: number
}

function procColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return PROC_COLORS[Math.abs(h) % PROC_COLORS.length]!
}

function connDuration(start: string): string {
  const sec = Math.max(0, (Date.now() - new Date(start).getTime()) / 1000)
  return fmtDuration(sec)
}

export default function Connections() {
  const payload = useLiveStore((s) => s.connections)
  const traffic = useLiveStore((s) => s.traffic)
  const [visiblePayload, setVisiblePayload] = useState(payload)
  const [keyword, setKeyword] = useState('')
  const [network, setNetwork] = useState('all')
  const [proxyFilter, setProxyFilter] = useState('all')
  const samplesRef = useRef(new Map<string, ConnRateSample & ConnVisualRow & { connection: ConnItem }>())
  const previousPayload = useRef<typeof payload | null>(null)
  const [visualRows, setVisualRows] = useState<Map<string, ConnVisualRow>>(new Map())
  const [closing, setClosing] = useState<Set<string>>(new Set())
  const closingRef = useRef(new Set<string>())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => startLiveStreams(['connections', 'traffic']), [])

  // 仅在内核快照到达时更新；Map 的插入顺序保留首见次序，不再每 100 ms 扫描/插值全表。
  useEffect(() => {
    if (previousPayload.current === payload) return
    previousPayload.current = payload
    const samples = samplesRef.current
    const now = performance.now()
    const seen = new Set(payload.connections.map((c) => c.id))
    for (const id of samples.keys()) if (!seen.has(id)) samples.delete(id)
    for (const c of payload.connections) {
      const previous = samples.get(c.id)
      const elapsed = previous ? Math.max(0.001, (now - previous.at) / 1000) : 1
      samples.set(c.id, {
        connection: c, at: now, upload: c.upload, download: c.download,
        up: Math.max(0, c.curUp ?? (previous ? (c.upload - previous.upload) / elapsed : 0)),
        down: Math.max(0, c.curDown ?? (previous ? (c.download - previous.download) / elapsed : 0)),
      })
    }
    setVisiblePayload({ ...payload, connections: [...samples.values()].map((row) => row.connection) })
    setVisualRows(new Map(samples))
  }, [payload])

  const close = async (id = '__all__'): Promise<void> => {
    if (closingRef.current.has(id) || closingRef.current.has('__all__')) return
    closingRef.current.add(id)
    setClosing(new Set(closingRef.current))
    setError(null)
    try {
      if (id === '__all__') await closeAllConnections()
      else await closeConnection(id)
    } catch (reason) {
      setError(String(reason))
    } finally {
      closingRef.current.delete(id)
      setClosing(new Set(closingRef.current))
    }
  }

  const upSpeed = useMemo(
    () => [...visualRows.values()].reduce((s, r) => s + r.up, 0),
    [visualRows],
  )
  const downSpeed = useMemo(
    () => [...visualRows.values()].reduce((s, r) => s + r.down, 0),
    [visualRows],
  )
  const lastTraffic = traffic[traffic.length - 1]
  const trafficFresh = Boolean(
    lastTraffic &&
      lastTraffic.source !== 'disconnect' &&
      (!lastTraffic.timestamp || Date.now() - lastTraffic.timestamp < 3500),
  )
  const topUpSpeed = trafficFresh ? lastTraffic!.up : upSpeed
  const topDownSpeed = trafficFresh ? lastTraffic!.down : downSpeed

  const list = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return visiblePayload.connections.filter((c) => {
      if (network !== 'all' && c.metadata.network !== network) return false
      // 代理筛选
      if (proxyFilter !== 'all') {
        const lastProxy = c.chains[0] ?? ''
        if (proxyFilter === 'direct' && lastProxy !== 'DIRECT') return false
        if (proxyFilter === 'proxy' && (lastProxy === 'DIRECT' || lastProxy === 'REJECT')) return false
        if (proxyFilter === 'reject' && lastProxy !== 'REJECT') return false
      }
      if (!kw) return true
      const hay = `${c.metadata.host} ${c.metadata.destinationIP} ${c.metadata.process ?? ''} ${c.rule} ${c.rulePayload} ${c.chains.join(' ')}`.toLowerCase()
      return hay.includes(kw)
    })
  }, [visiblePayload, keyword, network, proxyFilter])

  const windowed = useVirtualRows(list.length, 56, 36)
  useEffect(() => { windowed.containerRef.current?.scrollTo({ top: 0 }) }, [keyword, network, proxyFilter, windowed.containerRef])

  const chainText = (c: ConnItem): string => [...c.chains].reverse().join(' → ') || '—'
  const isReject = (c: ConnItem): boolean => c.chains.includes('REJECT')

  return (
    <div className="pg-connections">
      <div className="toolbar">
        <div className="search-wrap">
          <Icon name="search" />
          <Input
            placeholder="搜索主机 / 进程 / 规则"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <span className="chip">
          {list.length === visiblePayload.connections.length
            ? `${visiblePayload.connections.length} 个连接`
            : `${list.length} / ${visiblePayload.connections.length} 个连接`}
        </span>
        <Badge tone="purple">↑ {fmtSpeed(topUpSpeed)}</Badge>
        <Badge tone="cyan">↓ {fmtSpeed(topDownSpeed)}</Badge>
        <div className="spacer" />
        <Seg
          items={[
            { value: 'all', label: '全部' },
            { value: 'direct', label: 'DIRECT' },
            { value: 'proxy', label: '代理' },
            { value: 'reject', label: 'REJECT' },
          ]}
          value={proxyFilter}
          onChange={setProxyFilter}
        />
        <Seg
          items={[
            { value: 'all', label: '全部' },
            { value: 'tcp', label: 'TCP' },
            { value: 'udp', label: 'UDP' },
          ]}
          value={network}
          onChange={setNetwork}
        />
        <Button variant="danger" onClick={() => void close()} disabled={closing.has('__all__')}>
          <Icon name="x" size={13} />关闭全部
        </Button>
      </div>

      {error && <div role="alert">关闭连接失败：{error}</div>}
      <Card className="conn-card" flush>
        <div className="conn-scroll" ref={windowed.containerRef}>
        {list.length === 0 ? (
          <div className="empty">没有匹配的连接</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>主机</th>
                <th>进程</th>
                <th>规则</th>
                <th>代理链</th>
                <th>上传</th>
                <th>下载</th>
                <th>速率</th>
                <th>时长</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {windowed.before > 0 && <tr aria-hidden="true"><td colSpan={9} style={{ height: windowed.before, padding: 0, border: 0 }} /></tr>}
              {list.slice(windowed.start, windowed.end).map((c) => {
                const r = visualRows.get(c.id) ?? {
                  upload: c.upload,
                  download: c.download,
                  up: c.curUp ?? 0,
                  down: c.curDown ?? 0,
                }
                const speed = r.up + r.down
                // 优先显示进程名，没有进程名时从路径提取文件名，最后才显示 System
                const proc = c.metadata.process ||
                  (c.metadata.processPath ? c.metadata.processPath.split(/[/\\]/).filter(Boolean).pop() : null) ||
                  'System'
                const host = c.metadata.host || c.metadata.destinationIP || c.metadata.sourceIP || '—'
                const port = c.metadata.destinationPort ? `:${c.metadata.destinationPort}` : ''
                const ipLine = c.metadata.destinationIP && c.metadata.destinationIP !== host
                  ? c.metadata.destinationIP
                  : ''
                const ruleText = c.rule
                  ? `${c.rule}${c.rulePayload ? `:${c.rulePayload}` : ''}`
                  : '—'
                return (
                  <tr key={c.id} className="conn-row">
                    <td className="host-cell">
                      <div className="h">
                        {host}
                        {port && <span className="port">{port}</span>}
                        {c.metadata.network === 'udp' && (
                          <span className="chip" style={{ marginLeft: 6 }}>UDP</span>
                        )}
                      </div>
                      {ipLine && <div className="ip">{ipLine}</div>}
                    </td>
                    <td>
                      <span className="proc" style={{ color: procColor(proc) }}>
                        <i style={{ background: 'currentcolor' }} />
                        <span style={{ color: 'var(--text)' }}>{proc}</span>
                      </span>
                    </td>
                    <td>
                      <span className={isReject(c) ? 'chip rj' : 'chip'}>
                        {ruleText}
                      </span>
                    </td>
                    <td>
                      <span className={isReject(c) ? 'chain reject' : 'chain'}>
                        {isReject(c) ? 'REJECT' : chainText(c)}
                      </span>
                    </td>
                    <td className="num">{fmtBytes(r.upload)}</td>
                    <td className="num">{fmtBytes(r.download)}</td>
                    <td>
                      {speed > 0 ? (
                        <Badge tone="cyan">{fmtSpeed(speed)}</Badge>
                      ) : (
                        <Badge tone="gray">0 B/s</Badge>
                      )}
                    </td>
                    <td className="num dur">{connDuration(c.start)}</td>
                    <td>
                      <button
                        className="icon-btn"
                        title="关闭连接"
                        onClick={() => void close(c.id)}
                        disabled={closing.has(c.id) || closing.has('__all__')}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </td>
                  </tr>
                )
              })}
              {windowed.after > 0 && <tr aria-hidden="true"><td colSpan={9} style={{ height: windowed.after, padding: 0, border: 0 }} /></tr>}
            </tbody>
          </table>
        )}
        </div>
      </Card>
    </div>
  )
}
