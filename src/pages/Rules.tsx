import { useMemo, useState } from 'react'
import './Rules.css'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import { getRules } from '../services/api'
import { usePollingQuery } from '../hooks/usePollingQuery'
import { normalizeRuleType } from '../utils/rules'
import type { RuleItem } from '../types/clash'

const TYPE_FILTERS = [
  'all', 'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR',
  'GEOIP', 'RULE-SET', 'PROCESS-NAME', 'MATCH',
]
const PAGE_SIZE = 100
const EMPTY_RULES: RuleItem[] = []

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
  const { data: rules, error: loadError } = usePollingQuery(getRules, EMPTY_RULES)
  const [keyword, setKeyword] = useState('')
  const [type, setType] = useState('all')
  const [page, setPage] = useState(0)
  const indexed = useMemo(() => rules.map((rule, index) => ({ ...rule, index: index + 1, type: normalizeRuleType(rule.type) })), [rules])
  const filters = useMemo(() => [...new Set([...TYPE_FILTERS, ...indexed.map((rule) => rule.type)])], [indexed])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return indexed.filter((r) => {
      if (type !== 'all' && r.type !== type) return false
      if (kw && !`${r.payload} ${r.proxy}`.toLowerCase().includes(kw)) return false
      return true
    })
  }, [indexed, keyword, type])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const shown = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)

  return (
    <div className="pg-rules">
      <div className="toolbar">
        <div className="search-wrap">
          <Icon name="search" />
          <Input
            placeholder="搜索规则 / 域名 / IP…"
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value); setPage(0) }}
          />
        </div>
        <div className="spacer" />
        <span className="chip">{loadError ? '规则加载失败' : `共 ${rules.length.toLocaleString()} 条`}</span>
      </div>

      <div className="fchips">
        {filters.map((t) => (
          <button
            key={t}
            className={type === t ? 'fchip on' : 'fchip'}
            aria-pressed={type === t}
            onClick={() => { setType(t); setPage(0) }}
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
          <div className="empty" role="alert">{loadError}</div>
        ) : shown.length === 0 ? (
          <div className="empty">没有匹配的规则</div>
        ) : (
          <>
            {shown.map((r) => (
              <div className="rule-row" key={r.index}>
                <span className="idx">{r.index}</span>
                <span className="content">{r.payload || '—'}</span>
                <span className="chip" style={typeChipStyle(r.type.toUpperCase())}>
                  {r.type.toUpperCase()}
                </span>
                <span className="spacer" />
                <span className="target" style={{ color: targetColor(r.proxy) }}>
                  {r.proxy}
                </span>
              </div>
            ))}
            <div className="pagination" aria-label="规则分页">
              <Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button>
              <span>第 {currentPage + 1} / {pageCount} 页 · {filtered.length.toLocaleString()} 条</span>
              <Button size="sm" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
