import { useEffect, useMemo } from 'react'
import './Topology.css'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import { useT } from '../i18n'
import { startLiveStreams, useLiveStore } from '../stores/live'
import type { ConnItem } from '../types/clash'
import { fmtBytes } from '../utils/format'

/* ---------------- 桑基布局 ---------------- */

const W = 1100
const H = 560
const NODE_W = 10
const PAD_TOP = 14
const PAD_BOTTOM = 14
const GAP = 10
const MIN_H = 16
const MAX_PER_COL = 8

/** 列定义: 源IP → 进程 → 规则 → 节点 → 出站组 */
const COLUMNS = [
  { key: 'source', label: '源 IP', x: 80, color: '#0A84FF' },
  { key: 'process', label: '进程', x: 312, color: '#64D2FF' },
  { key: 'rule', label: '规则', x: 545, color: '#32D74B' },
  { key: 'node', label: '节点', x: 778, color: '#FFD60A' },
  { key: 'group', label: '出站', x: 1010, color: '#FF9F0A' },
] as const

interface SankeyNode {
  key: string
  name: string
  localized: boolean
  weight: number
  y: number
  h: number
  /* 联带在两侧的累计偏移 */
  outOffset: number
  inOffset: number
}

interface SankeyLink {
  from: number
  to: number
  weight: number
}

interface Layout {
  columns: SankeyNode[][]
  links: SankeyLink[][] // links[c] = 列 c → c+1
}

/** 用独立键区分界面占位文案与用户数据，避免同名进程被合并或翻译。 */
function keysOf(c: ConnItem): string[] {
  const node = c.chains[0] ?? 'DIRECT'
  const group = c.chains[c.chains.length - 1] ?? node
  return [
    c.metadata.sourceIP ? `value:${c.metadata.sourceIP}` : 'label:本机',
    c.metadata.process ? `value:${c.metadata.process}` : 'label:未知进程',
    `value:${c.rulePayload ? `${c.rule}(${c.rulePayload})` : c.rule || 'MATCH'}`,
    `value:${node}`,
    `value:${group}`,
  ]
}

function buildLayout(conns: ConnItem[]): Layout | null {
  if (conns.length === 0) return null

  // 1) 每列聚合权重, 截断 TopN 其余归"其他"
  const colWeights: Map<string, number>[] = COLUMNS.map(() => new Map())
  const weightOf = (c: ConnItem): number => Math.max(1, c.upload + c.download)
  for (const c of conns) {
    const keys = keysOf(c)
    keys.forEach((k, i) => {
      const m = colWeights[i]!
      m.set(k, (m.get(k) ?? 0) + weightOf(c))
    })
  }
  const keep: Set<string>[] = colWeights.map((m) => {
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1])
    return new Set(sorted.slice(0, MAX_PER_COL).map(([k]) => k))
  })
  const mapKey = (i: number, k: string): string => (keep[i]!.has(k) ? k : 'label:其他')

  // 2) 重新聚合(含"其他")+ 相邻列联带
  const colAgg: Map<string, number>[] = COLUMNS.map(() => new Map())
  const linkAgg: Map<string, number>[] = COLUMNS.slice(0, -1).map(() => new Map())
  for (const c of conns) {
    const keys = keysOf(c).map((k, i) => mapKey(i, k))
    const w = weightOf(c)
    keys.forEach((k, i) => {
      const m = colAgg[i]!
      m.set(k, (m.get(k) ?? 0) + w)
    })
    for (let i = 0; i < keys.length - 1; i += 1) {
      const lk = `${keys[i]}\0${keys[i + 1]}`
      const m = linkAgg[i]!
      m.set(lk, (m.get(lk) ?? 0) + w)
    }
  }

  // 3) 列内布局: 按权重降序, 高度∝√权重(压缩极端大流量, 整列归一)
  const columns: SankeyNode[][] = colAgg.map((m) => {
    const entries = [...m.entries()].sort((a, b) => b[1] - a[1])
    const totalW = entries.reduce((acc, [, w]) => acc + Math.sqrt(w), 0)
    const avail = H - PAD_TOP - PAD_BOTTOM - GAP * (entries.length - 1)
    const flexible = Math.max(0, avail - MIN_H * entries.length)
    let y = PAD_TOP
    return entries.map(([key, weight]) => {
      const share = totalW > 0 ? Math.sqrt(weight) / totalW : 0
      // 单节点/极端权重封顶 45%, 避免整列被一个节点糊满
      const h = MIN_H + Math.min(share, 0.45) * flexible
      const node: SankeyNode = { key, name: key.slice(6), localized: key.startsWith('label:'), weight, y, h, outOffset: 0, inOffset: 0 }
      y += h + GAP
      return node
    })
  })

  // 4) 联带按 from 列顺序分配两侧偏移
  const links: SankeyLink[][] = linkAgg.map((m, ci) => {
    const fromNodes = columns[ci]!
    const toNodes = columns[ci + 1]!
    const idx = (nodes: SankeyNode[], key: string): number =>
      nodes.findIndex((n) => n.key === key)
    const list = [...m.entries()]
      .map(([lk, weight]) => {
        const [a, b] = lk.split('\0')
        return { from: idx(fromNodes, a!), to: idx(toNodes, b!), weight }
      })
      .filter((l) => l.from >= 0 && l.to >= 0)
      .sort((x, y2) => x.from - y2.from || x.to - y2.to)
    return list
  })

  return { columns, links }
}

