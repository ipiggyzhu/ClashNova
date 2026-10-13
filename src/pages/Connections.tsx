import { useEffect, useMemo, useRef, useState } from 'react'
import './Connections.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Dialog from '../components/ui/Dialog'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Seg from '../components/ui/Seg'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { closeAllConnections, closeConnection } from '../services/api'
import { startLiveStreams, useLiveStore, type ClosedConn } from '../stores/live'
import { useNotificationStore } from '../stores/notifications'
import type { ConnItem } from '../types/clash'
import { fmtBytes, fmtDuration, fmtSpeed } from '../utils/format'

type ConnTab = 'active' | 'closed'
type ConnSort = 'default' | 'duration' | 'upload' | 'download' | 'speed'

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

function connDuration(start: string, end = Date.now()): string {
  const sec = Math.max(0, (end - new Date(start).getTime()) / 1000)
  return fmtDuration(sec)
}

function procName(c: ConnItem): string {
  // 优先显示进程名，没有进程名时从路径提取文件名，最后才显示 System
  return c.metadata.process ||
    (c.metadata.processPath ? c.metadata.processPath.split(/[/\\]/).filter(Boolean).pop() : null) ||
    'System'
}

function joinAddr(ip?: string, port?: string): string {
  if (!ip) return ''
  return port ? `${ip.includes(':') ? `[${ip}]` : ip}:${port}` : ip
}

function ConnDetail({ conn, closedAt, onClose, onCloseConn }: {
  conn: ConnItem
  closedAt?: number
  onClose: () => void
  onCloseConn?: () => void
}) {
  const notify = useNotificationStore((s) => s.add)
  const m = conn.metadata
  const rows: [string, string][] = [
    ['主机', m.host ? `${m.host}${m.destinationPort ? `:${m.destinationPort}` : ''}` : ''],
    ['目标地址', joinAddr(m.destinationIP, m.destinationPort)],
    ['目标 ASN', m.destinationIPASN ?? ''],
    ['目标 GeoIP', m.destinationGeoIP?.join(', ') ?? ''],
    ['来源地址', joinAddr(m.sourceIP, m.sourcePort)],
    ['入站', [m.inboundName, joinAddr(m.inboundIP, m.inboundPort)].filter(Boolean).join(' · ')],
    ['入站用户', m.inboundUser ?? ''],
    ['类型', [m.type, m.network.toUpperCase()].filter(Boolean).join(' / ')],
    ['进程', procName(conn)],
    ['进程路径', m.processPath ?? ''],
    ['UID', m.uid === undefined ? '' : String(m.uid)],
    ['规则', conn.rule ? `${conn.rule}${conn.rulePayload ? ` (${conn.rulePayload})` : ''}` : ''],
    ['代理链', [...conn.chains].reverse().join(' → ')],
    ['出口地址', m.remoteDestination ?? ''],
    ['嗅探域名', m.sniffHost ?? ''],
    ['DNS 模式', m.dnsMode ?? ''],
    ['特殊代理', m.specialProxy ?? ''],
    ['特殊规则', m.specialRules ?? ''],
    ['DSCP', m.dscp ? String(m.dscp) : ''],
    ['上传 / 下载', `${fmtBytes(conn.upload)} / ${fmtBytes(conn.download)}`],
    ['开始时间', new Date(conn.start).toLocaleString()],
    ['持续时长', connDuration(conn.start, closedAt)],
    ['关闭时间', closedAt ? new Date(closedAt).toLocaleString() : ''],
    ['连接 ID', conn.id],
  ]
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(conn, null, 2))
      notify('success', '已复制连接详情', conn.metadata.host || conn.metadata.destinationIP || conn.id)
    } catch (err) {
      notify('error', '复制失败', String(err))
    }
  }
  return (
    <Dialog title="连接详情" className="conn-detail-mask" panelClassName="conn-detail" onClose={onClose}>
      <header>
        <h3>连接详情</h3>
        {closedAt ? <Badge tone="gray">已关闭</Badge> : <Badge tone="green">活跃</Badge>}
        <button type="button" className="icon-btn" aria-label="关闭详情" onClick={onClose}><Icon name="x" /></button>
      </header>
      <dl>
        {rows.filter(([, value]) => value).map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
      <footer>
        <Button onClick={() => void copy()}>复制 JSON</Button>
        {onCloseConn && <Button variant="danger" onClick={onCloseConn}><Icon name="x" size={13} />断开连接</Button>}
      </footer>
    </Dialog>
  )
}

