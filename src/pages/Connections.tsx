import { useEffect, useMemo, useRef, useState } from 'react'
import './Connections.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Seg from '../components/ui/Seg'
import { closeAllConnections, closeConnection } from '../services/api'
import { startLiveStreams, useLiveStore } from '../stores/live'
import type { ConnItem } from '../types/clash'
import { fmtBytes, fmtDuration, fmtSpeed } from '../utils/format'

const PROC_COLORS = ['#64D2FF', '#BF5AF2', '#FF9F0A', '#32D74B', '#FF375F', '#FFD60A', '#40C8E0']
const CONNECTION_FRAME_MS = 100
const CONNECTION_RATE_SMOOTHING_MS = 380
const CONNECTION_BYTES_SMOOTHING_MS = 260
const CONNECTION_RATE_EMA = 0.58

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

function expStep(from: number, to: number, dtMs: number, smoothingMs: number): number {
  const alpha = 1 - Math.exp(-dtMs / smoothingMs)
  const next = from + (to - from) * alpha
  return Math.abs(next - to) < 1 ? to : next
}

function blendRate(previous: number, raw: number): number {
  return previous + (raw - previous) * CONNECTION_RATE_EMA
}

export default function Connections() {
  const payload = useLiveStore((s) => s.connections)
  const [visiblePayload, setVisiblePayload] = useState(payload)
  const [keyword, setKeyword] = useState('')
  const [network, setNetwork] = useState('all')
  const [proxyFilter, setProxyFilter] = useState('all')
  const prevCountersRef = useRef<Map<string, { up: number; down: number }>>(new Map())
  const prevSnapshotTimeRef = useRef<number>(performance.now())
  const targetRowsRef = useRef<Map<string, ConnVisualRow>>(new Map())
  const visualRowsRef = useRef<Map<string, ConnVisualRow>>(new Map())
  const orderRef = useRef<Map<string, number>>(new Map())
  const orderSeqRef = useRef(0)
  const [visualRows, setVisualRows] = useState<Map<string, ConnVisualRow>>(new Map())

  useEffect(() => startLiveStreams(), [])

  useEffect(() => {
    const prev = prevCountersRef.current
    const previousTargets = targetRowsRef.current
    const now = performance.now()
    const elapsedSec = Math.max(0.25, (now - prevSnapshotTimeRef.current) / 1000)
    const seen = new Set<string>()
    const nextCounters = new Map<string, { up: number; down: number }>()
    const nextTargets = new Map<string, ConnVisualRow>()
    let visualChanged = false

    for (const c of payload.connections) {
      seen.add(c.id)
      if (!orderRef.current.has(c.id)) {
        orderRef.current.set(c.id, orderSeqRef.current)
        orderSeqRef.current += 1
      }

      nextCounters.set(c.id, { up: c.upload, down: c.download })
      const p = prev.get(c.id)
      const rawUp = c.curUp ?? (p ? Math.max(0, (c.upload - p.up) / elapsedSec) : 0)
      const rawDown = c.curDown ?? (p ? Math.max(0, (c.download - p.down) / elapsedSec) : 0)
      const previousTarget = previousTargets.get(c.id)
      const target = {
        upload: c.upload,
        download: c.download,
        up: previousTarget ? blendRate(previousTarget.up, rawUp) : rawUp,
        down: previousTarget ? blendRate(previousTarget.down, rawDown) : rawDown,
      }
      nextTargets.set(c.id, target)
      if (!visualRowsRef.current.has(c.id)) {
        visualRowsRef.current.set(c.id, target)
        visualChanged = true
      }
    }

    for (const id of orderRef.current.keys()) {
      if (!seen.has(id)) orderRef.current.delete(id)
    }
    for (const id of visualRowsRef.current.keys()) {
      if (!seen.has(id)) {
        visualRowsRef.current.delete(id)
        visualChanged = true
      }
    }

    prevCountersRef.current = nextCounters
    targetRowsRef.current = nextTargets
    prevSnapshotTimeRef.current = now

    const ordered = [...payload.connections].sort(
      (a, b) => (orderRef.current.get(a.id) ?? 0) - (orderRef.current.get(b.id) ?? 0),
    )
    setVisiblePayload({
      uploadTotal: payload.uploadTotal,
      downloadTotal: payload.downloadTotal,
      connections: ordered,
    })
    if (visualChanged) setVisualRows(new Map(visualRowsRef.current))
  }, [payload])

  useEffect(() => {
    let last = performance.now()

    const timer = window.setInterval(() => {
      const now = performance.now()
      const dt = Math.max(1, now - last)
      last = now
      let changed = false

      for (const [id, target] of targetRowsRef.current) {
        const current = visualRowsRef.current.get(id) ?? target
        const next = {
          upload: expStep(current.upload, target.upload, dt, CONNECTION_BYTES_SMOOTHING_MS),
          download: expStep(current.download, target.download, dt, CONNECTION_BYTES_SMOOTHING_MS),
          up: expStep(current.up, target.up, dt, CONNECTION_RATE_SMOOTHING_MS),
          down: expStep(current.down, target.down, dt, CONNECTION_RATE_SMOOTHING_MS),
        }
        if (
          next.upload !== current.upload ||
          next.download !== current.download ||
          next.up !== current.up ||
          next.down !== current.down
        ) {
          visualRowsRef.current.set(id, next)
          changed = true
        }
      }

      if (changed) {
        setVisualRows(new Map(visualRowsRef.current))
      }
    }, CONNECTION_FRAME_MS)

    return () => window.clearInterval(timer)
  }, [])

  const upSpeed = useMemo(
    () => [...visualRows.values()].reduce((s, r) => s + r.up, 0),
    [visualRows],
  )
  const downSpeed = useMemo(
    () => [...visualRows.values()].reduce((s, r) => s + r.down, 0),
    [visualRows],
  )

  const list = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return visiblePayload.connections.filter((c) => {
      if (network !== 'all' && c.metadata.network !== network) return false
      // 代理筛选
      if (proxyFilter !== 'all') {
        const lastProxy = c.chains[c.chains.length - 1] ?? ''
        if (proxyFilter === 'direct' && lastProxy !== 'DIRECT') return false
        if (proxyFilter === 'proxy' && (lastProxy === 'DIRECT' || lastProxy === 'REJECT')) return false
        if (proxyFilter === 'reject' && lastProxy !== 'REJECT') return false
      }
      if (!kw) return true
      const hay = `${c.metadata.host} ${c.metadata.process ?? ''} ${c.rule} ${c.rulePayload} ${c.chains.join(' ')}`.toLowerCase()
      return hay.includes(kw)
    })
  }, [visiblePayload, keyword, network, proxyFilter])

  const chainText = (c: ConnItem): string => [...c.chains].reverse().join(' → ')
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
        <Badge tone="purple">↑ {fmtSpeed(upSpeed)}</Badge>
        <Badge tone="cyan">↓ {fmtSpeed(downSpeed)}</Badge>
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
        <Button variant="danger" onClick={() => void closeAllConnections()}>
          <Icon name="x" size={13} />关闭全部
        </Button>
      </div>

      <Card className="conn-card" flush>
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
              {list.map((c) => {
                const r = visualRows.get(c.id) ?? targetRowsRef.current.get(c.id) ?? {
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
                return (
                  <tr key={c.id}>
                    <td className="host-cell">
                      <div className="h">
                        {c.metadata.host || c.metadata.destinationIP}
                        <span className="port">:{c.metadata.destinationPort}</span>
                        {c.metadata.network === 'udp' && (
                          <span className="chip" style={{ marginLeft: 6 }}>UDP</span>
                        )}
                      </div>
                      <div className="ip">{c.metadata.destinationIP}</div>
                    </td>
                    <td>
                      <span className="proc" style={{ color: procColor(proc) }}>
                        <i style={{ background: 'currentcolor' }} />
                        <span style={{ color: 'var(--text)' }}>{proc}</span>
                      </span>
                    </td>
                    <td>
                      <span className={isReject(c) ? 'chip rj' : 'chip'}>
                        {c.rule}{c.rulePayload ? `:${c.rulePayload}` : ''}
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
                        onClick={() => void closeConnection(c.id)}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
