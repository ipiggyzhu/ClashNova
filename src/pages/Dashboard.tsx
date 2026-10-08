import { useCallback, useEffect, useRef, useState } from 'react'
import './Dashboard.css'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Seg from '../components/ui/Seg'
import Spark from '../components/ui/Spark'
import { useSmoothTraffic } from '../hooks/useSmoothTraffic'
import { call } from '../services/ipc'
import { probeUrl } from '../services/probe'
import { usePollingQuery } from '../hooks/usePollingQuery'
import { useAppStore } from '../stores/app'
import { startLiveStreams, useLiveStore } from '../stores/live'
import type { RankRow, SeriesPoint, StatDim, StatRange, TrafficSummary, TunAdapterStatus } from '../types/clash'
import { fmtBytes, fmtSpeed, fmtUptime } from '../utils/format'

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const RANK_COLORS: Record<StatDim, string> = {
  proxy: '#BF5AF2',
  process: '#64D2FF',
  host: '#40C8E0',
}

const EMPTY_SERIES: SeriesPoint[] = []
const EMPTY_RANK: RankRow[] = []
const EMPTY_SUMMARY: TrafficSummary = { up: 0, down: 0, direct: 0, proxy: 0, unattributed: 0 }
const queryTrend = () => call('query_traffic_series', { range: '7d' })
const queryTun = () => call('check_tun_adapter')

function msTone(ms: number): string {
  if (ms < 0) return 'var(--red)'
  if (ms < 100) return 'var(--green)'
  if (ms < 250) return 'var(--orange)'
  return 'var(--red)'
}

function msText(ms: number | null): string {
  return ms === null ? '…' : ms < 0 ? '失败' : String(ms)
}

function tunText(settingsTun: boolean, adapter: TunAdapterStatus | null): string {
  if (!settingsTun) return '关闭'
  if (!adapter) return '检测中…'
  if (adapter.status === 'unsupported') return '已开启'
  if (adapter.status === 'runtime-enabled') return '已接管'
  if (adapter.adapterPresent) return adapter.adapterName ? `已开启 · ${adapter.adapterName}` : '已开启'
  return '网卡未就绪'
}