/** 联带 path(与设计稿同构的双三次贝塞尔闭合带) */
function ribbonPath(
  x1: number,
  y1: number,
  h1: number,
  x2: number,
  y2: number,
  h2: number,
): string {
  const mid = (x1 + x2) / 2
  return [
    `M${x1},${y1}`,
    `C${mid},${y1} ${mid},${y2} ${x2},${y2}`,
    `L${x2},${y2 + h2}`,
    `C${mid},${y2 + h2} ${mid},${y1 + h1} ${x1},${y1 + h1}`,
    'Z',
  ].join(' ')
}

export default function Topology() {
  const t = useT()
  const connections = useLiveStore((s) => s.connections)

  useEffect(() => startLiveStreams(['connections']), [])

  const layout = useMemo(
    () => buildLayout(connections.connections),
    [connections.connections],
  )

  /* 渲染前为每条联带计算两侧 y(消耗节点偏移) */
  const ribbons = useMemo(() => {
    if (!layout) return []
    layout.columns.forEach((col) =>
      col.forEach((n) => {
        n.outOffset = 0
        n.inOffset = 0
      }),
    )
    const out: { d: string; grad: number; opacity: number }[] = []
    layout.links.forEach((list, ci) => {
      const fromNodes = layout.columns[ci]!
      const toNodes = layout.columns[ci + 1]!
      const fromTotal = (n: SankeyNode): number => Math.max(1, n.weight)
      for (const l of list) {
        const a = fromNodes[l.from]!
        const b = toNodes[l.to]!
        const h1 = (l.weight / fromTotal(a)) * a.h
        const h2 = (l.weight / fromTotal(b)) * b.h
        const y1 = a.y + a.outOffset
        const y2 = b.y + b.inOffset
        a.outOffset += h1
        b.inOffset += h2
        out.push({
          d: ribbonPath(
            COLUMNS[ci]!.x + NODE_W,
            y1,
            h1,
            COLUMNS[ci + 1]!.x,
            y2,
            h2,
          ),
          grad: ci,
          opacity: 0.22 + Math.min(0.16, (l.weight / 1e7) * 0.16),
        })
      }
    })
    return out
  }, [layout])

  return (
    <div className="pg-topology">
      <Card
        className="topo-card"
        icon={<Icon name="topology" />}
        iconColor="var(--green)"
        title={t('连接拓扑')}
        actions={
          <span className="chip">
            {t('{count} 条链路 · 实时', { count: connections.connections.length })}
          </span>
        }
        flush
      >
        {!layout ? (
          <div className="empty">{t('暂无活动连接')}</div>
        ) : (
          <div className="topo-wrap">
            <svg
              className="topo-svg"
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="xMidYMid meet"
              aria-label={t('连接拓扑桑基图')}
            >
              <defs>
                {COLUMNS.slice(0, -1).map((c, i) => (
                  <linearGradient id={`tp-g${i}`} key={c.key} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor={c.color} />
                    <stop offset="1" stopColor={COLUMNS[i + 1]!.color} />
                  </linearGradient>
                ))}
              </defs>

              {ribbons.map((r, i) => (
                <path key={i} d={r.d} fill={`url(#tp-g${r.grad})`} fillOpacity={r.opacity} />
              ))}

              {layout.columns.map((col, ci) => {
                const conf = COLUMNS[ci]!
                const lastCol = ci === COLUMNS.length - 1
                return col.map((n) => {
                  const name = n.localized ? t(n.name) : n.name
                  return (
                    <g key={`${conf.key}:${n.key}`}>
                      <rect
                        x={conf.x}
                        y={n.y}
                        width={NODE_W}
                        height={n.h}
                        rx={3}
                        fill={conf.color}
                        fillOpacity={0.9}
                      />
                      <text
                        x={lastCol ? conf.x - 6 : conf.x + NODE_W + 7}
                        y={n.y + Math.min(n.h / 2 + 4, 16)}
                        textAnchor={lastCol ? 'end' : 'start'}
                      >
                        {name.length > 22 ? `${name.slice(0, 21)}…` : name}
                      </text>
                      <text
                        className="sub"
                        x={lastCol ? conf.x - 6 : conf.x + NODE_W + 7}
                        y={n.y + Math.min(n.h / 2 + 4, 16) + 13}
                        textAnchor={lastCol ? 'end' : 'start'}
                      >
                        {fmtBytes(n.weight)}
                      </text>
                    </g>
                  )
                })
              })}
            </svg>
          </div>
        )}
        <div className="topo-legend">
          {COLUMNS.map((c) => (
            <span className="lg" key={c.key}>
              <i style={{ background: c.color }} />
              {t(c.label)}
            </span>
          ))}
          <span className="lg-hint">{t('联带宽度 ∝ 累计流量 · 每秒刷新')}</span>
        </div>
      </Card>
    </div>
  )
}
