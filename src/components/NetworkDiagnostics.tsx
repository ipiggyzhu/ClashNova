import { useEffect, useRef, useState } from 'react'
import Button from './ui/Button'
import Card from './ui/Card'
import Badge, { type BadgeTone } from './ui/Badge'
import Icon from './ui/Icon'
import Toggle from './ui/Toggle'
import { call, isMock } from '../services/ipc'
import type { DiagnosticReport, DiagnosticStatus } from '../types/diagnostics'

const LABELS: Record<DiagnosticStatus, string> = { pass: '通过', warn: '需注意', fail: '异常', unknown: '未确认', skipped: '未检测' }
const TONES: Record<DiagnosticStatus, BadgeTone> = { pass: 'green', warn: 'orange', fail: 'red', unknown: 'gray', skipped: 'gray' }
// 仅影响界面展示顺序；导出报告保持后端原始顺序
const SEVERITY: Record<DiagnosticStatus, number> = { fail: 0, warn: 1, unknown: 2, skipped: 2, pass: 3 }

export default function NetworkDiagnostics() {
  const [includeInternet, setIncludeInternet] = useState(false)
  const [report, setReport] = useState<DiagnosticReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const active = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const run = async (): Promise<void> => {
    if (active.current) return
    active.current = true
    setBusy(true)
    setError('')
    setReport(null)
    try {
      const result = await call('diagnostics_run', { includeInternet })
      if (alive.current) setReport(result)
    } catch {
      // 不将意外 IPC 错误中的路径或参数回显到界面与导出报告。
      if (alive.current) setError('诊断未完成或已有诊断正在进行，请稍后重试。没有修改系统网络设置。')
    } finally {
      active.current = false
      if (alive.current) setBusy(false)
    }
  }

  const exportReport = (): void => {
    if (!report || busy) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'ClashNova-diagnostics.json'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const count = (...statuses: DiagnosticStatus[]): number => report?.checks.filter((item) => statuses.includes(item.status)).length ?? 0
  const fails = count('fail')
  const warns = count('warn')

  return <Card className="network-diagnostics" title="一键网络诊断" icon={<Icon name="connections" />} aria-busy={busy} actions={<>
    <Button size="sm" onClick={exportReport} disabled={!report || busy}>导出脱敏报告</Button>
    <Button size="sm" variant="primary" onClick={() => void run()} disabled={busy}>{busy ? '诊断中…' : '开始诊断'}</Button>
  </>}>
    <p className="diagnostic-note">只读检查内核、监听端口、Windows 服务、系统手动代理、DNS 和 TUN 状态，不修复、不启停、不改代理或 IPv6。最长约 25 秒。</p>
    <div className="diagnostic-option"><span>包含外网探测（DNS、IPv4 / IPv6、mihomo）</span>
      <Toggle label="包含外网探测" on={includeInternet} disabled={busy} onChange={(value) => { setIncludeInternet(value); setReport(null) }} />
    </div>
    <p className="diagnostic-note">外网探测会通过内核查询 example.com，并访问 Cloudflare 的 one.one.one.one。IPv4 / IPv6 探测不使用 HTTP 代理，但仍遵循系统路由，可能经过 VPN / TUN；mihomo 探测遵循当前策略且不直连兜底。不发送订阅或日志。</p>
    <details className="test-more">
      <summary>隐私说明</summary>
      <p>报告仅包含检查结论、版本、时间和耗时，不包含密钥、订阅链接、IP、用户名、路径、原始配置或日志。导出仅保存到本机，不自动上传。</p>
    </details>
    {isMock && <p className="diagnostic-note">当前为浏览器模拟模式，结果不代表真实系统检测。</p>}
    {error && <p className="diagnostic-error" role="alert">{error}</p>}
    {report && <div aria-live="polite">
      <p className="diagnostic-summary" role="status"><span>{report.source === 'mock' ? '模拟结果' : '本次诊断'} · {report.includeInternet ? '包含外网探测' : '仅本机检查'} · <b className={fails ? 'red' : undefined}>{fails} 项异常</b> / <b className={warns ? 'orange' : undefined}>{warns} 项需注意</b> / {count('unknown', 'skipped')} 项未确认或未检测</span><span className="diagnostic-duration">{report.durationMs} ms</span></p>
      <div className="diagnostic-results">{[...report.checks].sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]).map((item) => <section className={`diagnostic-result diagnostic-${item.status}`} key={item.id} aria-label={`${item.title}诊断结果`}>
        <div className="diagnostic-result-head"><h4>{item.title}</h4>{item.elapsedMs !== null && <small>{item.elapsedMs} ms</small>}<Badge tone={TONES[item.status]}>{LABELS[item.status]}</Badge></div>
        <p>{item.detail}</p>
        {item.suggestion && <p className="diagnostic-suggestion"><Icon name="chevron-right" size={12} />{item.suggestion}</p>}
      </section>)}</div>
    </div>}
  </Card>
}
