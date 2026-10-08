import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

function latestDelay(node: ProxyNode): number | undefined {
  if (node.delay !== undefined) return node.delay
  const last = node.history[node.history.length - 1]
  return last?.delay
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
  const [selecting, setSelecting] = useState<Set<string>>(new Set())
  const [actionError, setActionError] = useState<string | null>(null)
  const selectingRef = useRef(new Set<string>())
  const testingRef = useRef(new Map<string, Promise<void>>())
  const groupTestsRef = useRef(new Set<string>())
  const testingAllRef = useRef(false)
  const generation = useRef(0)
  const loadGeneration = useRef(0)
  const alive = useRef(true)
  const refreshFlight = useRef<Promise<void> | null>(null)

  const refresh = useCallback(async () => {
    if (refreshFlight.current) return refreshFlight.current
    if (selectingRef.current.size) return
    const current = loadGeneration.current
    const task = getProxies().then((value) => {
      if (!alive.current || current !== loadGeneration.current) return
      setPayload(value)
      setLoadError(null)
    }, (error: unknown) => {
      if (!alive.current || current !== loadGeneration.current) return
      setLoadError(`节点加载失败：${String(error)}`)
    }).finally(() => { refreshFlight.current = null })
    refreshFlight.current = task
    return task
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh().catch(() => {})
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh().catch(() => {})
    }
    const timer = window.setInterval(refreshWhenVisible, 5000)
    const reconfigure = (): void => {
      generation.current += 1
      loadGeneration.current += 1
      setDelays({})
      void (refreshFlight.current ?? Promise.resolve()).then(refreshWhenVisible)
    }
    window.addEventListener('clashnova-api-config-changed', reconfigure)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      alive.current = false
      window.clearInterval(timer)
      window.removeEventListener('clashnova-api-config-changed', reconfigure)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
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
    if (selectingRef.current.has(group)) return
    selectingRef.current.add(group)
    loadGeneration.current += 1
    setSelecting(new Set(selectingRef.current))
    setActionError(null)
    /* 乐观更新 */
    setPayload((prev) => {
      if (!prev) return prev
      const g = prev.proxies[group]
      if (!g) return prev
      return { proxies: { ...prev.proxies, [group]: { ...g, now: name } } }
    })
    try {
      await selectProxy(group, name)
    } catch (error) {
      if (alive.current) setActionError(`切换节点失败：${String(error)}`)
    } finally {
      selectingRef.current.delete(group)
      if (alive.current) {
        setSelecting(new Set(selectingRef.current))
        await refreshFlight.current
        await refresh()
      }
    }
  }

  const testNode = (name: string): Promise<void> => {
    const current = generation.current
    const key = `${current}:${name}`
    const existing = testingRef.current.get(key)
    if (existing) return existing
    setDelays((d) => ({ ...d, [name]: 0 }))
    const test = testDelay(name).then((ms) => {
      if (alive.current && current === generation.current) setDelays((d) => ({ ...d, [name]: ms }))
    }, () => {
      if (alive.current && current === generation.current) setDelays((d) => ({ ...d, [name]: -1 }))
    }).finally(() => { testingRef.current.delete(key) })
    testingRef.current.set(key, test)
    return test
  }

  const testGroup = async (g: GroupView): Promise<void> => {
    if (groupTestsRef.current.has(g.name)) return
    groupTestsRef.current.add(g.name)
    setTestingGroups((prev) => new Set(prev).add(g.name))
    try {
      await Promise.all([...new Set(g.nodes.map((n) => n.name))].map(testNode))
    } finally {
      groupTestsRef.current.delete(g.name)
      setTestingGroups((prev) => {
        const next = new Set(prev)
        next.delete(g.name)
        return next
      })
    }
  }

  const testAll = async (): Promise<void> => {
    if (testingAllRef.current) return
    testingAllRef.current = true
    setTestingAll(true)
    try {
      // 所有组共用同一队列和节点结果；同名节点只测一次，含双击测速也受全局 8 并发限制。
      await Promise.all([...new Set(groups.flatMap((g) => g.all))].map(testNode))
    } finally {
      testingAllRef.current = false
      setTestingAll(false)
    }
  }

  const renderDelay = (node: ProxyNode) => {
    const d = delays[node.name] ?? latestDelay(node)
    if (d === 0) return <span className="testing">测速中…</span>
    if (d === undefined) return <Badge tone="gray">— ms</Badge>
    if (d === -1) return <Badge tone="red">失败 / 超时</Badge>
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

      {actionError && <div role="alert">{actionError}</div>}
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
                      aria-busy={selecting.has(g.name)}
                      aria-pressed={isVirtualGroup ? undefined : sel}
                      onClick={isVirtualGroup ? undefined : () => void handleSelect(g.name, n.name)}
                      onDoubleClick={() => void testNode(n.name)}
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
                        {renderDelay(n)}
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
