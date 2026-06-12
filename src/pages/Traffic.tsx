import { useEffect, useMemo, useState } from 'react'
import './Traffic.css'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Seg from '../components/ui/Seg'
import Spark from '../components/ui/Spark'
import { call } from '../services/ipc'
import { startLiveStreams, useLiveStore } from '../stores/live'
import type { RankRow, SeriesPoint, StatDim, StatRange } from '../types/clash'
import { fmtBytes, fmtSpeed } from '../utils/format'

const DIM_ITEMS: { value: StatDim; label: string }[] = [
  { value: 'proxy', label: '按代理' },
  { value: 'process', label: '按进程' },
  { value: 'host', label: '按域名' },
]

const RANGE_ITEMS: { value: StatRange; label: string }[] = [
  { value: 'day', label: '今日' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
]

const BAR_COLORS = ['#BF5AF2', '#0A84FF', '#64D2FF', '#32D74B', '#FF9F0A', '#FF375F', '#8E8E93']

/** 数值与单位拆开渲染(大数字 + 小单位) */
function BigNum({ bytes }: { bytes: number }) {
  const text = fmtBytes(bytes)
  const m = text.match(/^([\d.]+)\s*(.+)$/)
  return (
    <>
      {m ? m[1] : text}
      <span className="unit">{m ? m[2] : ''}</span>
    </>
  )
}

export default function Traffic() {
  const traffic = useLiveStore((s) => s.traffic)
  const [range, setRange] = useState<StatRange>('7d')
  const [dim, setDim] = useState<StatDim>('proxy')
  const [series, setSeries] = useState<SeriesPoint[]>([])
  const [daySeries, setDaySeries] = useState<SeriesPoint[]>([])
  const [rank, setRank] = useState<RankRow[]>([])

  useEffect(() => startLiveStreams(), [])

  useEffect(() => {
    void call('query_traffic_series', { range }).then(setSeries).catch(() => {})
  }, [range])

  useEffect(() => {
    void call('query_traffic_series', { range: 'day' }).then(setDaySeries).catch(() => {})
  }, [])

  useEffect(() => {
    void call('query_traffic_rank', { dim, range }).then(setRank).catch(() => {})
  }, [dim, range])

  const last = traffic[traffic.length - 1] ?? { up: 0, down: 0 }
  const upPts = useMemo(() => traffic.map((p) => p.up), [traffic])
  const downPts = useMemo(() => traffic.map((p) => p.down), [traffic])
  const peakUp = Math.max(0, ...upPts)
  const peakDown = Math.max(0, ...downPts)

  const todayUp = daySeries.reduce((acc, p) => acc + p.up, 0)
  const todayDown = daySeries.reduce((acc, p) => acc + p.down, 0)

  const trendPts = useMemo(() => series.map((p) => p.up + p.down), [series])
  const rankMax = Math.max(1, ...rank.map((r) => r.up + r.down))
  const rankTotal = Math.max(1, rank.reduce((acc, r) => acc + r.up + r.down, 0))

  return (
    <div className="pg-traffic">
      {/* ---- 实时速率 ---- */}
      <Card
        icon={<Icon name="traffic" />}
        iconColor="var(--green)"
        title="实时速率"
        actions={<span className="chip">60 秒窗口</span>}
      >
        <div className="rt-wrap">
          <div className="rt-cell">
            <span className="rt-label" style={{ color: 'var(--purple)' }}>
              <Icon name="upload" size={12} />上传
            </span>
            <div className="rt-big">{fmtSpeed(last.up)}</div>
            <Spark pts={upPts.length >= 2 ? upPts : [0, 0]} color="#BF5AF2" h={72} fill dot />
            <div className="rt-peak">峰值 {fmtSpeed(peakUp)}</div>
          </div>
          <div className="rt-cell">
            <span className="rt-label" style={{ color: 'var(--cyan)' }}>
              <Icon name="download" size={12} />下载
            </span>
            <div className="rt-big">{fmtSpeed(last.down)}</div>
            <Spark pts={downPts.length >= 2 ? downPts : [0, 0]} color="#64D2FF" h={72} fill dot />
            <div className="rt-peak">峰值 {fmtSpeed(peakDown)}</div>
          </div>
        </div>
      </Card>

      {/* ---- 今日汇总 ---- */}
      <div className="grid3">
        <Card className="t-mini">
          <span className="lbl"><Icon name="upload" size={12} />今日上传</span>
          <div className="val"><BigNum bytes={todayUp} /></div>
          <div className="delta">{daySeries.length} 个小时桶</div>
        </Card>
        <Card className="t-mini">
          <span className="lbl"><Icon name="download" size={12} />今日下载</span>
          <div className="val"><BigNum bytes={todayDown} /></div>
          <div className="delta">{daySeries.length} 个小时桶</div>
        </Card>
        <Card className="t-mini">
          <span className="lbl"><Icon name="traffic" size={12} />今日总计</span>
          <div className="val"><BigNum bytes={todayUp + todayDown} /></div>
          <div className="delta">上行占比 {todayUp + todayDown > 0 ? Math.round((todayUp / (todayUp + todayDown)) * 100) : 0}%</div>
        </Card>
      </div>

      {/* ---- 趋势 + 多维统计 ---- */}
      <Card
        icon={<Icon name="topology" />}
        iconColor="var(--purple)"
        title="多维统计"
        actions={
          <>
            <Seg items={DIM_ITEMS} value={dim} onChange={setDim} />
            <Seg items={RANGE_ITEMS} value={range} onChange={setRange} />
          </>
        }
        flush
      >
        <div className="trend" style={{ padding: '12px 16px 4px' }}>
          <Spark
            pts={trendPts.length >= 2 ? trendPts : [0, 0]}
            color="#0A84FF"
            h={84}
            fill
          />
        </div>
        <div className="q-list">
          {rank.length === 0 ? (
            <div className="empty">暂无统计数据 — 内核运行并产生流量后开始累积</div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>名称</th>
                  <th className="r">上传</th>
                  <th className="r">下载</th>
                  <th className="r">总计</th>
                  <th>占比</th>
                </tr>
              </thead>
              <tbody>
                {rank.map((r, i) => {
                  const total = r.up + r.down
                  const color = BAR_COLORS[i % BAR_COLORS.length]!
                  return (
                    <tr key={r.key}>
                      <td>
                        <span className="t-name" title={r.key}>
                          <i className="tdot" style={{ background: color }} />
                          {r.key}
                        </span>
                      </td>
                      <td className="r num">{fmtBytes(r.up)}</td>
                      <td className="r num">{fmtBytes(r.down)}</td>
                      <td className="r num t-total">{fmtBytes(total)}</td>
                      <td>
                        <span className="pct">
                          <span className="q-bar">
                            <i
                              style={{
                                width: `${(total / rankMax) * 100}%`,
                                background: color,
                              }}
                            />
                          </span>
                          <span className="num">{Math.round((total / rankTotal) * 100)}%</span>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  )
}
