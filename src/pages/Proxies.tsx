import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './Proxies.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Seg from '../components/ui/Seg'
import { useT } from '../i18n'
import { closeGroupConnections, DEFAULT_DELAY_TEST_URL, getProxies, isDelayTimeout, selectProxy, testDelay, testGroupDelay } from '../services/api'
import { call } from '../services/ipc'
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
const DELAY_CACHE_TTL = 30 * 60 * 1000
interface DelayResult { delay: number; updatedAt: number }
const delayCache = new Map<string, DelayResult>()

interface GroupView extends ProxyGroup {
  nodes: ProxyNode[]
}

interface DelayTarget { node: ProxyNode; url: string }

function groupKey(group: GroupView): string {
  return `group:${group.name}`
}

function latestDelay(node: ProxyNode, url: string, cached?: DelayResult): number | undefined {
  const history = node.extra?.[url]?.history ?? node.history
  const last = history[history.length - 1]
  if (cached && Date.now() - cached.updatedAt < DELAY_CACHE_TTL
    && (!last || !(Date.parse(last.time) > cached.updatedAt))) return cached.delay
  return node.extra?.[url] ? last?.delay : node.delay ?? last?.delay
}

const COLLAPSED_KEY = 'proxies:collapsed'

function loadCollapsed(profileId: string): Record<string, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(`${COLLAPSED_KEY}:${profileId}`) ?? '{}') as unknown
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
    return Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'boolean'))
  } catch {
    return {}
  }
}

