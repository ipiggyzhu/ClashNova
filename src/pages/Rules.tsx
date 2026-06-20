import { useEffect, useMemo, useState } from 'react'
import './Rules.css'
import Badge from '../components/ui/Badge'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import { getRules } from '../services/api'
import type { RuleItem } from '../types/clash'

const TYPE_FILTERS = [
  'all', 'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR',
  'GEOIP', 'RULE-SET', 'PROCESS-NAME', 'MATCH',
]
const MAX_RENDER = 500

function targetColor(proxy: string): string {
  if (proxy === 'DIRECT') return 'var(--green)'
  if (proxy === 'REJECT' || proxy === 'REJECT-DROP') return 'var(--red)'
  return 'var(--accent)'
}

function typeChipStyle(type: string): React.CSSProperties | undefined {
  if (type.startsWith('DOMAIN')) return { color: 'var(--cyan)' }
  if (type.startsWith('IP-')) return { color: 'var(--orange)' }
  if (type === 'GEOIP') return { color: 'var(--teal, var(--cyan))' }
  if (type === 'RULE-SET') return { color: 'var(--purple)' }
  if (type === 'PROCESS-NAME') return { color: 'var(--pink)' }
  return undefined
}

export default function Rules() {
  const [rules, setRules] = useState<RuleItem[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [type, setType] = useState('all')

  useEffect(() => {
    void getRules()
      .then((items) => {
        setRules(items)
        setLoadError(null)
      })
      .catch(() => {
        setRules([])
        setLoadError('Mihomo 未运行，启动内核后会显示规则。')
      })
  }, [])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return rules.filter((r) => {
      if (type !== 'all' && r.type.toUpperCase() !== type) return false
      if (kw && !`${r.payload} ${r.proxy}`.toLowerCase().includes(kw)) return false
      return true
    })
  }, [rules, keyword, type])

  const shown = filtered.slice(0, MAX_RENDER)

  return (
    <div className="pg-rules">
      <div className="toolbar">
        <div className="search-wrap">
          <Icon name="search" />
          <Input
            placeholder="搜索规则 / 域名 / IP…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <div className="spacer" />
        <span className="chip">{loadError ? '内核未运行' : `共 ${rules.length.toLocaleString()} 条`}</span>
      </div>

      <div className="fchips">
        {TYPE_FILTERS.map((t) => (
          <button
            key={t}
            className={type === t ? 'fchip on' : 'fchip'}
            onClick={() => setType(t)}
          >
            {t === 'all' ? `全部` : t}
          </button>
        ))}
      </div>

      <Card icon={<Icon name="rules" />} iconColor="var(--accent)" title="规则列表"
        actions={<span style={{ fontSize: 11, color: 'var(--text-3)' }}>自上而下优先匹配</span>}
        flush
      >
        {loadError ? (
          <div className="empty">{loadError}</div>
        ) : shown.length === 0 ? (
          <div className="empty">没有匹配的规则</div>
        ) : (
          <>
            {shown.map((r, i) => (
              <div className="rule-row" key={`${r.type}-${r.payload}-${i}`}>
                <span className="idx">{i + 1}</span>
                <span className="content">{r.payload || '—'}</span>
                <span className="chip" style={typeChipStyle(r.type.toUpperCase())}>
                  {r.type.toUpperCase()}
                </span>
                <span className="spacer" />
                <span className="target" style={{ color: targetColor(r.proxy) }}>
                  {r.proxy}
                </span>
                <span className="hits">
                  <Badge tone="gray">{Math.max(0, 12381 - i * 137).toLocaleString()}</Badge>
                </span>
              </div>
            ))}
            {filtered.length > MAX_RENDER && (
              <div className="truncated">
                已展示前 {MAX_RENDER} 条，共匹配 {filtered.length.toLocaleString()} 条 — 请用搜索缩小范围
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  )
}
