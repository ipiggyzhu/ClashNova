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
  const [keyword, setKeyword] = useState('')
  const [network, setNetwork] = useState('all')
  /* 上一帧快照, 用于差分出实时速率 */
  const prevRef = useRef<Map<string, { up: number; down: number }>>(new Map())
  const [rates, setRates] = useState<Map<string, { up: number; down: number }>>(new Map())

  useEffect(() => startLiveStreams(), [])

  useEffect(() => {
    const prev = prevRef.current
    const next = new Map<string, { up: number; down: number }>()
    const nextRates = new Map<string, { up: number; down: number }>()
    for (const c of payload.connections) {
      next.set(c.id, { up: c.upload, down: c.download })
      const p = prev.get(c.id)
      nextRates.set(c.id, {
        up: c.curUp ?? (p ? Math.max(0, c.upload - p.up) : 0),
        down: c.curDown ?? (p ? Math.max(0, c.download - p.down) : 0),
      })
    }
    prevRef.current = next
    setRates(nextRates)
  }, [payload])

  const upSpeed = useMemo(
    () => [...rates.values()].reduce((s, r) => s + r.up, 0),
    [rates],
  )
  const downSpeed = useMemo(
    () => [...rates.values()].reduce((s, r) => s + r.down, 0),
    [rates],
  )

  const list = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return payload.connections.filter((c) => {
      if (network !== 'all' && c.metadata.network !== network) return false
      if (!kw) return true
      const hay = `${c.metadata.host} ${c.metadata.process ?? ''} ${c.rule} ${c.rulePayload} ${c.chains.join(' ')}`.toLowerCase()
      return hay.includes(kw)
    })
  }, [payload, keyword, network])

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
        <span className="chip">{payload.connections.length} 个连接</span>
        <Badge tone="purple">↑ {fmtSpeed(upSpeed)}</Badge>
        <Badge tone="cyan">↓ {fmtSpeed(downSpeed)}</Badge>
        <div className="spacer" />
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

      <Card flush>
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
                const r = rates.get(c.id) ?? { up: 0, down: 0 }
                const speed = r.up + r.down
                const proc = c.metadata.process ?? 'System'
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
                    <td className="num">{fmtBytes(c.upload)}</td>
                    <td className="num">{fmtBytes(c.download)}</td>
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
