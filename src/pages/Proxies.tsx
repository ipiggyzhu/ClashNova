import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './Proxies.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Seg from '../components/ui/Seg'
import { useT } from '../i18n'
import { closeGroupConnections, getProxies, isDelayTimeout, selectProxy, testDelay, testGroupDelay } from '../services/api'
import { useAppStore } from '../stores/app'
import type { ProxiesPayload, ProxyGroup, ProxyNode } from '../types/clash'
import { delayTone } from '../utils/format'

const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance'])
/** 内置策略组(DIRECT/REJECT)与 mihomo 的伪节点, 不是用户订阅的节点, 不参与列表和计数 */
const BUILTIN_TYPES = new Set(['Direct', 'Reject', 'RejectDrop', 'Compatible', 'Pass', 'PassRule'])
const isNodeType = (type: string): boolean => !GROUP_TYPES.has(type) && !BUILTIN_TYPES.has(type)
const GROUP_COLORS = ['var(--accent)', 'var(--purple)', 'var(--orange)', 'var(--cyan)', 'var(--pink)']
/** delays 中表示超时的取值; -1 表示其余失败 */
const DELAY_TIMEOUT_VALUE = -2

interface GroupView extends ProxyGroup {
  nodes: ProxyNode[]
  virtual?: true
}

