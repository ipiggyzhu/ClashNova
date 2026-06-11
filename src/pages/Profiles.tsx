import { useCallback, useEffect, useState } from 'react'
import './Profiles.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import CodeEditor from '../components/ui/CodeEditor'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Toggle from '../components/ui/Toggle'
import { call } from '../services/ipc'
import type { EnhancerMeta, ProfileMeta } from '../types/clash'
import { daysLeft, fmtBytes, fmtRelTime } from '../utils/format'

/** 新建增强项的初始模板 */
const ENH_TEMPLATES: Record<EnhancerMeta['kind'], string> = {
  merge: '# YAML 深合并补丁(支持 prepend-X / append-X)\n# 例: 覆写 DNS\ndns:\n  enable: true\n',
  script: '// 须定义 main(config) 并返回配置对象\nfunction main(config) {\n  return config;\n}\n',
}

interface EditorState {
  profile: ProfileMeta
  content: string
}

/** 增强项编辑抽屉状态(enh 为 null 表示新建) */
interface EnhEditorState {
  pid: string
  enh: EnhancerMeta | null
  kind: EnhancerMeta['kind']
  name: string
  content: string
}

export default function Profiles() {
  const [profiles, setProfiles] = useState<ProfileMeta[]>([])
  const [url, setUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [confirmDel, setConfirmDel] = useState<ProfileMeta | null>(null)
  const [enhEditor, setEnhEditor] = useState<EnhEditorState | null>(null)
  const [confirmDelEnh, setConfirmDelEnh] = useState<string | null>(null)

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

  /* ---- 增强链 ---- */
  const currentProfile = profiles.find((p) => p.current) ?? null
  const enhancers = currentProfile?.enhancers ?? []

  const openEnhEditor = async (enh: EnhancerMeta | null, kind: EnhancerMeta['kind']): Promise<void> => {
    if (!currentProfile) return
    const content = enh
      ? await call('read_enhancer', { profileId: currentProfile.id, enhancerId: enh.id })
      : ENH_TEMPLATES[kind]
    setEnhEditor({
      pid: currentProfile.id,
      enh,
      kind: enh?.kind ?? kind,
      name: enh?.name ?? (kind === 'merge' ? '新 Merge 处理器' : '新 Script 处理器'),
      content,
    })
  }

  const saveEnhEditor = async (): Promise<void> => {
    if (!enhEditor) return
    await call('save_enhancer', {
      profileId: enhEditor.pid,
      enhancerId: enhEditor.enh?.id ?? null,
      kind: enhEditor.kind,
      name: enhEditor.name.trim() || '未命名处理器',
      content: enhEditor.content,
    })
    setEnhEditor(null)
    await refresh()
  }

  const toggleEnh = async (enh: EnhancerMeta, enabled: boolean): Promise<void> => {
    if (!currentProfile) return
    await call('toggle_enhancer', { profileId: currentProfile.id, enhancerId: enh.id, enabled })
    await refresh()
  }

  const deleteEnh = async (enh: EnhancerMeta): Promise<void> => {
    if (!currentProfile) return
    await call('delete_enhancer', { profileId: currentProfile.id, enhancerId: enh.id })
    setConfirmDelEnh(null)
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

      {/* ---- 配置增强链(作用于当前订阅) ---- */}
      <Card
        icon={<Icon name="profiles" />}
        iconColor="var(--purple)"
        title="配置增强链"
        actions={
          <span className="chip">
            {currentProfile ? `作用于 ${currentProfile.name} · 自上而下` : '无可用订阅'}
          </span>
        }
        flush
      >
        {enhancers.map((e) => (
          <div className="enh-row" key={e.id}>
            <span className="grip">
              <Icon name="rules" size={13} />
            </span>
            <span className={`ftype ${e.kind === 'merge' ? 'yaml' : 'js'}`}>
              {e.kind === 'merge' ? 'YML' : 'JS'}
            </span>
            <span className="nm">{e.name}</span>
            <span className="chip">{e.kind === 'merge' ? 'YAML' : 'JavaScript'}</span>
            <span className="spacer" />
            <Toggle on={e.enabled} onChange={(on) => void toggleEnh(e, on)} />
            <Button size="sm" onClick={() => void openEnhEditor(e, e.kind)}>编辑</Button>
            {confirmDelEnh === e.id ? (
              <span className="confirm">
                <Button size="sm" variant="danger" onClick={() => void deleteEnh(e)}>确认</Button>
                <Button size="sm" onClick={() => setConfirmDelEnh(null)}>取消</Button>
              </span>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setConfirmDelEnh(e.id)}>
                <Icon name="trash" size={12} />
              </Button>
            )}
          </div>
        ))}
        {currentProfile && (
          <div className="enh-add">
            <Button size="sm" onClick={() => void openEnhEditor(null, 'merge')}>
              <Icon name="plus" size={12} />新建 Merge
            </Button>
            <Button size="sm" onClick={() => void openEnhEditor(null, 'script')}>
              <Icon name="plus" size={12} />新建 Script
            </Button>
          </div>
        )}
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
            <CodeEditor
              value={editor.content}
              onChange={(content) => setEditor({ ...editor, content })}
              lang="yaml"
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
      {/* ---- 增强项编辑抽屉 ---- */}
      {enhEditor && (
        <div className="editor-mask" onClick={() => setEnhEditor(null)}>
          <div className="editor" onClick={(e) => e.stopPropagation()}>
            <div className="ehead">
              <Icon name="edit" size={14} />
              <Input
                className="enh-name"
                value={enhEditor.name}
                onChange={(e) => setEnhEditor({ ...enhEditor, name: e.target.value })}
                placeholder="处理器名称"
              />
              <span className="chip">{enhEditor.kind === 'merge' ? 'YAML' : 'JavaScript'}</span>
              <span className="spacer" />
              <button className="icon-btn" onClick={() => setEnhEditor(null)}>
                <Icon name="x" />
              </button>
            </div>
            <CodeEditor
              value={enhEditor.content}
              onChange={(content) => setEnhEditor({ ...enhEditor, content })}
              lang={enhEditor.kind === 'merge' ? 'yaml' : 'javascript'}
            />
            <div className="efoot">
              <Button onClick={() => setEnhEditor(null)}>取消</Button>
              <Button variant="primary" onClick={() => void saveEnhEditor()}>
                <Icon name="check" size={13} />保存
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
