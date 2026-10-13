import { useEffect, useRef, useState } from 'react'
import Button from './ui/Button'
import Dialog from './ui/Dialog'
import { call, isMock, type IpcCommands } from '../services/ipc'
import { useNotificationStore } from '../stores/notifications'
import './ProtocolImport.css'

/** 原生队列保留到确认或取消，避免冷启动、重建 WebView 时丢失链接。 */
export default function ProtocolImport() {
  const [items, setItems] = useState<IpcCommands['pending_profile_imports']['result']>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const sequence = useRef(0)
  const refresh = async () => {
    const current = ++sequence.current
    const result = await call('pending_profile_imports')
    if (current === sequence.current) setItems(result)
  }
  useEffect(() => {
    let disposed = false
    let stop: (() => void) | undefined
    const reload = () => { void refresh().catch(() => undefined) }
    window.addEventListener('clashnova-profile-imports', reload)
    if (isMock) reload()
    else void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const unlisten = await listen('profile-imports-changed', reload)
      if (disposed) unlisten()
      else { stop = unlisten; reload() }
    }).catch(() => undefined)
    return () => {
      disposed = true
      sequence.current += 1
      stop?.()
      window.removeEventListener('clashnova-profile-imports', reload)
    }
  }, [])
  const current = items[0]
  useEffect(() => setError(''), [current?.id])
  if (!current) return null

  const finish = async (importNow: boolean) => {
    if (busyRef.current || current.importing) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      if (importNow) {
        const profile = await call('confirm_profile_import', { id: current.id })
        useNotificationStore.getState().add('success', '订阅已导入', profile.current
          ? '首个订阅已自动设为当前配置并启用，请在订阅页检查配置。'
          : '当前订阅保持不变，请在订阅页检查配置后再决定是否启用。')
        window.dispatchEvent(new Event('clashnova-profiles-changed'))
      } else await call('dismiss_profile_import', { id: current.id })
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      await refresh().catch(() => undefined)
    }
    finally { busyRef.current = false; setBusy(false) }
  }

  const pending = busy || current.importing
  return <Dialog className="protocol-mask" panelClassName="protocol-panel" title="确认导入订阅" dismissible={!pending} onClose={() => void finish(false)}>
    <h3>确认导入订阅</h3>
    <p>浏览器请求导入来自 <strong>{current.host}</strong> 的配置{current.name ? `「${current.name}」` : ''}。</p>
    <p>仅在你信任该来源时继续。链接中的凭据不会显示；没有订阅时，导入的首个配置会自动启用，已有订阅不会自动切换。</p>
    {items.length > 1 && <p>还有 {items.length - 1} 个请求待确认。</p>}
    {error && <p className="protocol-error" role="alert">{error}</p>}
    <footer><Button disabled={pending} onClick={() => void finish(false)}>取消</Button><Button variant="primary" disabled={pending} onClick={() => void finish(true)}>{pending ? '处理中…' : '确认导入'}</Button></footer>
  </Dialog>
}
