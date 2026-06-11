import { useEffect, useMemo, useState } from 'react'
import './Dashboard.css'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Seg from '../components/ui/Seg'
import Spark from '../components/ui/Spark'
import { useAppStore } from '../stores/app'
import { startLiveStreams, useLiveStore } from '../stores/live'
import { fmtBytes, fmtSpeed, fmtUptime } from '../utils/format'

/* 7 天趋势(M1 静态 mock, 与设计稿一致) */
const TREND = [
  { day: '周六', mb: 320, today: true },
  { day: '周五', mb: 540, today: false },
  { day: '周四', mb: 2350, today: false },
  { day: '周三', mb: 1980, today: false },
  { day: '周二', mb: 760, today: false },
  { day: '周一', mb: 180, today: false },
  { day: '周日', mb: 60, today: false },
]
const TREND_MAX = Math.max(...TREND.map((t) => t.mb))

/* 流量汇总排行(M1 静态 mock) */
const RANKINGS: Record<string, { name: string; mb: number; color: string }[]> = {
  proxy: [
    { name: 'DE-Server', mb: 17.9, color: '#BF5AF2' },
    { name: 'US-OpenAI', mb: 14.9, color: '#BF5AF2' },
    { name: 'US-Streaming', mb: 7.3, color: '#BF5AF2' },
    { name: 'SG-AWS', mb: 2.5, color: '#BF5AF2' },
    { name: 'DIRECT', mb: 2.5, color: 'var(--green)' },
    { name: 'JP-GPT', mb: 2.2, color: '#BF5AF2' },
    { name: 'US-Netflix', mb: 1.3, color: '#BF5AF2' },
  ],
  process: [
    { name: 'chrome.exe', mb: 21.4, color: '#64D2FF' },
    { name: 'Code.exe', mb: 11.2, color: '#64D2FF' },
    { name: 'Telegram.exe', mb: 6.8, color: '#64D2FF' },
    { name: 'steam.exe', mb: 4.1, color: '#64D2FF' },
    { name: 'msedge.exe', mb: 2.9, color: '#64D2FF' },
    { name: 'Spotify.exe', mb: 1.8, color: '#64D2FF' },
    { name: 'System', mb: 1.1, color: '#64D2FF' },
  ],
  iface: [
    { name: 'Wi-Fi', mb: 41.6, color: '#FF9F0A' },
    { name: '以太网', mb: 6.2, color: '#FF9F0A' },
    { name: 'TUN', mb: 1.5, color: '#FF9F0A' },
  ],
  host: [
    { name: 'youtube.com', mb: 15.2, color: '#40C8E0' },
    { name: 'openai.com', mb: 9.6, color: '#40C8E0' },
    { name: 'github.com', mb: 6.4, color: '#40C8E0' },
    { name: 'telegram.org', mb: 5.1, color: '#40C8E0' },
    { name: 'netflix.com', mb: 4.4, color: '#40C8E0' },
    { name: 'apple.com', mb: 2.7, color: '#40C8E0' },
    { name: 'bilibili.com', mb: 1.9, color: '#40C8E0' },
  ],
}

const DONUT = { proxyMb: 46.8, directMb: 2.5, upMb: 16.3, downMb: 33.1 }