export default function Connections() {
  const payload = useLiveStore((s) => s.connections)
  const closedLive = useLiveStore((s) => s.closedConnections)
  const clearClosed = useLiveStore((s) => s.clearClosedConnections)
  const traffic = useLiveStore((s) => s.traffic)
  const [visiblePayload, setVisiblePayload] = useState(payload)
  const [keyword, setKeyword] = useState('')
  const [network, setNetwork] = useState('all')
  const [proxyFilter, setProxyFilter] = useState('all')
  const [tab, setTab] = useState<ConnTab>('active')
  const [sort, setSort] = useState<ConnSort>('default')
  /** 暂停时冻结表格(活跃与已关闭), 后台订阅和历史记录照常进行 */
  const [paused, setPaused] = useState(false)
  const [frozenClosed, setFrozenClosed] = useState<ClosedConn[] | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const closedList = frozenClosed ?? closedLive
  const samplesRef = useRef(new Map<string, ConnRateSample & ConnVisualRow & { connection: ConnItem }>())
  const previousPayload = useRef<typeof payload | null>(null)
  const [visualRows, setVisualRows] = useState<Map<string, ConnVisualRow>>(new Map())
  const [closing, setClosing] = useState<Set<string>>(new Set())
  const closingRef = useRef(new Set<string>())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => startLiveStreams(['connections', 'traffic']), [])

  // 仅在内核快照到达时更新；Map 的插入顺序保留首见次序，不再每 100 ms 扫描/插值全表。
  useEffect(() => {
    if (paused || previousPayload.current === payload) return
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
  }, [payload, paused])

  const togglePause = (): void => {
    setFrozenClosed(paused ? null : closedLive)
    setPaused(!paused)
  }

  const clearHistory = (): void => {
    clearClosed()
    if (paused) setFrozenClosed([])
  }

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

  const list: (ConnItem & { closedAt?: number })[] = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const source: (ConnItem & { closedAt?: number })[] = tab === 'closed' ? closedList : visiblePayload.connections
    const filtered = source.filter((c) => {
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
    if (sort === 'default') return filtered
    const value = (c: ConnItem): number => {
      if (sort === 'duration') return -new Date(c.start).getTime()
      if (sort === 'upload') return c.upload
      if (sort === 'download') return c.download
      const r = visualRows.get(c.id)
      return tab === 'closed' || !r ? 0 : r.up + r.down
    }
    return [...filtered].sort((a, b) => value(b) - value(a))
  }, [visiblePayload, closedList, tab, sort, visualRows, keyword, network, proxyFilter])

  const windowed = useVirtualRows(list.length, 56, 36)
  useEffect(() => { windowed.containerRef.current?.scrollTo({ top: 0 }) }, [keyword, network, proxyFilter, tab, sort, windowed.containerRef])

  const detail = useMemo(() => {
    if (!detailId) return null
    const active = visiblePayload.connections.find((c) => c.id === detailId)
    if (active) return { conn: active, closedAt: undefined }
    const closed = closedList.find((c) => c.id === detailId)
    return closed ? { conn: closed, closedAt: closed.closedAt } : null
  }, [detailId, visiblePayload, closedList])
  const totalCount = tab === 'closed' ? closedList.length : visiblePayload.connections.length

  const chainText = (c: ConnItem): string => [...c.chains].reverse().join(' → ') || '—'
  const isReject = (c: ConnItem): boolean => c.chains.includes('REJECT')

  return (
    <div className="pg-connections">
      <div className="toolbar">
        <Seg<ConnTab>
          label="连接分类"
          items={[
            { value: 'active', label: `活跃 ${visiblePayload.connections.length}` },
            { value: 'closed', label: `已关闭 ${closedList.length}` },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="search-wrap">
          <Icon name="search" />
          <Input
            placeholder="搜索主机 / 进程 / 规则"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <span className="chip">
          {list.length === totalCount
            ? `${totalCount} 个连接`
            : `${list.length} / ${totalCount} 个连接`}
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
        <select className="select" aria-label="排序" value={sort} onChange={(e) => setSort(e.target.value as ConnSort)}>
          <option value="default">默认顺序</option>
          <option value="duration">按时长</option>
          <option value="upload">按上传</option>
          <option value="download">按下载</option>
          <option value="speed">按速率</option>
        </select>
        <Button aria-pressed={paused} title={paused ? '恢复实时刷新' : '冻结当前列表(后台继续记录)'} onClick={togglePause}>
          <Icon name={paused ? 'play' : 'pause'} size={13} />{paused ? '继续' : '暂停'}
        </Button>
        {tab === 'closed' ? (
          <Button variant="danger" onClick={clearHistory} disabled={closedList.length === 0}>
            <Icon name="trash" size={13} />清空记录
          </Button>
        ) : (
          <Button variant="danger" onClick={() => void close()} disabled={closing.has('__all__')}>
            <Icon name="x" size={13} />关闭全部
          </Button>
        )}
      </div>

      {error && <div role="alert">关闭连接失败：{error}</div>}
      {detail && (
        <ConnDetail
          conn={detail.conn}
          closedAt={detail.closedAt}
          onClose={() => setDetailId(null)}
          onCloseConn={detail.closedAt ? undefined : () => { void close(detail.conn.id); setDetailId(null) }}
        />
      )}
      <Card className="conn-card" flush>
        <div className="conn-scroll" ref={windowed.containerRef}>
        {list.length === 0 ? (
          <div className="empty">
            {tab === 'closed' && closedList.length === 0 ? '暂无已关闭的连接(仅记录实时数据订阅期间消失的连接)' : '没有匹配的连接'}
          </div>
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
                <th>{tab === 'closed' ? '关闭于' : '速率'}</th>
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
                const proc = procName(c)
                const host = c.metadata.host || c.metadata.destinationIP || c.metadata.sourceIP || '—'
                const port = c.metadata.destinationPort ? `:${c.metadata.destinationPort}` : ''
                const ipLine = c.metadata.destinationIP && c.metadata.destinationIP !== host
                  ? c.metadata.destinationIP
                  : ''
                const ruleText = c.rule
                  ? `${c.rule}${c.rulePayload ? `:${c.rulePayload}` : ''}`
                  : '—'
                return (
                  <tr
                    key={c.id}
                    className="conn-row"
                    tabIndex={0}
                    title="查看详情"
                    onClick={() => setDetailId(c.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setDetailId(c.id) }}
                  >
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
                      {c.closedAt ? (
                        <span className="num dur">{new Date(c.closedAt).toLocaleTimeString()}</span>
                      ) : speed > 0 ? (
                        <Badge tone="cyan">{fmtSpeed(speed)}</Badge>
                      ) : (
                        <Badge tone="gray">0 B/s</Badge>
                      )}
                    </td>
                    <td className="num dur">{connDuration(c.start, c.closedAt)}</td>
                    <td>
                      {!c.closedAt && (
                        <button
                          className="icon-btn"
                          title="关闭连接"
                          onClick={(e) => { e.stopPropagation(); void close(c.id) }}
                          disabled={closing.has(c.id) || closing.has('__all__')}
                        >
                          <Icon name="x" size={13} />
                        </button>
                      )}
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
