import { useEffect, useRef, useState } from 'react'
import type { ProfileMeta } from '../types/clash'
import { call } from '../services/ipc'
import Button from './ui/Button'
import Dialog from './ui/Dialog'
import Icon from './ui/Icon'
import Input from './ui/Input'
import { applyTopologyEdit, createTopologyDraft, editTopologyEntry, entryName, topologyPayload } from './profileTopology'
import type { TopologyDraft, TopologyEdit, TopologyKind } from './profileTopology'

interface Props { profile: ProfileMeta; onClose: () => void; onSaved: () => Promise<void> }
const NODE_TYPES = ['ss', 'vmess', 'vless', 'trojan', 'socks5', 'http', 'hysteria2', 'tuic', 'wireguard', 'direct']
const GROUP_TYPES = ['select', 'url-test', 'fallback', 'load-balance', 'relay']
const text = (value: unknown): string => value === undefined ? '' : String(value)
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

export default function ProfileTopologyEditor({ profile, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<TopologyDraft | null>(null)
  const [edit, setEdit] = useState<TopologyEdit | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    let disposed = false
    void call('read_profile_topology', { id: profile.id }).then((topology) => {
      if (disposed) return
      const next = createTopologyDraft(topology)
      setDraft(next)
      if (next.proxies.length) setEdit(editTopologyEntry(next, 'proxies', 0))
      else if (next.groups.length) setEdit(editTopologyEntry(next, 'groups', 0))
    }).catch((error: unknown) => { if (!disposed) setError(errorText(error)) })
    return () => { disposed = true }
  }, [profile.id])

  const field = (key: string, value: unknown): void => {
    if (!edit) return
    const next = { ...edit.value }
    if (value === '') delete next[key]
    else next[key] = value
    setEdit({ ...edit, value: next })
  }

  const select = (kind: TopologyKind, index: number): void => {
    if (!draft) return
    try {
      const next = applyTopologyEdit(draft, edit)
      setDraft(next)
      setEdit(editTopologyEntry(next, kind, index))
      setConfirmDelete(false)
      setError('')
    } catch (error) { setError(errorText(error)) }
  }

  const add = (kind: TopologyKind): void => {
    if (!draft) return
    try {
      const next = applyTopologyEdit(draft, edit)
      const entries = next[kind]
      const names = new Set(next.proxies.concat(next.groups).map((entry) => entryName(entry.value)))
      const prefix = kind === 'proxies' ? '新节点' : '新策略组'
      let suffix = 1
      while (names.has(`${prefix} ${suffix}`)) suffix += 1
      const value = kind === 'proxies'
        ? { name: `${prefix} ${suffix}`, type: 'socks5', server: '', port: 1080 }
        : { name: `${prefix} ${suffix}`, type: 'select', proxies: ['DIRECT'] }
      const added = { ...next, [kind]: [...entries, { originalName: null, value }] }
      setDraft(added)
      setEdit(editTopologyEntry(added, kind, entries.length))
      setConfirmDelete(false)
      setError('')
    } catch (error) { setError(errorText(error)) }
  }

  const remove = (): void => {
    if (!draft || !edit) return
    const next = { ...draft, [edit.kind]: draft[edit.kind].filter((_, index) => index !== edit.index) }
    setDraft(next)
    setEdit(null)
    setConfirmDelete(false)
    setError('')
  }

  const save = async (): Promise<void> => {
    if (!draft || savingRef.current) return
    setError('')
    try {
      const next = applyTopologyEdit(draft, edit)
      savingRef.current = true
      setSaving(true)
      await call('save_profile_topology', { id: profile.id, ...topologyPayload(next) })
      await onSaved()
      onClose()
    } catch (error) { setError(errorText(error)) }
    finally { savingRef.current = false; setSaving(false) }
  }

  const fieldInput = (key: string, label: string, type = 'text') => (
    <label key={key}><span>{label}</span><Input type={type} value={text(edit?.value[key])} autoComplete="off"
      min={type === 'number' ? 1 : undefined} max={key === 'port' ? 65535 : undefined}
      onChange={(event) => field(key, type === 'number' && event.target.value ? Number(event.target.value) : event.target.value)} /></label>
  )
  const node = edit?.kind === 'proxies'
  const kinds = node ? NODE_TYPES : GROUP_TYPES
  const kind = text(edit?.value.type)

  return (
    <Dialog className="editor-mask" panelClassName="topology-editor" title={`节点与策略组：${profile.name}`} onClose={onClose} dismissible={!saving}>
      <div className="ehead"><Icon name="proxies" size={14} />节点与策略组 · {profile.name}
        <span className="spacer" /><button type="button" className="icon-btn" aria-label="关闭" onClick={onClose} disabled={saving}><Icon name="x" /></button>
      </div>
      <div className="topology-note">保留其他配置和高级字段。重命名同步更新引用；仍被使用的条目不能直接删除。远程订阅刷新会覆盖本地编辑。</div>
      {!draft && !error && <div className="topology-note" role="status">正在读取配置…</div>}
      {draft && <div className="topology-body">
        <aside className="topology-list" aria-label="配置条目">
          {(['proxies', 'groups'] as const).map((category) => <section key={category}>
            <div className="topology-category"><strong>{category === 'proxies' ? '节点' : '策略组'} · {draft[category].length}</strong>
              <Button size="sm" disabled={saving} onClick={() => add(category)}>{category === 'proxies' ? '添加节点' : '添加策略组'}</Button></div>
            {draft[category].map((entry, index) => <button key={index} type="button"
              className="topology-item" aria-pressed={edit?.kind === category && edit.index === index} disabled={saving}
              onClick={() => select(category, index)}>{edit?.kind === category && edit.index === index ? entryName(edit.value) || '未命名' : entryName(entry.value)}</button>)}
          </section>)}
        </aside>
        {edit ? <fieldset className="topology-form" disabled={saving}>
          <legend>{node ? '节点参数' : '策略组参数'}</legend>
          {fieldInput('name', '名称')}
          <label><span>类型</span><select aria-label="类型" value={kind} onChange={(event) => field('type', event.target.value)}>
            {!kinds.includes(kind) && <option value={kind}>{kind}</option>}
            {kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </select></label>
          {node ? <>
            {fieldInput('server', '服务器')}{fieldInput('port', '端口', 'number')}
            {fieldInput('password', '密码', 'password')}{fieldInput('uuid', 'UUID')}
            {fieldInput('cipher', '加密方式')}{fieldInput('username', '用户名')}
            <div className="topology-checks">{['udp', 'tls'].map((key) => <label key={key}>
              <input type="checkbox" checked={edit.value[key] === true} onChange={(event) => field(key, event.target.checked)} />{key.toUpperCase()}
            </label>)}</div>
          </> : <>
            <label className="topology-wide"><span>节点或策略组（每行一个，按顺序）</span>
              <textarea aria-label="节点或策略组（每行一个，按顺序）" value={edit.members} rows={5} onChange={(event) => setEdit({ ...edit, members: event.target.value })} /></label>
            <label className="topology-wide"><span>添加可用成员</span><select aria-label="添加可用成员" value="" onChange={(event) => {
              const current = edit.members.split('\n').map((item) => item.trim()).filter(Boolean)
              if (!current.includes(event.target.value)) setEdit({ ...edit, members: [...current, event.target.value].join('\n') })
            }}><option value="" disabled>选择节点或策略组…</option>
              {['DIRECT', 'REJECT', ...draft.proxies.concat(draft.groups).map((entry) => entryName(entry.value))]
                .filter((name) => name !== entryName(edit.value)).map((name) => <option key={name} value={name}>{name}</option>)}
            </select></label>
            <label className="topology-wide"><span>订阅提供者 use（每行一个）</span><textarea aria-label="订阅提供者 use（每行一个）" value={edit.providers} rows={2}
              onChange={(event) => setEdit({ ...edit, providers: event.target.value })} /></label>
            {fieldInput('url', '测速 URL')}{fieldInput('interval', '测速间隔（秒）', 'number')}
          </>}
          <label className="topology-wide"><span>高级字段（JSON，保留传输、TLS 等扩展参数）</span>
            <textarea aria-label="高级字段（JSON，保留传输、TLS 等扩展参数）" className="topology-json" rows={6} value={edit.advanced} spellCheck={false}
              onChange={(event) => setEdit({ ...edit, advanced: event.target.value })} /></label>
          <div className="topology-wide topology-delete">{confirmDelete ? <>
            <span>确认从配置中移除此条目？</span><Button size="sm" variant="danger" onClick={remove}>确认移除</Button>
            <Button size="sm" onClick={() => setConfirmDelete(false)}>取消</Button>
          </> : <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>移除此条目</Button>}</div>
        </fieldset> : <div className="topology-note">选择左侧条目进行编辑，或添加新节点、策略组。</div>}
      </div>}
      {error && <div className="editor-error" role="alert">{error}</div>}
      <div className="efoot"><Button disabled={saving} onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={!draft || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存配置'}</Button></div>
    </Dialog>
  )
}
