import { useCallback, useEffect, useRef, useState } from 'react'
import './Profiles.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import CodeEditor from '../components/ui/LazyCodeEditor'
import Dialog from '../components/ui/Dialog'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Toggle from '../components/ui/Toggle'
import ProfileMenu from '../components/ProfileMenu'
import type { ProfileMenuState } from '../components/ProfileMenu'
import { getProxies } from '../services/api'
import { call, isMock } from '../services/ipc'
import { useNotificationStore } from '../stores/notifications'
import type { EnhancerMeta, ProfileMeta } from '../types/clash'
import { daysLeft, fmtBytes, fmtRelTime } from '../utils/format'

/** 新建增强项的初始模板 */
const ENH_TEMPLATES: Record<EnhancerMeta['kind'], string> = {
  merge: '# YAML 深合并补丁(支持 prepend-X / append-X)\n# 例: 覆写 DNS\ndns:\n  enable: true\n',
  script: '// 须定义 main(config) 并返回配置对象\nfunction main(config) {\n  return config;\n}\n',
}

const NEW_PROFILE_TEMPLATE = `mixed-port: 7897
allow-lan: false
mode: rule
log-level: info

proxies: []
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - DIRECT
rules:
  - MATCH,DIRECT
`

interface EditorState {
  profile: ProfileMeta
  content: string
  originalContent: string
}

interface RuntimeConfigViewerState {
  content: string
  loading: boolean
  error: string
}

/** 增强项编辑抽屉状态(enh 为 null 表示新建) */
interface EnhEditorState {
  pid: string
  enh: EnhancerMeta | null
  kind: EnhancerMeta['kind']
  name: string
  content: string
  originalName: string
  originalContent: string
}

interface RuleEditorState {
  profileId: string
  profileName: string
  type: string
  value: string
  target: string
  position: 'prepend' | 'append'
}

interface ProfileMetaEditorState {
  profile: ProfileMeta
  name: string
  url: string
  autoUpdateMin: string
}

const RULE_TYPES = [
  { value: 'DOMAIN-SUFFIX', label: '域名后缀' },
  { value: 'DOMAIN', label: '完整域名' },
  { value: 'DOMAIN-KEYWORD', label: '域名关键词' },
  { value: 'IP-CIDR', label: 'IP 段' },
  { value: 'PROCESS-NAME', label: '进程名' },
  { value: 'GEOIP', label: '国家/地区' },
]

const BASE_TARGETS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL']
const BUILTIN_ENHANCER_PREFIX = 'builtin-'

const uniqTargets = (items: string[]): string[] => [
  ...new Set(items.map((item) => item.trim()).filter(Boolean)),
]

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err)

