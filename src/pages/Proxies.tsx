import { useCallback, useEffect, useMemo, useState } from 'react'
import './Proxies.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Seg from '../components/ui/Seg'
import { getProxies, selectProxy, testDelay } from '../services/api'
import type { ProxiesPayload, ProxyGroup, ProxyNode } from '../types/clash'
import { delayTone } from '../utils/format'

const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance'])
const GROUP_COLORS = ['var(--accent)', 'var(--purple)', 'var(--orange)', 'var(--cyan)', 'var(--pink)']

interface GroupView extends ProxyGroup {
  nodes: ProxyNode[]
}

/** 并发上限的批量执行 */
async function runLimited(jobs: (() => Promise<void>)[], limit = 8): Promise<void> {
  const queue = [...jobs]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await job()
  })
  await Promise.all(workers)
}

function latestDelay(node: ProxyNode): number | undefined {
  if (node.delay !== undefined) return node.delay
  const last = node.history[node.history.length - 1]
  return last?.delay
}

function delayKey(group: string, node: string): string {
  return `${group}\u0000${node}`
}

export default function Proxies() {
  const [payload, setPayload] = useState<ProxiesPayload | null>(null)
  const [keyword, setKeyword] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ Fallback: true })
  /** 节点名 → 实测延迟(0 表示测试中, -1 表示超时) */
  const [delays, setDelays] = useState<Record<string, number>>({})
  const [testingGroups, setTestingGroups] = useState<Set<string>>(new Set())
  const [testingAll, setTestingAll] = useState(false)

  const refresh = useCallback(async () => {
    setPayload(await getProxies())
  }, [])

  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  const groups: GroupView[] = useMemo(() => {
    if (!payload) return []
    const all = payload.proxies
    return Object.values(all)
      .filter((p): p is ProxyNode & ProxyGroup => GROUP_TYPES.has(p.type) && Array.isArray(p.all))
      .filter((g) => g.name !== 'GLOBAL')
      .map((g) => ({
        name: g.name,
        type: g.type,
        now: g.now,
        all: g.all,
        nodes: g.all.map((n) => all[n]).filter((n): n is ProxyNode => n !== undefined),
      }))
  }, [payload])

  const totalNodes = useMemo(() => {
    if (!payload) return 0
    return Object.values(payload.proxies).filter((p) => !GROUP_TYPES.has(p.type) && p.type !== 'Direct' && p.type !== 'Reject').length
  }, [payload])

  const visibleGroups = groups
    .filter((g) => typeFilter === 'all' || g.type === typeFilter)
    .map((g) => ({
      ...g,
      nodes: keyword
        ? g.nodes.filter((n) => n.name.toLowerCase().includes(keyword.toLowerCase()))
        : g.nodes,
    }))

  const handleSelect = async (group: string, name: string): Promise<void> => {
    /* 乐观更新 */
    setPayload((prev) => {
      if (!prev) return prev
      const g = prev.proxies[group]
      if (!g) return prev
      return { proxies: { ...prev.proxies, [group]: { ...g, now: name } } }
    })
    try {
      await selectProxy(group, name)
    } catch {
      await refresh().catch(() => {})
    }
  }

  const testNode = async (group: string, name: string): Promise<void> => {
    const key = delayKey(group, name)
    setDelays((d) => ({ ...d, [key]: 0 }))
    try {
      const ms = await testDelay(name)
      setDelays((d) => ({ ...d, [key]: ms }))
    } catch {
      setDelays((d) => ({ ...d, [key]: -1 }))
    }
  }

  const testGroup = async (g: GroupView): Promise<void> => {
    setTestingGroups((prev) => new Set(prev).add(g.name))
    try {
      await runLimited(g.nodes.map((n) => () => testNode(g.name, n.name)))
    } finally {
      setTestingGroups((prev) => {
        const next = new Set(prev)
        next.delete(g.name)
        return next
      })
    }
  }

  const testAll = async (): Promise<void> => {
    setTestingAll(true)
    try {
      for (const g of groups) await testGroup(g)
    } finally {
      setTestingAll(false)
    }
  }

  const renderDelay = (group: string, node: ProxyNode) => {
    const d = delays[delayKey(group, node.name)] ?? latestDelay(node)
    if (d === 0) return <span className="testing">测速中…</span>
    if (d === undefined) return <Badge tone="gray">— ms</Badge>
    if (d === -1 || d > 2000) return <Badge tone="red">超时</Badge>
    return <Badge tone={delayTone(d)}>{d} ms</Badge>
  }

  return (
    <div className="pg-proxies">
      <div className="toolbar">
        <div className="search-wrap">
          <Icon name="search" />
          <Input
            placeholder="搜索节点 / 代理组"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <Seg
          items={[
            { value: 'all', label: '全部' },
            { value: 'Selector', label: 'Selector' },
            { value: 'URLTest', label: 'URLTest' },
            { value: 'Fallback', label: 'Fallback' },
          ]}
          value={typeFilter}
          onChange={setTypeFilter}
        />
        <div className="spacer" />
        <span className="chip">共{totalNodes}个节点</span>
        <Button variant="primary" onClick={() => void testAll()} disabled={testingAll}>
          <Icon name="zap" size={13} />
          {testingAll ? '测速中…' : '全部测速'}
        </Button>
      </div>

      {visibleGroups.map((g, i) => {
        const isOpen = !collapsed[g.name]
        const isTestingGroup = testingGroups.has(g.name)
        return (
          <Card
            key={g.name}
            icon={<Icon name="proxies" />}
            iconColor={GROUP_COLORS[i % GROUP_COLORS.length]}
            title={g.name}
            actions={
              <>
                <span className="chip">{g.type}</span>
                <span className="grp-now">当前: <b>{g.now}</b></span>
                <Badge tone="green">{g.all.length} 个节点</Badge>
                <Button size="sm" onClick={() => void testGroup(g)} disabled={isTestingGroup || testingAll}>
                  {isTestingGroup ? '测速中…' : '测速'}
                </Button>
                <button
                  className="icon-btn"
                  title={isOpen ? '折叠' : '展开'}
                  onClick={() => setCollapsed((c) => ({ ...c, [g.name]: isOpen }))}
                >
                  <span className={isOpen ? 'chev open' : 'chev'}>
                    <Icon name="chevron-down" />
                  </span>
                </button>
              </>
            }
            flush={!isOpen}
          >
            {isOpen && (
              <div className="node-grid">
                {g.nodes.map((n) => {
                  const sel = n.name === g.now
                  return (
                    <button
                      key={n.name}
                      className={sel ? 'node sel' : 'node'}
                      onClick={() => void handleSelect(g.name, n.name)}
                      onDoubleClick={() => void testNode(g.name, n.name)}
                      title="单击切换 · 双击测速"
                    >
                      <div className="nm">{n.name}</div>
                      {sel && (
                        <span className="sel-mark">
                          <Icon name="check" size={13} />
                        </span>
                      )}
                      <div className="meta">
                        <span className="chip">{n.type}</span>
                        {renderDelay(g.name, n)}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </Card>
        )
      })}
    </div>
  )
}
