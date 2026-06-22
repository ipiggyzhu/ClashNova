import { useEffect, useMemo, useRef, useState } from 'react'
import './Dashboard.css'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Seg from '../components/ui/Seg'
import Spark from '../components/ui/Spark'
import { call, isMock } from '../services/ipc'
import { useAppStore } from '../stores/app'
import { startLiveStreams, useLiveStore } from '../stores/live'
import type { RankRow, SeriesPoint, StatDim, StatRange } from '../types/clash'
import { fmtBytes, fmtSpeed, fmtUptime } from '../utils/format'

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const RANK_COLORS: Record<StatDim, string> = {
  proxy: '#BF5AF2',
  process: '#64D2FF',
  host: '#40C8E0',
}

/** 经当前网络栈对端点计时(ms); 失败 -1 */
async function probeMs(url: string): Promise<number> {
  if (isMock) {
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 250))
    return Math.round(20 + Math.random() * 220)
  }
  const begin = performance.now()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
    clearTimeout(timer)
    return Math.round(performance.now() - begin)
  } catch {
    return -1
  }
}

function msTone(ms: number): string {
  if (ms < 0) return 'var(--red)'
  if (ms < 100) return 'var(--green)'
  if (ms < 250) return 'var(--orange)'
  return 'var(--red)'
}

function msText(ms: number | null): string {
  return ms === null ? '…' : ms < 0 ? '超时' : String(ms)
}