export default function Profiles() {
  const [profiles, setProfiles] = useState<ProfileMeta[]>([])
  const [url, setUrl] = useState('')
  const [newProfile, setNewProfile] = useState<{ name: string; content: string } | null>(null)
  const [busyIds, setBusyIds] = useState(new Set<string>())
  const busyRef = useRef(new Set<string>())
  const importing = busyIds.has('import-url')
  const fileImporting = busyIds.has('import-file')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [runtimeViewer, setRuntimeViewer] = useState<RuntimeConfigViewerState | null>(null)
  const [confirmDel, setConfirmDel] = useState<ProfileMeta | null>(null)
  const [enhEditor, setEnhEditor] = useState<EnhEditorState | null>(null)
  const [ruleEditor, setRuleEditor] = useState<RuleEditorState | null>(null)
  const [metaEditor, setMetaEditor] = useState<ProfileMetaEditorState | null>(null)
  const metaSaving = !!metaEditor && busyIds.has(metaEditor.profile.id)
  const ruleSaving = !!ruleEditor && busyIds.has(ruleEditor.profileId)
  const [dialogError, setDialogError] = useState('')
  const [listError, setListError] = useState('')
  const [ruleTargetsError, setRuleTargetsError] = useState('')
  const [ruleTargets, setRuleTargets] = useState<string[]>(BASE_TARGETS)
  const [profileMenu, setProfileMenu] = useState<ProfileMenuState | null>(null)
  const [confirmDelEnh, setConfirmDelEnh] = useState<string | null>(null)
  const [draggedEnhIndex, setDraggedEnhIndex] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const notify = useNotificationStore((s) => s.add)
  const refreshRevision = useRef(0)
  const runtimeRevision = useRef(0)
  const editorRevision = useRef(0)
  const ruleTargetsRevision = useRef(0)

  const refresh = useCallback(async () => {
    const revision = ++refreshRevision.current
    try {
      const next = await call('list_profiles')
      if (revision === refreshRevision.current) {
        setProfiles(next)
        setListError('')
      }
    } catch (err) {
      if (revision === refreshRevision.current) setListError(`加载订阅列表失败：${errorMessage(err)}`)
    }
  }, [])

  useEffect(() => {
    void refresh()
    let disposed = false
    let unlisten: (() => void) | undefined
    if (!isMock) {
      void import('@tauri-apps/api/event').then(({ listen }) => listen('profiles-changed', () => void refresh()))
        .then((stop) => {
          if (disposed) stop()
          else unlisten = stop
        }).catch((err: unknown) => notify('error', '订阅更新监听失败', errorMessage(err)))
    }
    return () => {
      disposed = true
      refreshRevision.current += 1
      runtimeRevision.current += 1
      editorRevision.current += 1
      ruleTargetsRevision.current += 1
      unlisten?.()
    }
  }, [notify, refresh])

  const runOperation = async (key: string, title: string, action: () => Promise<void>, inDialog = false): Promise<void> => {
    if (busyRef.current.has(key)) return
    busyRef.current.add(key)
    setBusyIds(new Set(busyRef.current))
    if (inDialog) setDialogError('')
    try {
      await action()
    } catch (err) {
      const message = errorMessage(err)
      if (inDialog) setDialogError(`${title}：${message}`)
      notify('error', title, message)
    } finally {
      busyRef.current.delete(key)
      setBusyIds(new Set(busyRef.current))
    }
  }

  const doImport = async (): Promise<void> => {
    const u = url.trim()
    if (!u) return
    await runOperation('import-url', '导入订阅失败', async () => {
      await call('import_profile', { url: u })
      setUrl((current) => current.trim() === u ? '' : current)
      await refresh()
    })
  }

  const doImportFile = async (file: File): Promise<void> => {
    await runOperation('import-file', '打开文件失败', async () => {
      const content = await file.text()
      await call('import_profile_file', { name: file.name, content })
      await refresh()
      notify('success', '导入成功', file.name)
    })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const openNewProfile = (): void => {
    setDialogError('')
    setNewProfile({
      name: `Local Profile ${new Date().toLocaleDateString().replaceAll('/', '-')}.yaml`,
      content: NEW_PROFILE_TEMPLATE,
    })
  }

  const saveNewProfile = async (): Promise<void> => {
    if (!newProfile || busyRef.current.has('new-profile')) return
    const name = newProfile.name.trim() || 'Local Profile.yaml'
    const content = newProfile.content
    await runOperation('new-profile', '新建本地配置失败', async () => {
      await call('import_profile_file', { name, content })
      await refresh()
      setNewProfile(null)
      notify('success', '已新建本地配置', name)
    }, true)
  }

  const doUpdate = async (p: ProfileMeta): Promise<void> => {
    await runOperation(p.id, '更新订阅失败', async () => {
      await call('update_profile', { id: p.id })
      await refresh()
    })
  }

  const doSelect = async (p: ProfileMeta): Promise<void> => {
    if (p.current) return
    await runOperation(p.id, '启用订阅失败', async () => {
      await call('select_profile', { id: p.id })
      await refresh()
    })
  }

  const doDelete = async (p: ProfileMeta): Promise<void> => {
    await runOperation(p.id, '删除订阅失败', async () => {
      await call('delete_profile', { id: p.id })
      setConfirmDel(null)
      await refresh()
    })
  }

  const openEditor = async (p: ProfileMeta): Promise<void> => {
    if (busyRef.current.has(`read-${p.id}`)) return
    const revision = ++editorRevision.current
    await runOperation(`read-${p.id}`, '读取配置失败', async () => {
      const content = await call('read_profile', { id: p.id })
      if (revision !== editorRevision.current) return
      setDialogError('')
      setEditor({ profile: p, content, originalContent: content })
    })
  }

  const saveEditor = async (): Promise<void> => {
    if (!editor || busyRef.current.has(editor.profile.id)) return
    if (editor.content === editor.originalContent) {
      setEditor(null)
      return
    }
    const current = editor
    await runOperation(current.profile.id, '保存配置失败', async () => {
      await call('save_profile_content', { id: current.profile.id, content: current.content })
      await refresh()
      setEditor(null)
    }, true)
  }

  const loadRuntimeConfig = async (): Promise<void> => {
    const revision = ++runtimeRevision.current
    setRuntimeViewer((prev) => prev && ({
      content: prev?.content ?? '',
      loading: true,
      error: '',
    }))
    try {
      const content = await call('get_runtime_config')
      if (revision === runtimeRevision.current) {
        setRuntimeViewer((prev) => prev && ({ content, loading: false, error: '' }))
      }
    } catch (err) {
      if (revision === runtimeRevision.current) {
        setRuntimeViewer((prev) => prev && ({ ...prev, loading: false, error: errorMessage(err) }))
      }
    }
  }

  const openRuntimeViewer = (): void => {
    setRuntimeViewer({ content: '', loading: true, error: '' })
    void loadRuntimeConfig()
  }

  const copyRuntimeConfig = async (): Promise<void> => {
    if (!runtimeViewer?.content) return
    try {
      await navigator.clipboard.writeText(runtimeViewer.content)
    } catch (err) {
      notify('error', '复制运行配置失败', errorMessage(err))
    }
  }

  const openMetaEditor = (p: ProfileMeta): void => {
    setDialogError('')
    setMetaEditor({
      profile: p,
      name: p.name,
      url: p.url ?? '',
      autoUpdateMin: p.autoUpdateMin ? String(p.autoUpdateMin) : '',
    })
  }

  const saveMetaEditor = async (): Promise<void> => {
    if (!metaEditor || metaSaving) return
    const name = metaEditor.name.trim()
    const url = metaEditor.url.trim()
    const intervalText = metaEditor.autoUpdateMin.trim()
    const interval = intervalText ? Number(intervalText) : null
    if (!name) {
      setDialogError('订阅名称不能为空')
      notify('warning', '订阅信息未保存', '订阅名称不能为空')
      return
    }
    if (metaEditor.profile.kind === 'remote' && !url) {
      setDialogError('远程订阅 URL 不能为空')
      notify('warning', '订阅信息未保存', '远程订阅 URL 不能为空')
      return
    }
    if (interval !== null && (!Number.isSafeInteger(interval) || interval < 0)) {
      setDialogError('自动更新间隔需要是 0 或正整数')
      notify('warning', '订阅信息未保存', '自动更新间隔需要是 0 或正整数')
      return
    }
    await runOperation(metaEditor.profile.id, '保存订阅信息失败', async () => {
      await call('update_profile_meta', {
        id: metaEditor.profile.id,
        name,
        url: url || null,
        autoUpdateMin: interval && interval > 0 ? interval : null,
      })
      await refresh()
      setMetaEditor(null)
      notify('success', '订阅信息已保存', name)
    }, true)
  }

  /* ---- 增强链 ---- */
  const currentProfile = profiles.find((p) => p.current) ?? null
  const enhancers = currentProfile?.enhancers ?? []
  const newSaving = busyIds.has('new-profile')
  const editorSaving = !!editor && busyIds.has(editor.profile.id)
  const enhancerSaving = !!enhEditor && busyIds.has(enhEditor.pid)
  const currentBusy = !!currentProfile && busyIds.has(currentProfile.id)

  const openEnhEditor = async (
    enh: EnhancerMeta | null,
    kind: EnhancerMeta['kind'],
    profile = currentProfile,
  ): Promise<void> => {
    if (!profile) return
    if (busyRef.current.has(`read-enh-${enh?.id ?? kind}`)) return
    const revision = ++editorRevision.current
    await runOperation(`read-enh-${enh?.id ?? kind}`, '读取增强项失败', async () => {
      const content = enh
        ? await call('read_enhancer', { profileId: profile.id, enhancerId: enh.id })
        : ENH_TEMPLATES[kind]
      if (revision !== editorRevision.current) return
      const name = enh?.name ?? (kind === 'merge' ? 'New Merge' : 'New Script')
      setDialogError('')
      setEnhEditor({
        pid: profile.id,
        enh,
        kind: enh?.kind ?? kind,
        name,
        content,
        originalName: name,
        originalContent: content,
      })
    })
  }

  const openRuleEditor = async (profile = currentProfile): Promise<void> => {
    if (!profile) return
    const revision = ++ruleTargetsRevision.current
    setDialogError('')
    setRuleTargetsError('')
    setRuleEditor({
      profileId: profile.id,
      profileName: profile.name,
      type: 'DOMAIN-SUFFIX',
      value: '',
      target: 'DIRECT',
      position: 'prepend',
    })
    let targets = [...BASE_TARGETS]
    setRuleTargets(targets)
    const errors: string[] = []
    try {
      const profileTargets = await call('list_profile_rule_targets', { id: profile.id })
      targets = uniqTargets([...targets, ...profileTargets])
    } catch (err) {
      errors.push(`订阅策略：${errorMessage(err)}`)
    }
    try {
      const payload = await getProxies()
      const names = Object.keys(payload.proxies)
        .sort((a, b) => a.localeCompare(b))
      targets = uniqTargets([...targets, ...names])
    } catch (err) {
      errors.push(`运行策略：${errorMessage(err)}`)
    }
    if (revision === ruleTargetsRevision.current) {
      setRuleTargets(targets)
      setRuleTargetsError(errors.length ? `策略列表加载不完整；仍可使用已列出的选项。${errors.join('；')}` : '')
    }
  }

  const saveRuleEditor = async (): Promise<void> => {
    if (!ruleEditor || busyRef.current.has(ruleEditor.profileId)) return
    const value = ruleEditor.value.trim()
    const target = ruleEditor.target.trim()
    if (!value || !target) {
      setDialogError('请填写匹配内容和目标策略')
      notify('warning', '规则未保存', '请填写匹配内容和目标策略')
      return
    }
    const rule = `${ruleEditor.type},${value},${target}`
    const content = `${ruleEditor.position}-rules:\n  - ${JSON.stringify(rule)}\n`
    const profileId = ruleEditor.profileId
    await runOperation(profileId, '添加规则失败', async () => {
      await call('save_enhancer', {
        profileId,
        enhancerId: null,
        kind: 'merge',
        name: `规则：${value} → ${target}`,
        content,
      })
      await refresh()
      setRuleEditor(null)
      notify('success', '规则已添加', rule)
    }, true)
  }

  const saveEnhEditor = async (): Promise<void> => {
    if (!enhEditor || busyRef.current.has(enhEditor.pid)) return
    const name = enhEditor.name.trim() || 'Unnamed enhancer'
    if (
      enhEditor.enh &&
      name === enhEditor.originalName &&
      enhEditor.content === enhEditor.originalContent
    ) {
      setEnhEditor(null)
      return
    }
    const current = enhEditor
    await runOperation(current.pid, '保存增强项失败', async () => {
      await call('save_enhancer', {
        profileId: current.pid,
        enhancerId: current.enh?.id ?? null,
        kind: current.kind,
        name,
        content: current.content,
      })
      await refresh()
      setEnhEditor(null)
    }, true)
  }

  const toggleEnh = async (enh: EnhancerMeta, enabled: boolean): Promise<void> => {
    if (!currentProfile) return
    await runOperation(currentProfile.id, '切换增强项失败', async () => {
      await call('toggle_enhancer', { profileId: currentProfile.id, enhancerId: enh.id, enabled })
      await refresh()
    })
  }

  const deleteEnh = async (enh: EnhancerMeta): Promise<void> => {
    if (!currentProfile) return
    await runOperation(currentProfile.id, '删除增强项失败', async () => {
      await call('delete_enhancer', { profileId: currentProfile.id, enhancerId: enh.id })
      setConfirmDelEnh(null)
      await refresh()
    })
  }

  const reorderEnhancers = async (fromIndex: number, toIndex: number): Promise<void> => {
    if (!currentProfile || fromIndex === toIndex || busyRef.current.has(currentProfile.id)) return
    const newEnhancers = [...enhancers]
    const [moved] = newEnhancers.splice(fromIndex, 1)
    newEnhancers.splice(toIndex, 0, moved)

    await runOperation(currentProfile.id, '重排序失败', async () => {
      await call('reorder_enhancers', {
        profileId: currentProfile.id,
        enhancerIds: newEnhancers.map(e => e.id)
      })
      await refresh()
    })
  }

  const handleEnhDragStart = (e: React.DragEvent, index: number): void => {
    setDraggedEnhIndex(index)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleEnhDragOver = (e: React.DragEvent, index: number): void => {
    e.preventDefault()
    if (draggedEnhIndex === null || draggedEnhIndex === index) return
    e.dataTransfer.dropEffect = 'move'
  }

  const handleEnhDrop = (e: React.DragEvent, dropIndex: number): void => {
    e.preventDefault()
    if (draggedEnhIndex === null) return
    void reorderEnhancers(draggedEnhIndex, dropIndex)
    setDraggedEnhIndex(null)
  }

  const handleEnhDragEnd = (): void => {
    setDraggedEnhIndex(null)
  }

  return (
    <div className="pg-profiles">
      {listError && (
        <div className="profile-error" role="alert">
          {listError}<Button size="sm" onClick={() => void refresh()}>重试</Button>
        </div>
      )}
      {/* ---- 导入 ---- */}
      <Card>
        <div className="import-row">
          <Input
            aria-label="订阅链接"
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
          <Button onClick={openNewProfile}>
            <Icon name="plus" size={13} />新建
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".yaml,.yml,.txt,.conf,.config"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0]
              if (file) void doImportFile(file)
            }}
          />
          <Button onClick={() => fileInputRef.current?.click()} disabled={fileImporting}>
            <Icon name="folder" size={13} />{fileImporting ? '导入中…' : '打开文件'}
          </Button>
          <Button onClick={openRuntimeViewer}>
            <Icon name="settings" size={13} />查看运行配置
          </Button>
        </div>
      </Card>

      {/* ---- 订阅卡 ---- */}
      <div className="cards">
        {profiles.map((p) => {
          const pct = p.quota && p.quota.total > 0 ? p.quota.used / p.quota.total : null
          return (
            <Card
              key={p.id}
              className={p.current ? 'pcard cur' : 'pcard'}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setProfileMenu({ x: e.clientX, y: e.clientY, profile: p })
              }}
            >
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
                <div className="pact-main">
                  <Button size="sm" onClick={() => void openEditor(p)} disabled={busyIds.has(p.id) || busyIds.has(`read-${p.id}`)}>
                    <Icon name="edit" size={12} />编辑
                  </Button>
                  {p.kind === 'remote' && (
                    <Button size="sm" onClick={() => void doUpdate(p)} disabled={busyIds.has(p.id)}>
                      <Icon name="refresh" size={12} />
                      {busyIds.has(p.id) ? '处理中…' : '更新'}
                    </Button>
                  )}
                  {!p.current && (
                    <Button size="sm" variant="primary" onClick={() => void doSelect(p)} disabled={busyIds.has(p.id)}>
                      <Icon name="check" size={12} />启用
                    </Button>
                  )}
                  <Button size="sm" aria-haspopup="menu" aria-label={`${p.name} 的订阅操作`} onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect()
                    setProfileMenu({ x: rect.left, y: rect.bottom + 4, profile: p })
                  }}>更多</Button>
                </div>
                <div className="pact-danger">
                  {confirmDel?.id === p.id ? (
                    <span className="confirm">
                      确认删除?
                      <Button size="sm" variant="danger" onClick={() => void doDelete(p)} disabled={busyIds.has(p.id)}>删除</Button>
                      <Button size="sm" onClick={() => setConfirmDel(null)} disabled={busyIds.has(p.id)}>取消</Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="danger" onClick={() => setConfirmDel(p)}>
                      <Icon name="trash" size={12} />删除
                    </Button>
                  )}
                </div>
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
        {enhancers.map((e, index) => (
          <div
            className={`enh-row ${draggedEnhIndex === index ? 'dragging' : ''}`}
            key={e.id}
            draggable={!currentBusy}
            onDragStart={(ev) => handleEnhDragStart(ev, index)}
            onDragOver={(ev) => handleEnhDragOver(ev, index)}
            onDrop={(ev) => handleEnhDrop(ev, index)}
            onDragEnd={handleEnhDragEnd}
          >
            <span className="grip" style={{ cursor: 'grab' }}>
              <Icon name="rules" size={13} />
            </span>
            <span className={`ftype ${e.kind === 'merge' ? 'yaml' : 'js'}`}>
              {e.kind === 'merge' ? 'YML' : 'JS'}
            </span>
            <span className="nm">{e.name}</span>
            {e.id.startsWith(BUILTIN_ENHANCER_PREFIX) && <span className="chip builtin">内置</span>}
            <span className="chip">{e.kind === 'merge' ? 'YAML' : 'JavaScript'}</span>
            <span className="spacer" />
            <Toggle label={`启用增强项：${e.name}`} on={e.enabled} onChange={(on) => void toggleEnh(e, on)} disabled={currentBusy} />
            <Button size="sm" onClick={() => void openEnhEditor(e, e.kind)} disabled={currentBusy || busyIds.has(`read-enh-${e.id}`)}>编辑</Button>
            {confirmDelEnh === e.id ? (
              <span className="confirm">
                <Button size="sm" variant="danger" onClick={() => void deleteEnh(e)} disabled={currentBusy}>确认</Button>
                <Button size="sm" onClick={() => setConfirmDelEnh(null)} disabled={currentBusy}>取消</Button>
              </span>
            ) : (
              <Button size="sm" variant="danger" aria-label={`删除增强项：${e.name}`} onClick={() => setConfirmDelEnh(e.id)} disabled={currentBusy}>
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

      {newProfile && (
        <Dialog className="editor-mask" panelClassName="editor new-profile-editor" title="新建本地配置"
          onClose={() => setNewProfile(null)} dismissible={!newSaving}>
            <div className="ehead">
              <Icon name="plus" size={14} />
              新建本地配置
              <Input
                aria-label="本地配置名称"
                className="enh-name"
                value={newProfile.name}
                disabled={newSaving}
                onChange={(e) => setNewProfile({ ...newProfile, name: e.target.value })}
                placeholder="Local Profile.yaml"
              />
              <span className="chip">YAML</span>
              <span className="spacer" />
              <button type="button" className="icon-btn" aria-label="关闭" onClick={() => setNewProfile(null)} disabled={newSaving}>
                <Icon name="x" />
              </button>
            </div>
            <div className="new-profile-hint">
              默认模板会直连所有流量。可以先创建，再通过编辑规则或扩展覆写配置逐步添加代理节点和分流规则。
            </div>
            <CodeEditor
              label="新建本地配置内容"
              value={newProfile.content}
              readOnly={newSaving}
              onChange={(content) => setNewProfile({ ...newProfile, content })}
              lang="yaml"
            />
            {dialogError && <div className="editor-error" role="alert">{dialogError}</div>}
            <div className="efoot">
              <Button onClick={() => setNewProfile(null)} disabled={newSaving}>取消</Button>
              <Button variant="primary" onClick={() => void saveNewProfile()} disabled={newSaving}>
                <Icon name="check" size={13} />{newSaving ? '创建中…' : '创建'}
              </Button>
            </div>
        </Dialog>
      )}
      {/* ---- 编辑器抽屉 ---- */}
      {editor && (
        <Dialog className="editor-mask" panelClassName="editor" title={`编辑 ${editor.profile.name}`}
          onClose={() => setEditor(null)} dismissible={!editorSaving}>
            <div className="ehead">
              <Icon name="edit" size={14} />
              编辑 {editor.profile.name}
              <span className="chip">YAML</span>
              <span className="spacer" />
              <button type="button" className="icon-btn" aria-label="关闭" onClick={() => setEditor(null)} disabled={editorSaving}>
                <Icon name="x" />
              </button>
            </div>
            <CodeEditor
              label={`配置内容：${editor.profile.name}`}
              value={editor.content}
              readOnly={editorSaving}
              onChange={(content) => setEditor({ ...editor, content })}
              lang="yaml"
            />
            {dialogError && <div className="editor-error" role="alert">{dialogError}</div>}
            <div className="efoot">
              <Button onClick={() => setEditor(null)} disabled={editorSaving}>取消</Button>
              <Button variant="primary" onClick={() => void saveEditor()} disabled={editorSaving}>
                <Icon name="check" size={13} />{editorSaving ? '保存中…' : '保存'}
              </Button>
            </div>
        </Dialog>
      )}
      {runtimeViewer && (
        <Dialog className="editor-mask" panelClassName="editor runtime-editor" title="当前运行配置"
          onClose={() => setRuntimeViewer(null)}>
            <div className="ehead">
              <Icon name="settings" size={14} />
              当前运行配置
              <span className="chip">YAML</span>
              <span className="spacer" />
              {!runtimeViewer.loading && !runtimeViewer.error && (
                <>
                  <Button size="sm" onClick={() => void copyRuntimeConfig()}>
                    <Icon name="download" size={13} />复制
                  </Button>
                  <Button size="sm" onClick={() => void loadRuntimeConfig()}>
                    <Icon name="refresh" size={13} />刷新
                  </Button>
                </>
              )}
              <button type="button" className="icon-btn" aria-label="关闭" onClick={() => setRuntimeViewer(null)}>
                <Icon name="x" />
              </button>
            </div>
            {runtimeViewer.loading && (
              <div className="runtime-status">
                <Icon name="refresh" size={24} />
                <span>加载中…</span>
              </div>
            )}
            {runtimeViewer.error && (
              <div className="runtime-status error" role="alert">
                <Icon name="x" size={24} />
                <span>{runtimeViewer.error}</span>
                <Button size="sm" onClick={() => void loadRuntimeConfig()}>
                  重试
                </Button>
              </div>
            )}
            {!runtimeViewer.loading && !runtimeViewer.error && (
              <CodeEditor label="当前运行配置内容" value={runtimeViewer.content} onChange={() => {}} lang="yaml" readOnly />
            )}
        </Dialog>
      )}
      {profileMenu && (
        <ProfileMenu state={profileMenu} onClose={() => setProfileMenu(null)} onAction={(action, profile) => {
          setProfileMenu(null)
          switch (action) {
            case 'select': void doSelect(profile); break
            case 'update': void doUpdate(profile); break
            case 'meta': openMetaEditor(profile); break
            case 'edit': void openEditor(profile); break
            case 'rule': void openRuleEditor(profile); break
            case 'merge': void openEnhEditor(null, 'merge', profile); break
            case 'script': void openEnhEditor(null, 'script', profile); break
            case 'delete': setConfirmDel(profile); break
          }
        }} />
      )}
      {metaEditor && (
        <Dialog className="editor-mask" panelClassName="meta-dialog" title="编辑订阅信息"
          onClose={() => setMetaEditor(null)} dismissible={!metaSaving}>
            <div className="ehead">
              <Icon name="settings" size={14} />
              编辑订阅信息
              <span className="chip">{metaEditor.profile.kind === 'remote' ? '远程' : '本地'}</span>
              <span className="spacer" />
              <button type="button" className="icon-btn" aria-label="关闭" onClick={() => setMetaEditor(null)} disabled={metaSaving}>
                <Icon name="x" />
              </button>
            </div>
            <div className="meta-form">
              <label>
                <span>订阅名称</span>
                <Input
                  value={metaEditor.name}
                  disabled={metaSaving}
                  placeholder="订阅名称"
                  onChange={(e) => setMetaEditor({ ...metaEditor, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveMetaEditor()
                  }}
                />
              </label>
              <label>
                <span>{metaEditor.profile.kind === 'remote' ? '订阅 URL' : '来源 / 路径'}</span>
                <Input
                  value={metaEditor.url}
                  disabled={metaSaving}
                  placeholder={metaEditor.profile.kind === 'remote' ? 'https://… 或 clash://…' : '配置来源'}
                  onChange={(e) => setMetaEditor({ ...metaEditor, url: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveMetaEditor()
                  }}
                />
              </label>
              <label>
                <span>自动更新间隔(分钟)</span>
                <Input
                  type="number"
                  disabled={metaSaving}
                  min={0}
                  step={1}
                  value={metaEditor.autoUpdateMin}
                  placeholder="0 表示关闭"
                  onChange={(e) => setMetaEditor({ ...metaEditor, autoUpdateMin: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveMetaEditor()
                  }}
                />
              </label>
            </div>
            {dialogError && <div className="editor-error" role="alert">{dialogError}</div>}
            <div className="efoot">
              <Button onClick={() => setMetaEditor(null)} disabled={metaSaving}>取消</Button>
              <Button variant="primary" onClick={() => void saveMetaEditor()} disabled={metaSaving}>
                <Icon name="check" size={13} />{metaSaving ? '保存中…' : '保存'}
              </Button>
            </div>
        </Dialog>
      )}
      {/* ---- 规则快捷添加 ---- */}
      {ruleEditor && (
        <Dialog className="editor-mask" panelClassName="rule-dialog" title="新建分流规则"
          onClose={() => setRuleEditor(null)} dismissible={!ruleSaving}>
            <div className="ehead">
              <Icon name="rules" size={14} />
              新建分流规则
              <span className="chip">{ruleEditor.profileName}</span>
              <span className="spacer" />
              <button type="button" className="icon-btn" aria-label="关闭" onClick={() => setRuleEditor(null)} disabled={ruleSaving}>
                <Icon name="x" />
              </button>
            </div>
            <div className="rule-form">
              <label>
                <span>规则类型</span>
                <select
                  value={ruleEditor.type}
                  disabled={ruleSaving}
                  onChange={(e) => setRuleEditor({ ...ruleEditor, type: e.target.value })}
                >
                  {RULE_TYPES.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>匹配内容</span>
                <Input
                  value={ruleEditor.value}
                  disabled={ruleSaving}
                  placeholder="example.com / 1.1.1.0/24 / Telegram.exe"
                  onChange={(e) => setRuleEditor({ ...ruleEditor, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveRuleEditor()
                  }}
                />
              </label>
              <label>
                <span>目标策略 / 节点</span>
                <select
                  value={ruleEditor.target}
                  disabled={ruleSaving}
                  onChange={(e) => setRuleEditor({ ...ruleEditor, target: e.target.value })}
                >
                  {ruleTargets.map((target) => (
                    <option key={target} value={target}>{target}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>插入位置</span>
                <select
                  value={ruleEditor.position}
                  disabled={ruleSaving}
                  onChange={(e) =>
                    setRuleEditor({ ...ruleEditor, position: e.target.value as RuleEditorState['position'] })
                  }
                >
                  <option value="prepend">规则最前，优先生效</option>
                  <option value="append">规则最后，兜底生效</option>
                </select>
              </label>
              {ruleTargetsError && <div className="rule-warning" role="status">{ruleTargetsError}</div>}
              <div className="rule-preview">
                {`${ruleEditor.type},${ruleEditor.value.trim() || '<匹配内容>'},${ruleEditor.target.trim() || '<目标>'}`}
              </div>
            </div>
            {dialogError && <div className="editor-error" role="alert">{dialogError}</div>}
            <div className="efoot">
              <Button onClick={() => setRuleEditor(null)} disabled={ruleSaving}>取消</Button>
              <Button variant="primary" onClick={() => void saveRuleEditor()} disabled={ruleSaving}>
                <Icon name="check" size={13} />{ruleSaving ? '保存中…' : '保存规则'}
              </Button>
            </div>
        </Dialog>
      )}
      {/* ---- 增强项编辑抽屉 ---- */}
      {enhEditor && (
        <Dialog className="editor-mask" panelClassName="editor" title="编辑增强项"
          onClose={() => setEnhEditor(null)} dismissible={!enhancerSaving}>
            <div className="ehead">
              <Icon name="edit" size={14} />
              <Input
                aria-label="增强项名称"
                className="enh-name"
                value={enhEditor.name}
                disabled={enhancerSaving}
                onChange={(e) => setEnhEditor({ ...enhEditor, name: e.target.value })}
                placeholder="处理器名称"
              />
              <span className="chip">{enhEditor.kind === 'merge' ? 'YAML' : 'JavaScript'}</span>
              <span className="spacer" />
              <button type="button" className="icon-btn" aria-label="关闭" onClick={() => setEnhEditor(null)} disabled={enhancerSaving}>
                <Icon name="x" />
              </button>
            </div>
            <CodeEditor
              label={`增强项内容：${enhEditor.name}`}
              value={enhEditor.content}
              readOnly={enhancerSaving}
              onChange={(content) => setEnhEditor({ ...enhEditor, content })}
              lang={enhEditor.kind === 'merge' ? 'yaml' : 'javascript'}
            />
            {dialogError && <div className="editor-error" role="alert">{dialogError}</div>}
            <div className="efoot">
              <Button onClick={() => setEnhEditor(null)} disabled={enhancerSaving}>取消</Button>
              <Button variant="primary" onClick={() => void saveEnhEditor()} disabled={enhancerSaving}>
                <Icon name="check" size={13} />{enhancerSaving ? '保存中…' : '保存'}
              </Button>
            </div>
        </Dialog>
      )}
    </div>
  )
}
