import { useEffect, useRef, useState } from 'react'
import Button from './ui/Button'
import Dialog from './ui/Dialog'
import Icon from './ui/Icon'
import Input from './ui/Input'
import { useT } from '../i18n'
import { call } from '../services/ipc'
import { useAppStore } from '../stores/app'
import { useNotificationStore } from '../stores/notifications'
import type { BackupEntry, BackupPreview, WebDavConfig } from '../types/backup'
import { fmtBytes } from '../utils/format'
import './BackupSettings.css'

interface Props { onClose: () => void }
type Confirmation = { kind: 'restore' | 'delete' | 'remote-delete' | 'upload' | 'export'; entry: BackupEntry; preview?: BackupPreview }

const EMPTY_DAV: WebDavConfig = { url: '', username: '', passwordSaved: false }
const MAX_BACKUP_BYTES = 64 * 1024 * 1024

export default function BackupSettings({ onClose }: Props) {
  const t = useT()
  const notify = useNotificationStore((state) => state.add)
  const [entries, setEntries] = useState<BackupEntry[]>([])
  const [remote, setRemote] = useState<BackupEntry[] | null>(null)
  const [label, setLabel] = useState('')
  const [dav, setDav] = useState<WebDavConfig>(EMPTY_DAV)
  const [savedDav, setSavedDav] = useState<WebDavConfig>(EMPTY_DAV)
  const [password, setPassword] = useState('')
  const [passwordEdited, setPasswordEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const busyRef = useRef(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const davDirty = dav.url !== savedDav.url || dav.username !== savedDav.username || passwordEdited
  const remoteReady = Boolean(savedDav.url) && !davDirty
  const disabled = busy || loading

  useEffect(() => {
    let disposed = false
    void Promise.allSettled([call('backup_list'), call('backup_webdav_get')]).then(([items, config]) => {
      if (disposed) return
      if (items.status === 'fulfilled') setEntries(items.value)
      if (config.status === 'fulfilled') { setDav(config.value); setSavedDav(config.value) }
      const failures = [items, config].flatMap((result) => result.status === 'rejected'
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : [])
      if (failures.length) setError(failures.join('；'))
    }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [])

  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try { await operation() }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      notify('error', t('备份操作失败'), message)
    } finally { busyRef.current = false; setBusy(false) }
  }

  const refresh = async (): Promise<void> => { setEntries(await call('backup_list')) }

  const exportFile = async (entry: BackupEntry, redacted: boolean): Promise<void> => {
    const data = await call('backup_export', { id: entry.id, redacted })
    const url = URL.createObjectURL(new Blob([data.content], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = data.filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const importFile = async (file: File): Promise<void> => {
    await run(async () => {
      if (file.size > MAX_BACKUP_BYTES) throw new Error(t('备份文件超过 64 MiB 限制'))
      await call('backup_import', { content: await file.text() })
      await refresh()
      notify('success', t('备份已导入'), t('现有配置未改变；可从本地历史预览并恢复。'))
    })
  }

  const saveDav = async (): Promise<void> => {
    await run(async () => {
      await call('backup_webdav_save', {
        config: { url: dav.url.trim(), username: dav.username, ...(passwordEdited ? { password } : {}) },
      })
      const saved = await call('backup_webdav_get')
      setDav(saved)
      setSavedDav(saved)
      setPassword('')
      setPasswordEdited(false)
      setRemote(null)
      notify('success', t('WebDAV 设置已保存'), '')
    })
  }

  const confirm = async (): Promise<void> => {
    if (!confirmation) return
    const { entry, kind } = confirmation
    await run(async () => {
      if (kind === 'restore') {
        await call('backup_restore', { id: entry.id })
        await useAppStore.getState().loadAll()
        await refresh()
        notify('success', t('备份已恢复'), t('本机连接设置保持不变；恢复前快照已保留。'))
      } else if (kind === 'delete') {
        await call('backup_delete', { id: entry.id })
        await refresh()
      } else if (kind === 'remote-delete') {
        await call('backup_webdav_delete', { id: entry.id })
        setRemote(await call('backup_webdav_list'))
      } else if (kind === 'upload') {
        await call('backup_webdav_upload', { id: entry.id })
        setRemote(await call('backup_webdav_list'))
        notify('success', t('备份已上传并通过回读校验'), '')
      } else {
        await exportFile(entry, false)
      }
      setConfirmation(null)
    })
  }

  const confirmationTitle = confirmation?.kind === 'restore' ? t('确认恢复备份')
    : confirmation?.kind === 'upload' ? t('确认上传完整备份')
      : confirmation?.kind === 'export' ? t('确认导出完整备份') : t('确认删除备份')

  return <>
    <Dialog title={t('备份与恢复')} className="backup-mask" panelClassName="backup-panel" onClose={onClose} dismissible={!disabled}>
      <div className="backup-head">
        <h3>{t('备份与恢复')}</h3>
        <button className="icon-btn" type="button" aria-label={t('关闭备份与恢复')} onClick={onClose} disabled={disabled}><Icon name="x" size={17} /></button>
      </div>
      <div className="backup-body">
        <p className="backup-note">{t('完整备份包含设置、订阅和全局增强，也包含订阅地址与节点密钥。请妥善保管；需要分享时仅导出脱敏摘要。')}</p>
        {error && <div role="alert" className="backup-error">{error}</div>}
        <section aria-label={t('本地备份历史')}>
          <div className="backup-toolbar">
            <h4>{t('本地备份历史')}</h4>
            <Button size="sm" disabled={disabled} onClick={() => void run(refresh)}>{t('刷新历史')}</Button>
          </div>
          <div className="backup-toolbar">
            <Input aria-label={t('备份备注')} placeholder={t('备份备注（可选）')} value={label} maxLength={80} disabled={disabled} onChange={(event) => setLabel(event.target.value)} />
            <Button variant="primary" disabled={disabled} onClick={() => void run(async () => {
              await call('backup_create', { label })
              setLabel('')
              await refresh()
            })}>{t('创建备份')}</Button>
            <Button disabled={disabled} onClick={() => fileRef.current?.click()}>{t('导入备份文件')}</Button>
            <input ref={fileRef} type="file" accept=".novabackup,.json,application/json" aria-label={t('选择备份文件')} hidden onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void importFile(file)
            }} />
          </div>
          {loading ? <p role="status">{t('加载中…')}</p> : !entries.length && <p className="backup-empty">{t('暂无本地备份')}</p>}
          <ul className="backup-list">
            {entries.map((entry) => <li key={entry.id}>
              <div className="backup-entry-info"><strong>{entry.label}</strong><small>{new Date(entry.createdAt).toLocaleString()} · {entry.appVersion ? `v${entry.appVersion} · ` : ''}{fmtBytes(entry.sizeBytes)}</small>{entry.error && <small className="backup-damaged">{entry.error}</small>}</div>
              <div className="backup-actions">
                <Button size="sm" disabled={disabled || Boolean(entry.error)} onClick={() => void run(async () => {
                  const preview = await call('backup_preview', { id: entry.id })
                  setConfirmation({ kind: 'restore', entry, preview })
                })}>{t('预览恢复')}</Button>
                <Button size="sm" disabled={disabled || Boolean(entry.error)} onClick={() => setConfirmation({ kind: 'export', entry })}>{t('导出完整备份')}</Button>
                <Button size="sm" disabled={disabled || Boolean(entry.error)} onClick={() => void run(() => exportFile(entry, true))}>{t('脱敏摘要')}</Button>
                <Button size="sm" disabled={disabled || !remoteReady || Boolean(entry.error)} onClick={() => setConfirmation({ kind: 'upload', entry })}>{t('上传')}</Button>
                <Button size="sm" variant="danger" disabled={disabled} onClick={() => setConfirmation({ kind: 'delete', entry })}>{t('删除')}</Button>
              </div>
            </li>)}
          </ul>
        </section>
        <section aria-label="WebDAV">
          <h4>WebDAV</h4>
          <p className="backup-note">{t('使用 HTTPS 目录地址；父目录需已存在。密码由 Windows 当前用户凭据保护，不会进入备份。留空服务器地址并保存可清除本机凭据。')}</p>
          <div className="backup-dav-fields">
            <label>{t('WebDAV 目录地址')}<Input value={dav.url} placeholder="https://dav.example.com/ClashNova/" type="url" disabled={disabled} onChange={(event) => setDav({ ...dav, url: event.target.value })} /></label>
            <label>{t('WebDAV 用户名')}<Input value={dav.username} autoComplete="off" disabled={disabled} onChange={(event) => setDav({ ...dav, username: event.target.value })} /></label>
            <label>{t('WebDAV 密码')}<Input type="password" value={password} autoComplete="new-password" placeholder={dav.passwordSaved ? t('已保存，留空保持；修改账号后需重新输入') : t('未保存密码')} disabled={disabled} onChange={(event) => { setPassword(event.target.value); setPasswordEdited(true) }} /></label>
          </div>
          <div className="backup-toolbar">
            <Button disabled={disabled || !davDirty} onClick={() => void saveDav()}>{t('保存 WebDAV 设置')}</Button>
            <Button disabled={disabled || !remoteReady} onClick={() => void run(async () => setRemote(await call('backup_webdav_list')))}>{t('连接并刷新远程')}</Button>
            {davDirty && <small className="backup-note">{t('先保存设置，再连接或上传')}</small>}
          </div>
          {remote && <>
            {!remote.length && <p className="backup-empty">{t('远程目录暂无备份')}</p>}
            <ul className="backup-list">
              {remote.map((entry) => <li key={entry.id}>
                <div className="backup-entry-info"><strong>{entry.label}</strong><small>{new Date(entry.createdAt).toLocaleString()} · {fmtBytes(entry.sizeBytes)}</small></div>
                <div className="backup-actions">
                  <Button size="sm" disabled={disabled || !remoteReady} onClick={() => void run(async () => {
                    await call('backup_webdav_download', { id: entry.id })
                    await refresh()
                    notify('success', t('远程备份已下载'), t('现有配置未改变；可从本地历史预览并恢复。'))
                  })}>{t('下载到本地')}</Button>
                  <Button size="sm" variant="danger" disabled={disabled || !remoteReady} onClick={() => setConfirmation({ kind: 'remote-delete', entry })}>{t('删除远程备份')}</Button>
                </div>
              </li>)}
            </ul>
          </>}
        </section>
      </div>
      <div className="backup-footer"><span role="status">{busy ? t('正在处理…') : t('备份不包含运行日志、统计数据库或 WebDAV 凭据。')}</span><Button onClick={onClose} disabled={disabled}>{t('完成')}</Button></div>
    </Dialog>
    {confirmation && <Dialog title={confirmationTitle} className="backup-mask" panelClassName="backup-confirm" dismissible={!busy} onClose={() => setConfirmation(null)}>
      <div className="backup-head"><h3>{confirmationTitle}</h3></div>
      <div className="backup-body">
        <p><strong>{confirmation.entry.label}</strong> · {new Date(confirmation.entry.createdAt).toLocaleString()}</p>
        {confirmation.preview ? <>
          <p>{t('订阅')}：{confirmation.preview.profileCount} · {t('增强项')}：{confirmation.preview.enhancerCount} · {t('文件')}：{confirmation.preview.fileCount} · v{confirmation.preview.entry.appVersion}</p>
          {confirmation.preview.warnings.map((warning) => <p className="backup-note" key={warning}>{t(warning)}</p>)}
          <details><summary>{t('保留的本机设置')}</summary><p className="backup-preserved">{confirmation.preview.preservedSettings.join(', ')}</p></details>
        </> : confirmation.kind === 'delete' || confirmation.kind === 'remote-delete'
          ? <p className="backup-note">{t('仅删除选中的备份文件，不修改当前配置。删除后不可撤销。')}</p>
          : <p className="backup-note">{t('完整备份未经加密，包含订阅地址和节点密钥。仅保存到可信设备或你管理的 WebDAV 服务器。')}</p>}
        {error && <div role="alert" className="backup-error">{error}</div>}
      </div>
      <div className="backup-footer"><Button disabled={busy} onClick={() => setConfirmation(null)}>{t('取消')}</Button><Button variant={confirmation.kind.includes('delete') ? 'danger' : 'primary'} disabled={busy} onClick={() => void confirm()}>{busy ? t('正在处理…') : confirmationTitle}</Button></div>
    </Dialog>}
  </>
}
