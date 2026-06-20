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

const COLLAPSED_KEY = 'proxies:collapsed'

function loadCollapsed(): Record<string, boolean> {
  try {
    const saved = localStorage.getItem(COLLAPSED_KEY)
    return saved ? JSON.parse(saved) : { Fallback: true }
  } catch {
    return { Fallback: true }
  }
}

function saveCollapsed(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

export default function Proxies() {
  const [payload, setPayload] = useState<ProxiesPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed)
  /** 节点名 → 实测延迟(0 表示测试中, -1 表示超时) */
  const [delays, setDelays] = useState<Record<string, number>>({})
  const [testingGroups, setTestingGroups] = useState<Set<string>>(new Set())
  const [testingAll, setTestingAll] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setPayload(await getProxies())
      setLoadError(null)
    } catch {
      setPayload(null)
      setLoadError('Mihomo 未运行，启动内核后会显示节点。')
    }
  }, [])

  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  const groups: GroupView[] = useMemo(() => {
    if (!payload) return []
    const all = payload.proxies
    // 所有真实节点（非策略组、非 DIRECT/REJECT）
    const realNodes = Object.values(all).filter(
      (p) => !GROUP_TYPES.has(p.type) && p.type !== 'Direct' && p.type !== 'Reject',
    ) as ProxyNode[]
    // 策略组
    const strategyGroups = Object.values(all)
      .filter((p): p is ProxyNode & ProxyGroup => GROUP_TYPES.has(p.type) && Array.isArray(p.all))
      .filter((g) => g.name !== 'GLOBAL')
      .map((g) => ({
        name: g.name,
        type: g.type,
        now: g.now,
        all: g.all,
        nodes: g.all.map((n) => all[n]).filter((n): n is ProxyNode => n !== undefined),
      }))
    // 顶部插入"全部节点"虚拟组，确保所有节点都可见
    if (realNodes.length > 0) {
      strategyGroups.unshift({
        name: '全部节点',
        type: 'Selector',
        now: '',
        all: realNodes.map((n) => n.name),
        nodes: realNodes,
      })
    }
    return strategyGroups
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
        <span className="chip">{loadError ? '内核未运行' : `共${totalNodes}个节点`}</span>
        <Button variant="primary" onClick={() => void testAll()} disabled={testingAll || !!loadError || totalNodes === 0}>
          <Icon name="zap" size={13} />
          {testingAll ? '测速中…' : '全部测速'}
        </Button>
      </div>

      {loadError ? (
        <Card icon={<Icon name="proxies" />} iconColor="var(--accent)" title="节点列表" flush>
          <div className="empty">{loadError}</div>
        </Card>
      ) : visibleGroups.map((g, i) => {
        const isOpen = !collapsed[g.name]
        const isTestingGroup = testingGroups.has(g.name)
        const isVirtualGroup = g.name === '全部节点'
        return (
          <Card
            key={g.name}
            icon={<Icon name="proxies" />}
            iconColor={GROUP_COLORS[i % GROUP_COLORS.length]}
            title={g.name}
            actions={
              <>
                {!isVirtualGroup && <span className="chip">{g.type}</span>}
                {!isVirtualGroup && <span className="grp-now">当前: <b>{g.now}</b></span>}
                <Badge tone="green">{g.all.length} 个节点</Badge>
                <Button size="sm" onClick={() => void testGroup(g)} disabled={isTestingGroup || testingAll}>
                  {isTestingGroup ? '测速中…' : '测速'}
                </Button>
                <button
                  className="icon-btn"
                  title={isOpen ? '折叠' : '展开'}
                  onClick={() => setCollapsed((c) => {
                    const next = { ...c, [g.name]: isOpen }
                    saveCollapsed(next)
                    return next
                  })}
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
                      onClick={isVirtualGroup ? undefined : () => void handleSelect(g.name, n.name)}
                      onDoubleClick={() => void testNode(g.name, n.name)}
                      title={isVirtualGroup ? '双击测速' : '单击切换 · 双击测速'}
                      style={isVirtualGroup ? { cursor: 'default' } : undefined}
                    >
                      <div className="nm">{n.name}</div>
                      {sel && !isVirtualGroup && (
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
