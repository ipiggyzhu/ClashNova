import { useCallback, useEffect, useState } from 'react'
import './Profiles.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import { call } from '../services/ipc'
import type { ProfileMeta } from '../types/clash'
import { daysLeft, fmtBytes, fmtRelTime } from '../utils/format'

/* M1: 增强链仅静态展示(实际执行在 M2) */
const ENHANCERS = [
  { name: 'Merge: 覆写 DNS 与端口', kind: 'yaml' as const, on: true },
  { name: 'Script: 节点改名+地区分组', kind: 'js' as const, on: true },
  { name: 'Script: 去除无效节点', kind: 'js' as const, on: false },
]

interface EditorState {
  profile: ProfileMeta
  content: string
}

export default function Profiles() {
  const [profiles, setProfiles] = useState<ProfileMeta[]>([])
  const [url, setUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [confirmDel, setConfirmDel] = useState<ProfileMeta | null>(null)

  const refresh = useCallback(async () => {
    setProfiles(await call('list_profiles'))
  }, [])

  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  const doImport = async (): Promise<void> => {
    const u = url.trim()
    if (!u) return
    setImporting(true)
    try {
      await call('import_profile', { url: u })
      setUrl('')
      await refresh()
    } finally {
      setImporting(false)
    }
  }

  const doUpdate = async (p: ProfileMeta): Promise<void> => {
    setBusyId(p.id)
    try {
      await call('update_profile', { id: p.id })
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  const doSelect = async (p: ProfileMeta): Promise<void> => {
    if (p.current) return
    await call('select_profile', { id: p.id })
    await refresh()
  }

  const doDelete = async (p: ProfileMeta): Promise<void> => {
    await call('delete_profile', { id: p.id })
    setConfirmDel(null)
    await refresh()
  }

  const openEditor = async (p: ProfileMeta): Promise<void> => {
    const content = await call('read_profile', { id: p.id })
    setEditor({ profile: p, content })
  }

  const saveEditor = async (): Promise<void> => {
    if (!editor) return
    await call('save_profile_content', { id: editor.profile.id, content: editor.content })
    setEditor(null)
    await refresh()
  }

  return (
    <div className="pg-profiles">
      {/* ---- 导入 ---- */}
      <Card>
        <div className="import-row">
          <Input
            placeholder="粘贴订阅链接 https://… 或 clash:// 协议地址"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doImport()
            }}
          />
          <Button variant="primary" onClick={() => void doImport()} disabled={importing}>
            <Icon name="download" size={13} />
            {importing ? '导入中…' : '导入'}
          </Button>
          <Button disabled title="M2 提供">
            <Icon name="plus" size={13} />新建
          </Button>
          <Button disabled title="M2 提供">
            <Icon name="folder" size={13} />打开文件
          </Button>
        </div>
      </Card>

      {/* ---- 订阅卡 ---- */}
      <div className="cards">
        {profiles.map((p) => {
          const pct = p.quota && p.quota.total > 0 ? p.quota.used / p.quota.total : null
          return (
            <Card key={p.id} className={p.current ? 'pcard cur' : 'pcard'}>
              {p.current && (
                <span className="using">
                  <Badge tone="blue">使用中</Badge>
                </span>
              )}
              <div className="phead">
                <span className="nm">{p.name}</span>
                <span className="chip">{p.kind === 'remote' ? '远程' : '本地'}</span>
              </div>
              {p.url && <div className="purl">{p.url}</div>}

              {pct !== null && p.quota ? (
                <div className="quota">
                  <div className="qrow">
                    <span className="num">{fmtBytes(p.quota.used)}</span>
                    <span className="total">/ {fmtBytes(p.quota.total)}</span>
                    <span className="pct">{Math.round(pct * 100)}%</span>
                  </div>
                  <div className="track">
                    <div className="fill" style={{ width: `${Math.min(100, pct * 100)}%` }} />
                  </div>
                </div>
              ) : (
                <div className="nolimit">∞ — 不限额</div>
              )}

              <div className="pinfo">
                <span>到期 <b>{p.quota?.expireAt ? `${daysLeft(p.quota.expireAt)} 天` : '—'}</b></span>
                <span>自动更新 <b>{p.autoUpdateMin ? `${p.autoUpdateMin} 分钟` : '—'}</b></span>
                <span>更新于 <b>{fmtRelTime(p.updatedAt)}</b></span>
                <span>大小 <b>{p.sizeBytes ? fmtBytes(p.sizeBytes) : '—'}</b></span>
              </div>

              <div className="pacts">
                <Button size="sm" onClick={() => void openEditor(p)}>
                  <Icon name="edit" size={12} />编辑
                </Button>
                {p.kind === 'remote' && (
                  <Button size="sm" onClick={() => void doUpdate(p)} disabled={busyId === p.id}>
                    <Icon name="refresh" size={12} />
                    {busyId === p.id ? '更新中…' : '更新'}
                  </Button>
                )}
                {!p.current && (
                  <Button size="sm" variant="primary" onClick={() => void doSelect(p)}>
                    <Icon name="check" size={12} />启用
                  </Button>
                )}
                <span className="gap" />
                {confirmDel?.id === p.id ? (
                  <span className="confirm">
                    确认删除?
                    <Button size="sm" variant="danger" onClick={() => void doDelete(p)}>删除</Button>
                    <Button size="sm" onClick={() => setConfirmDel(null)}>取消</Button>
                  </span>
                ) : (
                  <Button size="sm" variant="danger" onClick={() => setConfirmDel(p)}>
                    <Icon name="trash" size={12} />删除
                  </Button>
                )}
              </div>
            </Card>
          )
        })}
      </div>

      {/* ---- 配置增强链(M1 静态) ---- */}
      <Card
        icon={<Icon name="profiles" />}
        iconColor="var(--purple)"
        title="配置增强链"
        actions={<span className="chip">处理顺序自上而下</span>}
        flush
      >
        {ENHANCERS.map((e) => (
          <div className="enh-row" key={e.name}>
            <span className="grip" title="拖拽排序(M2)">
              <Icon name="rules" size={13} />
            </span>
            <span className={`ftype ${e.kind}`}>{e.kind === 'yaml' ? 'YML' : 'JS'}</span>
            <span className="nm">{e.name}</span>
            <span className="chip">{e.kind === 'yaml' ? 'YAML' : 'JavaScript'}</span>
            <span className="spacer" />
            <div
              className={e.on ? 'toggle on' : 'toggle'}
              style={{ opacity: 0.5, cursor: 'not-allowed' }}
              title="M2 提供"
            >
              <div className="knob" />
            </div>
            <Button size="sm" disabled title="M2 提供">编辑</Button>
          </div>
        ))}
        <div className="enh-add">+ 新建 Merge / Script 处理器（M2 提供）</div>
      </Card>

      {/* ---- 编辑器抽屉 ---- */}
      {editor && (
        <div className="editor-mask" onClick={() => setEditor(null)}>
          <div className="editor" onClick={(e) => e.stopPropagation()}>
            <div className="ehead">
              <Icon name="edit" size={14} />
              编辑 {editor.profile.name}
              <span className="chip">YAML</span>
              <span className="spacer" />
              <button className="icon-btn" onClick={() => setEditor(null)}>
                <Icon name="x" />
              </button>
            </div>
            <textarea
              value={editor.content}
              onChange={(e) => setEditor({ ...editor, content: e.target.value })}
              spellCheck={false}
            />
            <div className="efoot">
              <Button onClick={() => setEditor(null)}>取消</Button>
              <Button variant="primary" onClick={() => void saveEditor()}>
                <Icon name="check" size={13} />保存
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