function useSmoothTraffic(target: { up: number; down: number }) {
  const [value, setValue] = useState(target)
  const valueRef = useRef(target)

  useEffect(() => {
    const from = valueRef.current
    const started = performance.now()
    const duration = 680
    let raf = 0

    const tick = (now: number): void => {
      const t = Math.min(1, (now - started) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      const next = {
        up: from.up + (target.up - from.up) * eased,
        down: from.down + (target.down - from.down) * eased,
      }
      valueRef.current = next
      setValue(next)
      if (t < 1) raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target.up, target.down])

  return value
}

export default function Dashboard() {
  const core = useAppStore((s) => s.coreStatus)
  const settings = useAppStore((s) => s.settings)
  const refreshCoreStatus = useAppStore((s) => s.refreshCoreStatus)
  const traffic = useLiveStore((s) => s.traffic)
  const connections = useLiveStore((s) => s.connections)
  const memInuse = useLiveStore((s) => s.memory.inuse)

  const [sumRange, setSumRange] = useState<StatRange>('day')
  const [rankBy, setRankBy] = useState<StatDim>('proxy')
  const [trend, setTrend] = useState<SeriesPoint[]>([])
  const [sumSeries, setSumSeries] = useState<SeriesPoint[]>([])
  const [proxyRank, setProxyRank] = useState<RankRow[]>([])
  const [ranking, setRanking] = useState<RankRow[]>([])
  const [netMs, setNetMs] = useState<{ internet: number | null; dns: number | null }>({
    internet: null,
    dns: null,
  })

  /* 实时流(traffic/connections)接入 + 内核状态 5s 轮询 */
  useEffect(() => {
    const release = startLiveStreams()
    const timer = setInterval(() => void refreshCoreStatus().catch(() => {}), 5000)
    return () => {
      release()
      clearInterval(timer)
    }
  }, [refreshCoreStatus])

  /* 7 天趋势 */
  useEffect(() => {
    void call('query_traffic_series', { range: '7d' }).then(setTrend).catch(() => {})
  }, [])

  /* 流量汇总(环形图 + 排行) */
  useEffect(() => {
    void call('query_traffic_series', { range: sumRange }).then(setSumSeries).catch(() => {})
    void call('query_traffic_rank', { dim: 'proxy', range: sumRange })
      .then(setProxyRank)
      .catch(() => {})
  }, [sumRange])

  useEffect(() => {
    void call('query_traffic_rank', { dim: rankBy, range: sumRange })
      .then(setRanking)
      .catch(() => {})
  }, [rankBy, sumRange])

  /* 网络状态探测 */
  const probeNet = (): void => {
    setNetMs({ internet: null, dns: null })
    void probeMs('https://www.gstatic.com/generate_204').then((ms) =>
      setNetMs((s) => ({ ...s, internet: ms })),
    )
    void probeMs('https://doh.pub/dns-query').then((ms) =>
      setNetMs((s) => ({ ...s, dns: ms })),
    )
  }
  useEffect(probeNet, [])

  const last = traffic[traffic.length - 1] ?? { up: 0, down: 0 }
  const smoothLast = useSmoothTraffic(last)
  const upPts = useMemo(() => traffic.map((p) => p.up), [traffic])
  const downPts = useMemo(() => traffic.map((p) => p.down), [traffic])
  const smoothUpPts = useMemo(() => {
    const pts = upPts.length >= 2 ? [...upPts] : [0, 0]
    pts[pts.length - 1] = smoothLast.up
    return pts
  }, [upPts, smoothLast.up])
  const smoothDownPts = useMemo(() => {
    const pts = downPts.length >= 2 ? [...downPts] : [0, 0]
    pts[pts.length - 1] = smoothLast.down
    return pts
  }, [downPts, smoothLast.down])

  /* 趋势条形数据 */
  const trendMax = Math.max(1, ...trend.map((p) => p.up + p.down))
  const trendAvg = trend.length
    ? trend.reduce((acc, p) => acc + p.up + p.down, 0) / trend.length
    : 0

  /* 环形图: 直连 vs 代理 + 上下行 */
  const sumUp = sumSeries.reduce((acc, p) => acc + p.up, 0)
  const sumDown = sumSeries.reduce((acc, p) => acc + p.down, 0)
  const directBytes = proxyRank
    .filter((r) => r.key === 'DIRECT')
    .reduce((acc, r) => acc + r.up + r.down, 0)
  const proxyBytes = Math.max(
    0,
    proxyRank.filter((r) => r.key !== 'DIRECT').reduce((acc, r) => acc + r.up + r.down, 0),
  )
  const total = Math.max(1, directBytes + proxyBytes)
  const proxyRatio = proxyBytes / total
  const C = 2 * Math.PI * 64
  const rankMax = Math.max(1, ...ranking.map((r) => r.up + r.down))

  return (
    <div className="pg-dashboard">
      <div className="grid2">
        {/* ---- 运行状态 ---- */}
        <Card
          icon={<Icon name="cpu" />}
          iconColor="var(--accent)"
          title="运行状态"
          actions={<span className="dot-live" />}
        >
          <div className="stat-grid">
            <div className="stat-cell">
              <div className="stat-label"><Icon name="clock" size={12} />在线时长</div>
              <div className="stat-num">{core.running ? fmtUptime(core.uptimeSec) : '—'}</div>
            </div>
            <div className="stat-cell">
              <div className="stat-label"><Icon name="connections" size={12} />连接数</div>
              <div className="stat-num" style={{ color: 'var(--orange)' }}>
                {connections.connections.length}
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-label"><Icon name="cpu" size={12} />内核内存</div>
              <div className="stat-num" style={{ color: 'var(--accent)' }}>
                {fmtBytes(core.running ? memInuse || core.memoryBytes : 0, 0)}
              </div>
            </div>
          </div>
          <div className="stat-grid stat-sub">
            <div className="stat-cell">
              <div className="stat-label">系统</div>
              <b>Windows 11 24H2</b>
            </div>
            <div className="stat-cell">
              <div className="stat-label">版本</div>
              <b>v{__APP_VERSION__}</b>
            </div>
            <div className="stat-cell">
              <div className="stat-label">内核</div>
              <b>mihomo {core.running ? (core.version === '—' ? '获取中…' : core.version) : '未运行'}</b>
            </div>
          </div>
        </Card>

        {/* ---- 网络状态 ---- */}
        <Card
          icon={<Icon name="globe2" />}
          iconColor="var(--cyan)"
          title="网络状态"
          actions={
            <button className="icon-btn" title="刷新" onClick={probeNet}>
              <Icon name="refresh" />
            </button>
          }
        >
          <div className="stat-grid">
            <div className="stat-cell">
              <div className="stat-label"><Icon name="globe2" size={12} />互联网</div>
              <div className="stat-num" style={{ color: msTone(netMs.internet ?? 0) }}>
                {msText(netMs.internet)}{' '}
                {typeof netMs.internet === 'number' && netMs.internet >= 0 && (
                  <span style={{ fontSize: 12 }}>ms</span>
                )}
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-label"><Icon name="search" size={12} />DNS</div>
              <div className="stat-num" style={{ color: msTone(netMs.dns ?? 0) }}>
                {msText(netMs.dns)}{' '}
                {typeof netMs.dns === 'number' && netMs.dns >= 0 && (
                  <span style={{ fontSize: 12 }}>ms</span>
                )}
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-label"><Icon name="connections" size={12} />混合端口</div>
              <div className="stat-num" style={{ color: 'var(--cyan)' }}>
                {settings.mixedPort}
              </div>
            </div>
          </div>
          <div className="stat-grid stat-sub">
            <div className="stat-cell">
              <div className="stat-label">出站模式</div>
              <b>{{ rule: '规则', global: '全局', direct: '直连' }[settings.mode]}</b>
            </div>
            <div className="stat-cell">
              <div className="stat-label">系统代理</div>
              <b>{settings.sysProxy ? '已开启' : '关闭'}</b>
            </div>
            <div className="stat-cell">
              <div className="stat-label">TUN</div>
              <b>{settings.tun ? '已开启' : '关闭'}</b>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid2">
        {/* ---- 实时流量 ---- */}
        <Card icon={<Icon name="traffic" />} iconColor="var(--green)" title="实时流量">
          <div className="rt-half">
            <div>
              <div className="stat-label" style={{ color: 'var(--purple)' }}>
                <Icon name="upload" size={12} />上传速度
              </div>
              <div className="stat-num" style={{ color: 'var(--purple)' }}>
                {fmtSpeed(smoothLast.up)}
              </div>
              <div className="rt-chart">
                <Spark pts={smoothUpPts} color="#BF5AF2" h={108} fill dot />
              </div>
            </div>
            <div>
              <div className="stat-label" style={{ color: 'var(--cyan)' }}>
                <Icon name="download" size={12} />下载速度
              </div>
              <div className="stat-num" style={{ color: 'var(--cyan)' }}>
                {fmtSpeed(smoothLast.down)}
              </div>
              <div className="rt-chart">
                <Spark pts={smoothDownPts} color="#64D2FF" h={108} fill dot />
              </div>
            </div>
          </div>
          <div className="rt-foot">
            <span>↑ 总上传 <b>{fmtBytes(connections.uploadTotal)}</b></span>
            <span>↓ 总下载 <b>{fmtBytes(connections.downloadTotal)}</b></span>
          </div>
        </Card>

        {/* ---- 7 天流量趋势 ---- */}
        <Card
          icon={<Icon name="traffic" />}
          iconColor="var(--orange)"
          title="7 天流量趋势"
          actions={
            <button className="icon-btn" title="刷新">
              <Icon name="refresh" />
            </button>
          }
        >
          <div className="trend-v2">
            <div className="trend-summary">
              <div>
                <div className="stat-label">日均</div>
                <strong>{fmtBytes(trendAvg)}</strong>
              </div>
              <span>最近 7 天总量 {fmtBytes(trend.reduce((acc, p) => acc + p.up + p.down, 0))}</span>
            </div>
            <div className="trend-bars">
              {[...trend].reverse().map((p, i) => {
                const bytes = p.up + p.down
                const day = new Date(p.ts)
                const isPeak = bytes >= trendMax * 0.8
                return (
                  <div className="tcol" key={p.ts} title={fmtBytes(bytes)}>
                    <span className={isPeak ? 'bar-val hot' : 'bar-val'}>{fmtBytes(bytes, 0)}</span>
                    <div className="bar-slot">
                      <div
                        className={isPeak ? 'bar-col hot' : 'bar-col'}
                        style={{ height: `${Math.max(7, (bytes / trendMax) * 96)}px` }}
                      />
                    </div>
                    {i === 0 && <div className="tick" />}
                    <span className="day">{DAY_NAMES[day.getDay()]}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </Card>
      </div>

      {/* ---- 流量汇总 ---- */}
      <Card
        icon={<Icon name="clock" />}
        iconColor="var(--pink)"
        title="流量汇总"
        actions={
          <Seg<StatRange>
            items={[
              { value: 'day', label: '今日' },
              { value: '7d', label: '7 天' },
              { value: '30d', label: '30 天' },
            ]}
            value={sumRange}
            onChange={setSumRange}
          />
        }
      >
        <div className="sum-body">
          <div className="donut-wrap">
            <svg width="158" height="158" viewBox="0 0 158 158">
              <circle cx="79" cy="79" r="64" fill="none" stroke="var(--card-3)" strokeWidth="13" />
              <circle
                cx="79" cy="79" r="64" fill="none"
                stroke="var(--accent)" strokeWidth="13" strokeLinecap="round"
                strokeDasharray={`${C * proxyRatio} ${C}`}
                transform="rotate(-90 79 79)"
              />
              <circle
                cx="79" cy="79" r="64" fill="none"
                stroke="var(--green)" strokeWidth="13" strokeLinecap="round"
                strokeDasharray={`${C * (1 - proxyRatio)} ${C}`}
                transform={`rotate(${-90 + proxyRatio * 360} 79 79)`}
              />
            </svg>
            <div className="donut-center">
              <span>总计</span>
              <div className="stat-num">{fmtBytes(sumUp + sumDown)}</div>
            </div>
          </div>
          <div className="sum-legend">
            <div className="row">
              <span className="ic"><Icon name="upload" size={13} /></span>上传
              <b>{fmtBytes(sumUp)}</b>
            </div>
            <div className="row">
              <span className="ic"><Icon name="download" size={13} /></span>下载
              <b>{fmtBytes(sumDown)}</b>
            </div>
            <div className="row">
              <span className="dot" style={{ background: 'var(--green)' }} />直连
              <b>{fmtBytes(directBytes)}</b>
            </div>
            <div className="row">
              <span className="dot" style={{ background: 'var(--accent)' }} />代理
              <b>{fmtBytes(proxyBytes)}</b>
            </div>
            <div className="split-bar">
              <div style={{ width: `${(1 - proxyRatio) * 100}%`, background: 'var(--green)' }} />
              <div style={{ width: `${proxyRatio * 100}%`, background: 'var(--accent)' }} />
            </div>
          </div>
          <div className="rank">
            <div className="rank-head">
              <div className="stat-label"><Icon name="rules" size={12} />排行</div>
              <Seg<StatDim>
                items={[
                  { value: 'proxy', label: '代理' },
                  { value: 'process', label: '进程' },
                  { value: 'host', label: '主机名' },
                ]}
                value={rankBy}
                onChange={setRankBy}
              />
            </div>
            {ranking.map((r) => {
              const bytes = r.up + r.down
              const color = r.key === 'DIRECT' ? 'var(--green)' : RANK_COLORS[rankBy]
              return (
                <div className="rank-row" key={r.key}>
                  <span className="nm">
                    <i style={{ background: color }} />
                    {r.key}
                  </span>
                  <span className="track">
                    <span
                      className="fill"
                      style={{
                        width: `${(bytes / rankMax) * 100}%`,
                        background: `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 55%, transparent))`,
                      }}
                    />
                  </span>
                  <span className="val">{fmtBytes(bytes)}</span>
                </div>
              )
            })}
          </div>
        </div>
      </Card>
    </div>
  )
}