export default function Dashboard() {
  const settings = useAppStore((s) => s.settings)
  const runtimeMode = useAppStore((s) => s.runtimeMode)
  const [sumRange, setSumRange] = useState<StatRange>('day')
  const [rankBy, setRankBy] = useState<StatDim>('proxy')
  const { data: trend, error: trendError, refresh: refreshTrend } = usePollingQuery(queryTrend, EMPTY_SERIES)
  const querySummary = useCallback(() => call('query_traffic_summary', { range: sumRange }), [sumRange])
  const queryRank = useCallback(() => call('query_traffic_rank', { dim: rankBy, range: sumRange }), [rankBy, sumRange])
  const { data: summary, error: summaryError } = usePollingQuery(querySummary, EMPTY_SUMMARY)
  const { data: ranking, error: rankError } = usePollingQuery(queryRank, EMPTY_RANK)
  const { data: tunAdapter } = usePollingQuery<TunAdapterStatus | null>(queryTun, null, 5000)
  const [netMs, setNetMs] = useState<{ internet: number | null; dns: number | null }>({ internet: null, dns: null })
  const [netBusy, setNetBusy] = useState(false)
  const probeRun = useRef({ generation: 0, busy: false })

  useEffect(() => startLiveStreams(['traffic', 'connections', 'memory']), [])

  const probeNet = useCallback((): void => {
    if (probeRun.current.busy) return
    probeRun.current.busy = true
    const generation = ++probeRun.current.generation
    setNetBusy(true)
    setNetMs({ internet: null, dns: null })
    void Promise.all([
      probeUrl('https://www.gstatic.com/generate_204').catch(() => -1),
      probeUrl('https://doh.pub/dns-query?dns=AAABAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE').catch(() => -1),
    ]).then(([internet, dns]) => {
      if (generation === probeRun.current.generation) setNetMs({ internet, dns })
    }).finally(() => {
      if (generation === probeRun.current.generation) {
        probeRun.current.busy = false
        setNetBusy(false)
      }
    })
  }, [])
  useEffect(() => {
    probeNet()
    return () => { probeRun.current.generation += 1; probeRun.current.busy = false }
  }, [probeNet])

  /* 趋势条形数据 */
  const trendMax = Math.max(1, ...trend.map((p) => p.up + p.down))
  const trendAvg = trend.length
    ? trend.reduce((acc, p) => acc + p.up + p.down, 0) / trend.length
    : 0

  // 使用全量聚合，不以 Top 10 推断 DIRECT，短连接缺失部分保留为未归因。
  const { up: sumUp, down: sumDown, direct: directBytes, proxy: proxyBytes, unattributed } = summary
  const total = Math.max(1, sumUp + sumDown)
  const proxyRatio = proxyBytes / total
  const directRatio = directBytes / total
  const unknownRatio = unattributed / total
  const C = 2 * Math.PI * 64
  const rankMax = Math.max(1, ...ranking.map((r) => r.up + r.down))

  return (
    <div className="pg-dashboard">
      {(trendError || summaryError || rankError) && <div role="alert">统计加载失败：{trendError || summaryError || rankError}</div>}
      <div className="grid2">
        <RuntimeStatus />

        {/* ---- 网络状态 ---- */}
        <Card
          icon={<Icon name="globe2" />}
          iconColor="var(--cyan)"
          title="网络状态"
          actions={
            <button className="icon-btn" title="刷新网络状态" onClick={probeNet} disabled={netBusy}>
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
              <div className="stat-label"><Icon name="search" size={12} />DNS 端点</div>
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
              <b>{{ rule: '规则', global: '全局', direct: '直连' }[runtimeMode ?? settings.mode]}</b>
            </div>
            <div className="stat-cell">
              <div className="stat-label">系统代理</div>
              <b>{settings.sysProxy ? '已开启' : '关闭'}</b>
            </div>
            <div className="stat-cell">
              <div className="stat-label">TUN</div>
              <b title={tunAdapter?.detail ?? undefined}>{tunText(settings.tun, tunAdapter)}</b>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid2">
        <RealtimeTraffic />

        {/* ---- 7 天流量趋势 ---- */}
        <Card
          icon={<Icon name="traffic" />}
          iconColor="var(--orange)"
          title="7 天流量趋势"
          actions={
            <button className="icon-btn" title="刷新趋势" onClick={() => void refreshTrend()}>
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
                    <div className="tick-slot">{i === 0 && <div className="tick" />}</div>
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
                strokeDasharray={`${C * directRatio} ${C}`}
                transform={`rotate(${-90 + proxyRatio * 360} 79 79)`}
              />
              <circle
                cx="79" cy="79" r="64" fill="none"
                stroke="var(--text-3)" strokeWidth="13"
                strokeDasharray={`${C * unknownRatio} ${C}`}
                transform={`rotate(${-90 + (proxyRatio + directRatio) * 360} 79 79)`}
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
            <div className="row">
              <span className="dot" style={{ background: 'var(--text-3)' }} />未归因
              <b>{fmtBytes(unattributed)}</b>
            </div>
            <div className="split-bar">
              <div style={{ width: `${directRatio * 100}%`, background: 'var(--green)' }} />
              <div style={{ width: `${proxyRatio * 100}%`, background: 'var(--accent)' }} />
              <div style={{ width: `${unknownRatio * 100}%`, background: 'var(--text-3)' }} />
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

/** 实时采样仅更新此卡片，不重算整页历史图表。 */
function RealtimeTraffic() {
  const traffic = useLiveStore((s) => s.traffic)
  const upTotal = useLiveStore((s) => s.connections.uploadTotal)
  const downTotal = useLiveStore((s) => s.connections.downloadTotal)
  const last = traffic[traffic.length - 1] ?? { up: 0, down: 0 }
  const smoothTraffic = useSmoothTraffic(last, traffic)
  return (
    <Card className="rt-card" icon={<Icon name="traffic" />} iconColor="var(--green)" title="实时流量">
      <div className="rt-half">
        <div>
          <div className="stat-label" style={{ color: 'var(--purple)' }}>
            <Icon name="upload" size={12} />上传速度
          </div>
          <div className="stat-num" style={{ color: 'var(--purple)' }}>
            {fmtSpeed(smoothTraffic.current.up)}
          </div>
          <div className="rt-chart">
            <Spark pts={smoothTraffic.upPts} color="#BF5AF2" h={132} fill dot />
          </div>
        </div>
        <div>
          <div className="stat-label" style={{ color: 'var(--cyan)' }}>
            <Icon name="download" size={12} />下载速度
          </div>
          <div className="stat-num" style={{ color: 'var(--cyan)' }}>
            {fmtSpeed(smoothTraffic.current.down)}
          </div>
          <div className="rt-chart">
            <Spark pts={smoothTraffic.downPts} color="#64D2FF" h={132} fill dot />
          </div>
        </div>
      </div>
      <div className="rt-foot">
        <span>↑ 总上传 <b>{fmtBytes(upTotal)}</b></span>
        <span>↓ 总下载 <b>{fmtBytes(downTotal)}</b></span>
      </div>
    </Card>
  )
}

function RuntimeStatus() {
  const core = useAppStore((s) => s.coreStatus)
  const connectionCount = useLiveStore((s) => s.connections.connections.length)
  const memInuse = useLiveStore((s) => s.memory.inuse)
  const [platform, setPlatform] = useState('检测中…')
  useEffect(() => {
    let active = true
    void call('get_platform').then((value) => { if (active) setPlatform(value) })
      .catch(() => { if (active) setPlatform('未知系统') })
    return () => { active = false }
  }, [])
  return (
    <Card
      icon={<Icon name="cpu" />}
      iconColor="var(--accent)"
      title="运行状态"
      actions={<span className="dot-live" style={core.running ? undefined : { background: 'var(--text-3)', animation: 'none' }} />}
    >
      <div className="stat-grid">
        <div className="stat-cell">
          <div className="stat-label"><Icon name="clock" size={12} />在线时长</div>
          <div className="stat-num">{core.running ? fmtUptime(core.uptimeSec) : '—'}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label"><Icon name="connections" size={12} />连接数</div>
          <div className="stat-num" style={{ color: 'var(--orange)' }}>
            {connectionCount}
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
          <b>{platform}</b>
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
  )
}