function groupKey(group: GroupView): string {
  return group.virtual ? 'virtual:all' : `group:${group.name}`
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

type SortMode = 'default' | 'delay' | 'name'
const SORT_KEY = 'proxies:sort'
const HIDE_TIMEOUT_KEY = 'proxies:hide-timeout'

function loadPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

function loadSort(): SortMode {
  const saved = loadPref(SORT_KEY)
  return saved === 'delay' || saved === 'name' ? saved : 'default'
}

/** 排序键: 已测成功按毫秒, 未测排其后, 超时垫底 */
function delayRank(d: number | undefined): number {
  if (d === undefined) return 1e9
  return d > 0 ? d : 2e9
}

export default function Proxies() {
  const t = useT()
  const [payload, setPayload] = useState<ProxiesPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed)
  const [sortMode, setSortMode] = useState<SortMode>(loadSort)
  const [hideTimeout, setHideTimeout] = useState(() => loadPref(HIDE_TIMEOUT_KEY) === '1')
  const delayTestUrl = useAppStore((s) => s.settings.delayTestUrl)
  const delayTestTimeout = useAppStore((s) => s.settings.delayTestTimeout)
  const autoCloseConnections = useAppStore((s) => s.settings.autoCloseConnections)
  /** 节点名 → 实测延迟(0 表示测试中, -1 表示失败, -2 表示超时) */
  const [delays, setDelays] = useState<Record<string, number>>({})
  const [testingGroups, setTestingGroups] = useState<Set<string>>(new Set())
  const [testingAll, setTestingAll] = useState(false)
  const [selecting, setSelecting] = useState<Set<string>>(new Set())
  const [actionError, setActionError] = useState<{ title: string; detail: string } | null>(null)
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
      setLoadError(String(error))
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
    // 所有真实节点（非策略组、非 DIRECT/REJECT 等内置项）
    const realNodes = Object.values(all).filter((p) => isNodeType(p.type)) as ProxyNode[]
    // 策略组
    const strategyGroups: GroupView[] = Object.values(all)
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
        virtual: true,
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
    return Object.values(payload.proxies).filter((p) => isNodeType(p.type)).length
  }, [payload])

  /** 测速中(0)沿用上一次结果, 避免排序和隐藏在测速过程中来回跳动 */
  const effectiveDelay = (node: ProxyNode): number | undefined => {
    const d = delays[node.name]
    return d === undefined || d === 0 ? latestDelay(node) : d
  }

  const visibleGroups = groups
    .filter((g) => typeFilter === 'all' || g.type === typeFilter)
    .map((g) => {
      let nodes = keyword
        ? g.nodes.filter((n) => n.name.toLowerCase().includes(keyword.toLowerCase()))
        : g.nodes
      if (hideTimeout) {
        nodes = nodes.filter((n) => {
          const d = effectiveDelay(n)
          return n.name === g.now || d === undefined || d > 0
        })
      }
      if (sortMode === 'delay') {
        nodes = [...nodes].sort((a, b) => delayRank(effectiveDelay(a)) - delayRank(effectiveDelay(b)))
      } else if (sortMode === 'name') {
        nodes = [...nodes].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      }
      return { ...g, nodes }
    })

  const handleSelect = async (group: string, name: string): Promise<void> => {
    if (selectingRef.current.has(group)) return
    selectingRef.current.add(group)
    loadGeneration.current += 1
    setSelecting(new Set(selectingRef.current))
    setActionError(null)
    const previous = payload?.proxies[group]?.now
    /* 乐观更新 */
    setPayload((prev) => {
      if (!prev) return prev
      const g = prev.proxies[group]
      if (!g) return prev
      return { proxies: { ...prev.proxies, [group]: { ...g, now: name } } }
    })
    try {
      await selectProxy(group, name)
      if (autoCloseConnections && previous !== name) void closeGroupConnections(group)
    } catch (error) {
      if (alive.current) setActionError({ title: '切换节点失败：', detail: String(error) })
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
    const test = testDelay(name, delayTestTimeout, delayTestUrl).then((ms) => {
      if (alive.current && current === generation.current) setDelays((d) => ({ ...d, [name]: ms }))
    }, (error: unknown) => {
      const value = isDelayTimeout(error) ? DELAY_TIMEOUT_VALUE : -1
      if (alive.current && current === generation.current) setDelays((d) => ({ ...d, [name]: value }))
    }).finally(() => { testingRef.current.delete(key) })
    testingRef.current.set(key, test)
    return test
  }

  /** 真实策略组交给内核 /group/{name}/delay 整组测速(URLTest/Fallback 会据此重选); 虚拟组逐节点测 */
  const runGroupDelay = async (g: GroupView): Promise<void> => {
    const current = generation.current
    const members = [...new Set(g.all)]
    setDelays((d) => ({ ...d, ...Object.fromEntries(members.map((name) => [name, 0])) }))
    try {
      const result = await testGroupDelay(g.name, delayTestTimeout, delayTestUrl)
      if (!alive.current || current !== generation.current) return
      setDelays((d) => ({ ...d, ...Object.fromEntries(members.map((name) => [name, result[name] ?? -1])) }))
    } catch (error) {
      if (!alive.current || current !== generation.current) return
      setDelays((d) => {
        const next = { ...d }
        for (const name of members) if (next[name] === 0) delete next[name]
        return next
      })
      setActionError({ title: '组测速失败：', detail: String(error) })
    }
    await refreshFlight.current
    await refresh()
  }

  const testGroup = async (g: GroupView): Promise<void> => {
    const key = groupKey(g)
    if (groupTestsRef.current.has(key)) return
    groupTestsRef.current.add(key)
    setTestingGroups((prev) => new Set(prev).add(key))
    try {
      if (g.virtual) await Promise.all([...new Set(g.nodes.map((n) => n.name))].map(testNode))
      else await runGroupDelay(g)
    } finally {
      groupTestsRef.current.delete(key)
      setTestingGroups((prev) => {
        const next = new Set(prev)
        next.delete(key)
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

  const locate = (group: string): void => {
    const target = document.querySelector<HTMLElement>(`.node-grid[data-group="${CSS.escape(group)}"] .node.sel`)
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    target?.focus({ preventScroll: true })
  }

  const renderDelay = (node: ProxyNode) => {
    const d = delays[node.name] ?? latestDelay(node)
    if (delays[node.name] === 0) return <span className="testing">{t('测速中…')}</span>
    if (d === undefined) return <Badge tone="gray">— ms</Badge>
    if (d === DELAY_TIMEOUT_VALUE) return <Badge tone="red">Timeout</Badge>
    if (d <= 0) return <Badge tone="red">Failed</Badge>
    return <Badge tone={delayTone(d)}>{d} ms</Badge>
  }

  return (
    <div className="pg-proxies">
      <div className="toolbar">
        <div className="search-wrap">
          <Icon name="search" />
          <Input
            placeholder={t('搜索节点 / 代理组')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <Seg
          items={[
            { value: 'all', label: t('全部') },
            { value: 'Selector', label: 'Selector' },
            { value: 'URLTest', label: 'URLTest' },
            { value: 'Fallback', label: 'Fallback' },
            { value: 'LoadBalance', label: 'LoadBalance' },
          ]}
          value={typeFilter}
          onChange={setTypeFilter}
        />
        <Seg<SortMode>
          label={t('节点排序')}
          items={[
            { value: 'default', label: t('默认') },
            { value: 'delay', label: t('延迟') },
            { value: 'name', label: t('名称') },
          ]}
          value={sortMode}
          onChange={(mode) => { setSortMode(mode); savePref(SORT_KEY, mode) }}
        />
        <Button
          aria-pressed={hideTimeout}
          title={t('隐藏超时节点(当前选中的节点始终显示)')}
          onClick={() => { savePref(HIDE_TIMEOUT_KEY, hideTimeout ? '0' : '1'); setHideTimeout(!hideTimeout) }}
        >
          <Icon name={hideTimeout ? 'eye-off' : 'eye'} size={13} />
          {hideTimeout ? t('已隐藏超时') : t('隐藏超时')}
        </Button>
        <div className="spacer" />
        <span className="chip">{loadError ? t('内核未运行') : t('共{count}个节点', { count: totalNodes })}</span>
        <Button variant="primary" onClick={() => void testAll()} disabled={testingAll || !!loadError || totalNodes === 0}>
          <Icon name="zap" size={13} />
          {testingAll ? t('测速中…') : t('全部测速')}
        </Button>
      </div>

      {actionError && <div role="alert">{t(actionError.title)}{actionError.detail}</div>}
      {loadError ? (
        <Card icon={<Icon name="proxies" />} iconColor="var(--accent)" title={t('节点列表')} flush>
          <div className="empty">{t('节点加载失败：')}{loadError}</div>
        </Card>
      ) : visibleGroups.map((g, i) => {
        const key = groupKey(g)
        const isOpen = !(collapsed[key] ?? collapsed[g.name])
        const isTestingGroup = testingGroups.has(key)
        const isVirtualGroup = Boolean(g.virtual)
        return (
          <Card
            key={key}
            icon={<Icon name="proxies" />}
            iconColor={GROUP_COLORS[i % GROUP_COLORS.length]}
            title={isVirtualGroup ? t('全部节点') : g.name}
            actions={
              <>
                {!isVirtualGroup && <span className="chip">{g.type}</span>}
                {!isVirtualGroup && <span className="grp-now">{t('当前:')} <b>{g.now}</b></span>}
                <Badge tone="green">{t('{count} 个节点', { count: g.all.length })}</Badge>
                {!isVirtualGroup && isOpen && (
                  <Button size="sm" title={t('滚动到当前选中的节点')} onClick={() => locate(g.name)}>{t('定位')}</Button>
                )}
                <Button size="sm" onClick={() => void testGroup(g)} disabled={isTestingGroup || testingAll}>
                  {isTestingGroup ? t('测速中…') : t('测速')}
                </Button>
                <button
                  className="icon-btn"
                  title={isOpen ? t('折叠') : t('展开')}
                  onClick={() => setCollapsed((c) => {
                    const next = { ...c, [key]: isOpen }
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
              <div className="node-grid" data-group={g.name}>
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
                      title={isVirtualGroup ? t('双击测速') : t('单击切换 · 双击测速')}
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
