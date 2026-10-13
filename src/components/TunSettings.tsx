import { useRef, useState } from 'react'
import Button from './ui/Button'
import Dialog from './ui/Dialog'
import Input from './ui/Input'
import Toggle from './ui/Toggle'
import { useAppStore } from '../stores/app'
import { DEFAULT_TUN_OPTIONS, type TunOptions } from '../types/tun'
import { parseTunDraft, type TunDraft } from '../utils/tunOptions'
import './TunSettings.css'

export default function TunSettings({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState<TunDraft>(() => {
    const options = { ...DEFAULT_TUN_OPTIONS, ...useAppStore.getState().settings.tunOptions }
    return { options, mtu: options.mtu?.toString() ?? '', device: options.device ?? '',
      interfaceName: options.interfaceName ?? '', dnsHijack: options.dnsHijack?.join('\n') ?? '',
      routeExcludeAddress: options.routeExcludeAddress?.join('\n') ?? '' }
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  const patch = (value: Partial<TunOptions>) => setDraft((current) => ({ ...current, options: { ...current.options, ...value } }))
  const text = (key: Exclude<keyof TunDraft, 'options'>, value: string) => setDraft((current) => ({ ...current, [key]: value }))
  const save = async () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      await useAppStore.getState().patchSettings({ tunOptions: parseTunDraft(draft) })
      onClose()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { savingRef.current = false; setSaving(false) }
  }
  return (
    <Dialog className="tun-mask" panelClassName="tun-panel" title="TUN 高级设置" onClose={onClose} dismissible={!saving}>
      <header>TUN 高级设置</header>
      <div className="tun-body">
        <p>留空项沿用订阅。TUN 已开启时，保存会重新加载内核并短暂调整路由；不会自动开启 TUN。</p>
        {error && <p className="tun-error" role="alert">{error}</p>}
        <fieldset disabled={saving}>
          <label>协议栈<select aria-label="TUN 协议栈" value={draft.options.stack ?? ''} onChange={(e) => patch({ stack: (e.target.value || null) as TunOptions['stack'] })}>
            <option value="">沿用订阅（缺省 gvisor）</option><option value="system">system</option><option value="gvisor">gvisor</option><option value="mixed">mixed</option>
          </select></label>
          <label>虚拟网卡名称<Input aria-label="TUN 虚拟网卡名称" value={draft.device} onChange={(e) => text('device', e.target.value)} placeholder="沿用订阅" /></label>
          <label>MTU<Input aria-label="TUN MTU" inputMode="numeric" value={draft.mtu} onChange={(e) => text('mtu', e.target.value)} placeholder="576–65535，留空沿用" /></label>
          <label>出口网卡名称<Input aria-label="TUN 出口网卡名称" value={draft.interfaceName} onChange={(e) => text('interfaceName', e.target.value)} placeholder="沿用订阅" /></label>
          <div className="tun-switch">自动路由<Toggle label="TUN 自动路由" on={draft.options.autoRoute} disabled={saving} onChange={(autoRoute) => patch({ autoRoute })} /></div>
          <div className="tun-switch">自动检测出口网卡<Toggle label="TUN 自动检测出口网卡" on={draft.options.autoDetectInterface} disabled={saving} onChange={(autoDetectInterface) => patch({ autoDetectInterface })} /></div>
          <label>严格路由<select aria-label="TUN 严格路由" value={draft.options.strictRoute === null ? '' : String(draft.options.strictRoute)} onChange={(e) => patch({ strictRoute: e.target.value === '' ? null : e.target.value === 'true' })}>
            <option value="">沿用订阅</option><option value="true">开启</option><option value="false">关闭</option>
          </select></label>
          {(['dnsHijack', 'routeExcludeAddress'] as const).map((key) => {
            const label = key === 'dnsHijack' ? 'DNS 劫持' : '路由排除'
            return <label key={key} className="tun-list">{label}
              <select aria-label={`${label}设置方式`} value={draft.options[key] === null ? 'inherit' : 'override'} onChange={(e) => patch({ [key]: e.target.value === 'inherit' ? null : [] })}>
                <option value="inherit">沿用订阅</option><option value="override">覆盖（空内容表示清空）</option>
              </select>
              <textarea aria-label={`TUN ${label}`} rows={3} value={draft[key]} disabled={saving || draft.options[key] === null} onChange={(e) => text(key, e.target.value)} placeholder={key === 'dnsHijack' ? 'any:53\ntcp://any:53' : '10.0.0.0/8\nfd00::/8'} />
              <small>每行一项；{key === 'dnsHijack' ? '最多 64 项' : 'IPv4 / IPv6 CIDR，最多 256 项'}。</small>
            </label>
          })}
        </fieldset>
      </div>
      <footer><Button onClick={onClose} disabled={saving}>取消</Button><Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存 TUN 设置'}</Button></footer>
    </Dialog>
  )
}
