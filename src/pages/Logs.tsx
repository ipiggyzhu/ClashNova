import { useEffect, useMemo, useRef, useState } from 'react'
import './Logs.css'
import Badge, { type BadgeTone } from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Seg from '../components/ui/Seg'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { useAppStore } from '../stores/app'
import { startLiveStreams, useLiveStore } from '../stores/live'
import type { LogItem } from '../types/clash'

const LEVEL_TONE: Record<LogItem['type'], BadgeTone> = {
  info: 'blue',
  warning: 'orange',
  error: 'red',
  debug: 'gray',
}
const LEVEL_TEXT: Record<LogItem['type'], string> = {
  info: 'INFO',
  warning: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
}

/** 高亮日志关键词: 节点名(using X)青色, 规则(match X / RuleSet(X))绿色 */
function renderMsg(payload: string) {
  const parts: React.ReactNode[] = []
  const re = /(using\s+\S+)|((?:match\s+)?RuleSet\([^)]*\)|match\s+\S+)/g
  let lastIdx = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(payload)) !== null) {
    if (m.index > lastIdx) parts.push(payload.slice(lastIdx, m.index))
    parts.push(
      <span key={key++} className={m[1] ? 'hl-node' : 'hl-rule'}>
        {m[0]}
      </span>,
    )
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < payload.length) parts.push(payload.slice(lastIdx))
  return parts
}

export default function Logs() {
  const logs = useLiveStore((s) => s.logs)
  const paused = useLiveStore((s) => s.logsPaused)
  const setPaused = useLiveStore((s) => s.setLogsPaused)
  const clearLogs = useLiveStore((s) => s.clearLogs)
  const logLevel = useAppStore((s) => s.settings.logLevel)
  const status = useLiveStore((s) => s.status.logs)

  const [level, setLevel] = useState('all')
  const [keyword, setKeyword] = useState('')
  const followTail = useRef(true)

  useEffect(() => startLiveStreams(['logs']), [])

  const list = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return logs.filter((l) => {
      if (level !== 'all' && l.type !== level) return false
      if (kw && !l.payload.toLowerCase().includes(kw)) return false
      return true
    })
  }, [logs, level, keyword])

  const windowed = useVirtualRows(list.length, 24, 12)
  useEffect(() => {
    if (paused || !followTail.current) return
    const el = windowed.containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, list, paused, windowed.containerRef])
  const statusText = { connected: 'WebSocket 已连接', connecting: 'WebSocket 连接中', disconnected: 'WebSocket 已断开', paused: '窗口隐藏，已暂停连接' }[status]

  return (
    <div className="pg-logs">
      <div className="toolbar">
        <Seg
          items={[
            { value: 'all', label: '全部' },
            { value: 'info', label: '信息' },
            { value: 'warning', label: '警告' },
            { value: 'error', label: '错误' },
            { value: 'debug', label: '调试' },
          ]}
          value={level}
          onChange={setLevel}
        />
        <div className="search-wrap">
          <Icon name="search" />
          <Input
            placeholder="过滤关键字…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <div className="spacer" />
        <span className="chip">日志等级: {logLevel}</span>
        <Button onClick={() => { followTail.current = true; setPaused(!paused) }}>
          <Icon name={paused ? 'play' : 'pause'} size={13} />
          {paused ? '继续' : '暂停'}
        </Button>
        <Button onClick={clearLogs}>
          <Icon name="trash" size={13} />清空
        </Button>
      </div>

      <Card flush>
        <div className="console" ref={windowed.containerRef} role="region" aria-label="内核日志" tabIndex={0}
          onScroll={(event) => {
            const el = event.currentTarget
            followTail.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          }}>
          {list.length === 0 ? (
            <div className="empty">暂无日志</div>
          ) : (
            <>
            <div aria-hidden="true" style={{ height: windowed.before }} />
            {list.slice(windowed.start, windowed.end).map((l) => (
              <div className="line" key={l.id}>
                <span className="ts">{l.time}</span>
                <Badge tone={LEVEL_TONE[l.type]}>{LEVEL_TEXT[l.type]}</Badge>
                <span className="msg">{renderMsg(l.payload)}</span>
              </div>
            ))}
            <div aria-hidden="true" style={{ height: windowed.after }} />
            </>
          )}
        </div>
        <div className="foot">
          <span className="dot" style={status === 'connected' ? undefined : { background: 'var(--text-3)', boxShadow: 'none' }} />
          已缓冲 {logs.length.toLocaleString()} 行 · {statusText}
          {paused && <span style={{ color: 'var(--orange)' }}>（已暂停）</span>}
        </div>
      </Card>
    </div>
  )
}