function saveCollapsed(profileId: string, state: Record<string, boolean>): void {
  try {
    localStorage.setItem(`${COLLAPSED_KEY}:${profileId}`, JSON.stringify(state))
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const profileId = useRef<string | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>(loadSort)
  const [hideTimeout, setHideTimeout] = useState(() => loadPref(HIDE_TIMEOUT_KEY) === '1')
  const delayTestUrl = useAppStore((s) => s.settings.delayTestUrl)
  const delayTestTimeout = useAppStore((s) => s.settings.delayTestTimeout)
  const externalController = useAppStore((s) => s.settings.externalController)
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
  const payloadGeneration = useRef(-1)
  const loadGeneration = useRef(0)
  const alive = useRef(true)
  const refreshFlight = useRef<Promise<void> | null>(null)

  const refresh = useCallback(async () => {
    if (refreshFlight.current) return refreshFlight.current
    if (selectingRef.current.size) return
    const current = loadGeneration.current
    const task = Promise.all([getProxies(), call('list_profiles').catch(() => null)]).then(([value, profiles]) => {
      if (!alive.current || current !== loadGeneration.current) return
      const nextProfileId = profiles ? profiles.find((profile) => profile.current)?.id ?? '' : profileId.current ?? ''
      if (profileId.current !== nextProfileId) {
        profileId.current = nextProfileId
        generation.current += 1
        setDelays({})
        setCollapsed(loadCollapsed(nextProfileId))
      }
      payloadGeneration.current = generation.current
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
      delayCache.clear()
      setDelays({})
      void (refreshFlight.current ?? Promise.resolve()).then(refreshWhenVisible)
    }
    window.addEventListener('clashnova-api-config-changed', reconfigure)
    window.addEventListener('clashnova-profiles-changed', reconfigure)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      alive.current = false
      window.clearInterval(timer)
      window.removeEventListener('clashnova-api-config-changed', reconfigure)
      window.removeEventListener('clashnova-profiles-changed', reconfigure)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [refresh])

  const groups: GroupView[] = useMemo(() => {
    if (!payload) return []
    const all = payload.proxies
    // GLOBAL 的成员顺序由内核保留为配置顺序，API 对象本身的键顺序不保证一致。
    const order = new Map((all.GLOBAL?.all ?? []).map((name, index) => [name, index]))
    return Object.values(all)
      .filter((p): p is ProxyNode & ProxyGroup => GROUP_TYPES.has(p.type) && Array.isArray(p.all))
      .filter((g) => g.name !== 'GLOBAL')
      .sort((a, b) => (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.name) ?? Number.MAX_SAFE_INTEGER))
      .map((g) => ({
        name: g.name,
        type: g.type,
        now: g.now,
        all: g.all,
        testUrl: g.testUrl,
        nodes: g.all.map((n) => all[n]).filter((n): n is ProxyNode => n !== undefined),
      }))
  }, [payload])

  const totalNodes = useMemo(() => {
    if (!payload) return 0
    return Object.values(payload.proxies).filter((p) => isNodeType(p.type)).length
  }, [payload])

  /** 测速中(0)沿用上一次结果, 避免排序和隐藏在测速过程中来回跳动 */
  const delayKey = useCallback((node: ProxyNode, url: string): string =>
    JSON.stringify([externalController, profileId.current, node.provider ?? null, node.name, url]), [externalController])

  const effectiveDelay = (node: ProxyNode, url: string): number | undefined =>
    latestDelay(node, url, delayCache.get(delayKey(node, url)))

  const visibleGroups = groups
    .filter((g) => typeFilter === 'all' || g.type === typeFilter)
    .map((g) => {
      const url = g.testUrl || delayTestUrl || DEFAULT_DELAY_TEST_URL
      let nodes = keyword
        ? g.nodes.filter((n) => n.name.toLowerCase().includes(keyword.toLowerCase()))
        : g.nodes
      if (hideTimeout) {
        nodes = nodes.filter((n) => {
          const d = effectiveDelay(n, url)
          return n.name === g.now || d === undefined || d > 0
        })
      }
      if (sortMode === 'delay') {
        nodes = [...nodes].sort((a, b) => delayRank(effectiveDelay(a, url)) - delayRank(effectiveDelay(b, url)))
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

  const recordDelays = useCallback((current: number, entries: [string, number][]): void => {
    if (!alive.current || current !== generation.current) return
    const updatedAt = Date.now()
    for (const [key, delay] of entries) delayCache.set(key, { delay, updatedAt })
    setDelays((d) => ({ ...d, ...Object.fromEntries(entries) }))
  }, [])

  const testNode = useCallback((
    node: ProxyNode,
    url = delayTestUrl || DEFAULT_DELAY_TEST_URL,
    timeout = delayTestTimeout,
  ): Promise<void> => {
    const { name, provider } = node
    const current = generation.current
    const resultKey = delayKey(node, url)
    const key = JSON.stringify([current, resultKey, timeout])
    const existing = testingRef.current.get(key)
    if (existing) return existing
    setDelays((d) => ({ ...d, [resultKey]: 0 }))
    const test = testDelay(name, timeout, url, provider, JSON.stringify([profileId.current, current])).then((ms) => {
      recordDelays(current, [[resultKey, ms]])
    }, (error: unknown) => {
      const value = isDelayTimeout(error) ? DELAY_TIMEOUT_VALUE : -1
      recordDelays(current, [[resultKey, value]])
    }).finally(() => { testingRef.current.delete(key) })
    testingRef.current.set(key, test)
    return test
  }, [delayKey, delayTestUrl, delayTestTimeout, recordDelays])

  /**
   * 批量测速优先交给 Selector 组走 /group/{name}/delay，由内核并发测整组：
   * 逐节点请求受 WebView 同主机 6 连接限制，72 个节点实测约 55s，整组约 5s，且不会占满连接拖慢切换节点。
   * URLTest/Fallback 整组测速会清除手动固定的节点，不参与；只覆盖一个目标的组不如逐节点精确，同样退回。
   */
  const testTargets = useCallback((targets: DelayTarget[], timeout = delayTestTimeout): Promise<void> => {
    const current = generation.current
    const testKey = (resultKey: string): string => JSON.stringify([current, resultKey, timeout])
    const tests: Promise<void>[] = []
    const left = new Map<string, DelayTarget>()
    for (const target of targets) {
      const resultKey = delayKey(target.node, target.url)
      const existing = testingRef.current.get(testKey(resultKey))
      if (existing) tests.push(existing)
      else left.set(resultKey, target)
    }
    const selectors = groups.filter((group) => group.type === 'Selector')
    for (;;) {
      let best: { group: GroupView; url: string; covered: [string, ProxyNode][] } | undefined
      for (const url of new Set([...left.values()].map((target) => target.url))) {
        for (const group of selectors) {
          const covered = group.nodes.flatMap((node): [string, ProxyNode][] => {
            const resultKey = delayKey(node, url)
            return left.has(resultKey) ? [[resultKey, node]] : []
          })
          const most = best?.covered.length ?? 1
          // 覆盖相同时选成员少的组，少测无关节点
          if (covered.length > most || (best && covered.length === most && group.nodes.length < best.group.nodes.length)) {
            best = { group, url, covered }
          }
        }
      }
      if (!best) break
      const { group, url, covered } = best
      for (const [resultKey] of covered) left.delete(resultKey)
      setDelays((d) => ({ ...d, ...Object.fromEntries(covered.map(([resultKey]) => [resultKey, 0])) }))
      // 内核只返回成功的成员，失败与超时无法区分，与历史记录一样按 Failed 显示
      const test = testGroupDelay(group.name, timeout, url).then(
        (result) => covered.map(([resultKey, node]): [string, number] => [resultKey, result[node.name] ?? -1]),
        () => covered.map(([resultKey]): [string, number] => [resultKey, -1]),
      ).then((entries) => { recordDelays(current, entries) }).finally(() => {
        for (const [resultKey] of covered) testingRef.current.delete(testKey(resultKey))
      })
      for (const [resultKey] of covered) testingRef.current.set(testKey(resultKey), test)
      tests.push(test)
    }
    for (const { node, url } of left.values()) tests.push(testNode(node, url, timeout))
    return Promise.all(tests).then(() => undefined)
  }, [delayKey, delayTestTimeout, groups, recordDelays, testNode])

  useEffect(() => {
    if (!payload || loadError || payloadGeneration.current !== generation.current) return
    const missing: DelayTarget[] = []
    for (const group of groups) {
      const url = group.testUrl || delayTestUrl || DEFAULT_DELAY_TEST_URL
      for (const node of group.nodes) {
        if (!isNodeType(node.type)) continue
        const key = delayKey(node, url)
        if (delays[key] !== 0 && latestDelay(node, url, delayCache.get(key)) === undefined) {
          missing.push({ node, url })
        }
      }
    }
    if (missing.length) void testTargets(missing)
  }, [payload, loadError, groups, delays, delayKey, delayTestUrl, testTargets])

  const testGroup = async (g: GroupView): Promise<void> => {
    const key = groupKey(g)
    if (groupTestsRef.current.has(key)) return
    groupTestsRef.current.add(key)
    setTestingGroups((prev) => new Set(prev).add(key))
    try {
      const url = g.testUrl || delayTestUrl || DEFAULT_DELAY_TEST_URL
      await testTargets(g.nodes.map((node) => ({ node, url })))
      await refreshFlight.current
      await refresh()
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
      // 跨组重复出现的节点只测一次；能整组测的交给内核，其余走 10 并发的逐节点队列。
      const settings = useAppStore.getState().settings
      const url = settings.delayTestUrl || DEFAULT_DELAY_TEST_URL
      const timeout = settings.delayTestTimeout
      const targets = groups.flatMap((group) => group.nodes
        .filter((node) => isNodeType(node.type))
        .map((node) => ({ node, url: group.testUrl || url })))
      const groupedNames = new Set(targets.map(({ node }) => node.name))
      for (const node of Object.values(payload?.proxies ?? {})) {
        if (isNodeType(node.type) && !groupedNames.has(node.name)) targets.push({ node, url })
      }
      await testTargets(targets, timeout)
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

  const renderDelay = (node: ProxyNode, url: string) => {
    const d = effectiveDelay(node, url)
    if (delays[delayKey(node, url)] === 0) return <span className="testing">{t('测速中…')}</span>
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
        <span className="chip">{loadError && !payload ? t('内核未运行') : t('共{count}个节点', { count: totalNodes })}</span>
        <Button variant="primary" onClick={() => void testAll()} disabled={testingAll || !!loadError || totalNodes === 0}>
          <Icon name="zap" size={13} />
          {testingAll ? t('测速中…') : t('全部测速')}
        </Button>
      </div>

      {actionError && <div role="alert">{t(actionError.title)}{actionError.detail}</div>}
      {loadError && payload && <div className="refresh-error" role="alert">{t('节点刷新失败，显示上次结果：')}{loadError}</div>}
      {loadError && !payload ? (
        <Card icon={<Icon name="proxies" />} iconColor="var(--accent)" title={t('节点列表')} flush>
          <div className="empty">{t('节点加载失败：')}{loadError}</div>
        </Card>
      ) : visibleGroups.map((g, i) => {
        const key = groupKey(g)
        const isOpen = collapsed[key] === false
        const isTestingGroup = testingGroups.has(key)
        return (
          <Card
            key={key}
            icon={<Icon name="proxies" />}
            iconColor={GROUP_COLORS[i % GROUP_COLORS.length]}
            title={g.name}
            actions={
              <>
                <span className="chip">{g.type}</span>
                <span className="grp-now">{t('当前:')} <b>{g.now}</b></span>
                <Badge tone="green">{t('{count} 个节点', { count: g.all.length })}</Badge>
                {isOpen && (
                  <Button size="sm" title={t('滚动到当前选中的节点')} onClick={() => locate(g.name)}>{t('定位')}</Button>
                )}
                <Button size="sm" onClick={() => void testGroup(g)} disabled={isTestingGroup || testingAll}>
                  {isTestingGroup ? t('测速中…') : t('测速')}
                </Button>
                <button
                  className="icon-btn"
                  title={isOpen ? t('折叠') : t('展开')}
                  aria-expanded={isOpen}
                  onClick={() => setCollapsed((c) => {
                    const next = { ...c, [key]: isOpen }
                    saveCollapsed(profileId.current ?? '', next)
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
                      aria-pressed={sel}
                      onClick={() => void handleSelect(g.name, n.name)}
                      onDoubleClick={() => void testNode(n, g.testUrl || delayTestUrl || DEFAULT_DELAY_TEST_URL)}
                      title={t('单击切换 · 双击测速')}
                    >
                      <div className="nm">{n.name}</div>
                      {sel && (
                        <span className="sel-mark">
                          <Icon name="check" size={13} />
                        </span>
                      )}
                      <div className="meta">
                        <span className="chip">{n.type}</span>
                        {renderDelay(n, g.testUrl || delayTestUrl || DEFAULT_DELAY_TEST_URL)}
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
