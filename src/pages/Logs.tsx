import { useEffect, useMemo, useRef, useState } from 'react'
import './Logs.css'
import Badge, { type BadgeTone } from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Seg from '../components/ui/Seg'
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

  const [level, setLevel] = useState('all')
  const [keyword, setKeyword] = useState('')
  const consoleRef = useRef<HTMLDivElement>(null)

  useEffect(() => startLiveStreams(), [])

  /* 自动滚底(暂停时不滚) */
  useEffect(() => {
    if (paused) return
    const el = consoleRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, paused])

  const list = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return logs.filter((l) => {
      if (level !== 'all' && l.type !== level) return false
      if (kw && !l.payload.toLowerCase().includes(kw)) return false
      return true
    })
  }, [logs, level, keyword])

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
        <Button onClick={() => setPaused(!paused)}>
          <Icon name={paused ? 'play' : 'pause'} size={13} />
          {paused ? '继续' : '暂停'}
        </Button>
        <Button onClick={clearLogs}>
          <Icon name="trash" size={13} />清空
        </Button>
      </div>

      <Card flush>
        <div className="console" ref={consoleRef}>
          {list.length === 0 ? (
            <div className="empty">暂无日志</div>
          ) : (
            list.map((l, i) => (
              <div className="line" key={`${l.time}-${i}`}>
                <span className="ts">{l.time}</span>
                <Badge tone={LEVEL_TONE[l.type]}>{LEVEL_TEXT[l.type]}</Badge>
                <span className="msg">{renderMsg(l.payload)}</span>
              </div>
            ))
          )}
        </div>
        <div className="foot">
          <span className="dot" />
          已缓冲 {logs.length.toLocaleString()} 行 · WebSocket 已连接
          {paused && <span style={{ color: 'var(--orange)' }}>（已暂停）</span>}
        </div>
      </Card>
    </div>
  )
}