export default function Dashboard() {
  const core = useAppStore((s) => s.coreStatus)
  const refreshCoreStatus = useAppStore((s) => s.refreshCoreStatus)
  const traffic = useLiveStore((s) => s.traffic)
  const connections = useLiveStore((s) => s.connections)

  const [sumRange, setSumRange] = useState('today')
  const [rankBy, setRankBy] = useState('proxy')
  void sumRange

  /* 实时流(traffic/connections)接入 + 内核状态 5s 轮询 */
  useEffect(() => {
    const release = startLiveStreams()
    const timer = setInterval(() => void refreshCoreStatus().catch(() => {}), 5000)
    return () => {
      release()
      clearInterval(timer)
    }
  }, [refreshCoreStatus])

  const last = traffic[traffic.length - 1] ?? { up: 0, down: 0 }
  const upPts = useMemo(() => traffic.map((p) => p.up), [traffic])
  const downPts = useMemo(() => traffic.map((p) => p.down), [traffic])

  const total = DONUT.proxyMb + DONUT.directMb
  const proxyRatio = DONUT.proxyMb / total
  const C = 2 * Math.PI * 64
  const ranking = RANKINGS[rankBy] ?? RANKINGS['proxy']!
  const rankMax = Math.max(...ranking.map((r) => r.mb))

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
                {fmtBytes(core.memoryBytes, 0)}
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
              <b>v2.0.0</b>
            </div>
            <div className="stat-cell">
              <div className="stat-label">内核</div>
              <b>mihomo {core.version}</b>
            </div>
          </div>
        </Card>

        {/* ---- 网络状态(M1 静态探测占位) ---- */}
        <Card
          icon={<Icon name="globe2" />}
          iconColor="var(--cyan)"
          title="网络状态"
          actions={
            <button className="icon-btn" title="刷新">
              <Icon name="refresh" />
            </button>
          }
        >
          <div className="stat-grid">
            <div className="stat-cell">
              <div className="stat-label"><Icon name="globe2" size={12} />互联网</div>
              <div className="stat-num" style={{ color: 'var(--orange)' }}>
                213 <span style={{ fontSize: 12 }}>ms</span>
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-label"><Icon name="search" size={12} />DNS</div>
              <div className="stat-num" style={{ color: 'var(--green)' }}>
                48 <span style={{ fontSize: 12 }}>ms</span>
              </div>
            </div>
            <div className="stat-cell">
              <div className="stat-label"><Icon name="wifi" size={12} />路由器</div>
              <div className="stat-num" style={{ color: 'var(--cyan)' }}>
                6 <span style={{ fontSize: 12 }}>ms</span>
              </div>
            </div>
          </div>
          <div className="stat-grid stat-sub">
            <div className="stat-cell">
              <div className="stat-label">网络</div>
              <b>Wi-Fi</b>
            </div>
            <div className="stat-cell">
              <div className="stat-label">本机 IP</div>
              <b>CN 海西…157.83</b>
            </div>
            <div className="stat-cell">
              <div className="stat-label">代理 IP</div>
              <b>HK Hong…249.100.80</b>
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
                {fmtSpeed(last.up)}
              </div>
              <div style={{ height: 64, marginTop: 8 }}>
                <Spark pts={upPts.length >= 2 ? upPts : [0, 0]} color="#BF5AF2" h={64} fill dot />
              </div>
            </div>
            <div>
              <div className="stat-label" style={{ color: 'var(--cyan)' }}>
                <Icon name="download" size={12} />下载速度
              </div>
              <div className="stat-num" style={{ color: 'var(--cyan)' }}>
                {fmtSpeed(last.down)}
              </div>
              <div style={{ height: 64, marginTop: 8 }}>
                <Spark pts={downPts.length >= 2 ? downPts : [0, 0]} color="#64D2FF" h={64} fill dot />
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
          <div className="trend">
            <div className="avg-line" />
            <div className="avg-label">
              <div className="stat-label">日均</div>
              <div className="stat-num">883.5 MB</div>
            </div>
            {TREND.map((t) => (
              <div className="tcol" key={t.day}>
                <div
                  className="bar-col"
                  style={{
                    height: `${Math.max(6, (t.mb / TREND_MAX) * 110)}px`,
                    background: t.mb >= 1900 ? '#5e5e66' : undefined,
                  }}
                />
                {t.today && <div className="tick" />}
                <span>{t.day}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* ---- 流量汇总 ---- */}
      <Card
        icon={<Icon name="clock" />}
        iconColor="var(--pink)"
        title="流量汇总"
        actions={
          <Seg
            items={[
              { value: 'today', label: '今日' },
              { value: 'month', label: '本月' },
              { value: 'lastMonth', label: '上月' },
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
              <div className="stat-num">{total.toFixed(1)} MB</div>
            </div>
          </div>
          <div className="sum-legend">
            <div className="row">
              <span className="ic"><Icon name="upload" size={13} /></span>上传
              <b>{DONUT.upMb.toFixed(1)} MB</b>
            </div>
            <div className="row">
              <span className="ic"><Icon name="download" size={13} /></span>下载
              <b>{DONUT.downMb.toFixed(1)} MB</b>
            </div>
            <div className="row">
              <span className="dot" style={{ background: 'var(--green)' }} />直连
              <b>{DONUT.directMb.toFixed(1)} MB</b>
            </div>
            <div className="row">
              <span className="dot" style={{ background: 'var(--accent)' }} />代理
              <b>{DONUT.proxyMb.toFixed(1)} MB</b>
            </div>
            <div className="split-bar">
              <div style={{ width: `${(1 - proxyRatio) * 100}%`, background: 'var(--green)' }} />
              <div style={{ width: `${proxyRatio * 100}%`, background: 'var(--accent)' }} />
            </div>
          </div>
          <div className="rank">
            <div className="rank-head">
              <div className="stat-label"><Icon name="rules" size={12} />排行</div>
              <Seg
                items={[
                  { value: 'proxy', label: '代理' },
                  { value: 'process', label: '进程' },
                  { value: 'iface', label: '接口' },
                  { value: 'host', label: '主机名' },
                ]}
                value={rankBy}
                onChange={setRankBy}
              />
            </div>
            {ranking.map((r) => (
              <div className="rank-row" key={r.name}>
                <span className="nm">
                  <i style={{ background: r.color }} />
                  {r.name}
                </span>
                <span className="track">
                  <span
                    className="fill"
                    style={{
                      width: `${(r.mb / rankMax) * 100}%`,
                      background: `linear-gradient(90deg, ${r.color}, color-mix(in srgb, ${r.color} 55%, transparent))`,
                    }}
                  />
                </span>
                <span className="val">{r.mb.toFixed(1)} MB</span>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  )
}
