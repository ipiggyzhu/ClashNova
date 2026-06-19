import { useCallback, useEffect, useRef, useState } from 'react'
import './Profiles.css'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import CodeEditor from '../components/ui/CodeEditor'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import Toggle from '../components/ui/Toggle'
import { getProxies } from '../services/api'
import { call } from '../services/ipc'
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
}

/** 增强项编辑抽屉状态(enh 为 null 表示新建) */
interface EnhEditorState {
  pid: string
  enh: EnhancerMeta | null
  kind: EnhancerMeta['kind']
  name: string
  content: string
}

interface RuleEditorState {
  profileId: string
  profileName: string
  type: string
  value: string
  target: string
  position: 'prepend' | 'append'
}

interface ProfileMenuState {
  x: number
  y: number
  profile: ProfileMeta
}

const RULE_TYPES = [
  { value: 'DOMAIN-SUFFIX', label: '域名后缀' },
  { value: 'DOMAIN', label: '完整域名' },
  { value: 'DOMAIN-KEYWORD', label: '域名关键词' },
  { value: 'IP-CIDR', label: 'IP 段' },
  { value: 'PROCESS-NAME', label: '进程名' },
  { value: 'GEOIP', label: '国家/地区' },
]

const BASE_TARGETS = ['DIRECT', 'REJECT', 'GLOBAL']
const BUILTIN_ENHANCER_PREFIX = 'builtin-'

export default function Profiles() {
  const [profiles, setProfiles] = useState<ProfileMeta[]>([])
  const [url, setUrl] = useState('')
  const [newProfile, setNewProfile] = useState<{ name: string; content: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [fileImporting, setFileImporting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [confirmDel, setConfirmDel] = useState<ProfileMeta | null>(null)
  const [enhEditor, setEnhEditor] = useState<EnhEditorState | null>(null)
  const [ruleEditor, setRuleEditor] = useState<RuleEditorState | null>(null)
  const [ruleSaving, setRuleSaving] = useState(false)
  const [ruleTargets, setRuleTargets] = useState<string[]>(BASE_TARGETS)
  const [profileMenu, setProfileMenu] = useState<ProfileMenuState | null>(null)
  const [confirmDelEnh, setConfirmDelEnh] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const notify = useNotificationStore((s) => s.add)

  const refresh = useCallback(async () => {
    setProfiles(await call('list_profiles'))
  }, [])

  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  useEffect(() => {
    if (!profileMenu) return
    const close = (): void => setProfileMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [profileMenu])

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

  const doImportFile = async (file: File): Promise<void> => {
    setFileImporting(true)
    try {
      const content = await file.text()
      await call('import_profile_file', { name: file.name, content })
      await refresh()
      notify('success', '导入成功', file.name)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      notify('error', '打开文件失败', message)
    } finally {
      setFileImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const openNewProfile = (): void => {
    setNewProfile({
      name: `Local Profile ${new Date().toLocaleDateString().replaceAll('/', '-')}.yaml`,
      content: NEW_PROFILE_TEMPLATE,
    })
  }

  const saveNewProfile = async (): Promise<void> => {
    if (!newProfile) return
    const name = newProfile.name.trim() || 'Local Profile.yaml'
    await call('import_profile_file', { name, content: newProfile.content })
    setNewProfile(null)
    await refresh()
    notify('success', '已新建本地配置', name)
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

  const openEnhEditor = async (
    enh: EnhancerMeta | null,
    kind: EnhancerMeta['kind'],
    profile = currentProfile,
  ): Promise<void> => {
    if (!profile) return
    const content = enh
      ? await call('read_enhancer', { profileId: profile.id, enhancerId: enh.id })
      : ENH_TEMPLATES[kind]
    setEnhEditor({
      pid: profile.id,
      enh,
      kind: enh?.kind ?? kind,
      name: enh?.name ?? (kind === 'merge' ? '新 Merge 处理器' : '新 Script 处理器'),
      content,
    })
  }

  const openRuleEditor = async (profile = currentProfile): Promise<void> => {
    if (!profile) return
    setRuleEditor({
      profileId: profile.id,
      profileName: profile.name,
      type: 'DOMAIN-SUFFIX',
      value: '',
      target: 'DIRECT',
      position: 'prepend',
    })
    try {
      const payload = await getProxies()
      const names = Object.keys(payload.proxies)
        .filter((name) => !BASE_TARGETS.includes(name))
        .sort((a, b) => a.localeCompare(b))
      setRuleTargets([...BASE_TARGETS, ...names])
    } catch {
      setRuleTargets(BASE_TARGETS)
    }
  }

  const saveRuleEditor = async (): Promise<void> => {
    if (!ruleEditor) return
    const value = ruleEditor.value.trim()
    const target = ruleEditor.target.trim()
    if (!value || !target) {
      notify('warning', '规则未保存', '请填写匹配内容和目标策略')
      return
    }
    const rule = `${ruleEditor.type},${value},${target}`
    const content = `${ruleEditor.position}-rules:\n  - ${JSON.stringify(rule)}\n`
    setRuleSaving(true)
    try {
      await call('save_enhancer', {
        profileId: ruleEditor.profileId,
        enhancerId: null,
        kind: 'merge',
        name: `规则：${value} → ${target}`,
        content,
      })
      setRuleEditor(null)
      await refresh()
      notify('success', '规则已添加', rule)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      notify('error', '添加规则失败', message)
    } finally {
      setRuleSaving(false)
    }
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
            {e.id.startsWith(BUILTIN_ENHANCER_PREFIX) && <span className="chip builtin">内置</span>}
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

      {newProfile && (
        <div className="editor-mask" onClick={() => setNewProfile(null)}>
          <div className="editor new-profile-editor" onClick={(e) => e.stopPropagation()}>
            <div className="ehead">
              <Icon name="plus" size={14} />
              新建本地配置
              <Input
                className="enh-name"
                value={newProfile.name}
                onChange={(e) => setNewProfile({ ...newProfile, name: e.target.value })}
                placeholder="Local Profile.yaml"
              />
              <span className="chip">YAML</span>
              <span className="spacer" />
              <button className="icon-btn" onClick={() => setNewProfile(null)}>
                <Icon name="x" />
              </button>
            </div>
            <div className="new-profile-hint">
              默认模板会直连所有流量。可以先创建，再通过编辑规则或扩展覆写配置逐步添加代理节点和分流规则。
            </div>
            <CodeEditor
              value={newProfile.content}
              onChange={(content) => setNewProfile({ ...newProfile, content })}
              lang="yaml"
            />
            <div className="efoot">
              <Button onClick={() => setNewProfile(null)}>取消</Button>
              <Button variant="primary" onClick={() => void saveNewProfile()}>
                <Icon name="check" size={13} />创建
              </Button>
            </div>
          </div>
        </div>
      )}
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
      {profileMenu && (
        <div
          className="profile-menu"
          style={{ left: profileMenu.x, top: profileMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            disabled={profileMenu.profile.current}
            onClick={() => {
              const p = profileMenu.profile
              setProfileMenu(null)
              void doSelect(p)
            }}
          >
            <Icon name="check" size={13} />设为当前订阅
          </button>
          {profileMenu.profile.kind === 'remote' && (
            <button
              onClick={() => {
                const p = profileMenu.profile
                setProfileMenu(null)
                void doUpdate(p)
              }}
            >
              <Icon name="refresh" size={13} />更新订阅
            </button>
          )}
          <button
            onClick={() => {
              const p = profileMenu.profile
              setProfileMenu(null)
              void openEditor(p)
            }}
          >
            <Icon name="edit" size={13} />编辑文件
          </button>
          <div className="sep" />
          <button
            onClick={() => {
              const p = profileMenu.profile
              setProfileMenu(null)
              void openRuleEditor(p)
            }}
          >
            <Icon name="rules" size={13} />添加分流规则
          </button>
          <button
            onClick={() => {
              const p = profileMenu.profile
              setProfileMenu(null)
              void openEnhEditor(null, 'merge', p)
            }}
          >
            <Icon name="profiles" size={13} />新建 Merge 覆写
          </button>
          <button
            onClick={() => {
              const p = profileMenu.profile
              setProfileMenu(null)
              void openEnhEditor(null, 'script', p)
            }}
          >
            <Icon name="zap" size={13} />新建 Script 脚本
          </button>
          <div className="sep" />
          <button
            className="danger"
            onClick={() => {
              setConfirmDel(profileMenu.profile)
              setProfileMenu(null)
            }}
          >
            <Icon name="trash" size={13} />删除
          </button>
        </div>
      )}
      {/* ---- 规则快捷添加 ---- */}
      {ruleEditor && (
        <div className="editor-mask" onClick={() => setRuleEditor(null)}>
          <div className="rule-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="ehead">
              <Icon name="rules" size={14} />
              新建分流规则
              <span className="chip">{ruleEditor.profileName}</span>
              <span className="spacer" />
              <button className="icon-btn" onClick={() => setRuleEditor(null)}>
                <Icon name="x" />
              </button>
            </div>
            <div className="rule-form">
              <label>
                <span>规则类型</span>
                <select
                  value={ruleEditor.type}
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
                  placeholder="example.com / 1.1.1.0/24 / Telegram.exe"
                  onChange={(e) => setRuleEditor({ ...ruleEditor, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveRuleEditor()
                  }}
                />
              </label>
              <label>
                <span>目标策略 / 节点</span>
                <Input
                  list="profile-rule-targets"
                  value={ruleEditor.target}
                  placeholder="DIRECT / REJECT / 节点名"
                  onChange={(e) => setRuleEditor({ ...ruleEditor, target: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveRuleEditor()
                  }}
                />
                <datalist id="profile-rule-targets">
                  {ruleTargets.map((target) => (
                    <option key={target} value={target} />
                  ))}
                </datalist>
              </label>
              <label>
                <span>插入位置</span>
                <select
                  value={ruleEditor.position}
                  onChange={(e) =>
                    setRuleEditor({ ...ruleEditor, position: e.target.value as RuleEditorState['position'] })
                  }
                >
                  <option value="prepend">规则最前，优先生效</option>
                  <option value="append">规则最后，兜底生效</option>
                </select>
              </label>
              <div className="rule-preview">
                {`${ruleEditor.type},${ruleEditor.value.trim() || '<匹配内容>'},${ruleEditor.target.trim() || '<目标>'}`}
              </div>
            </div>
            <div className="efoot">
              <Button onClick={() => setRuleEditor(null)}>取消</Button>
              <Button variant="primary" onClick={() => void saveRuleEditor()} disabled={ruleSaving}>
                <Icon name="check" size={13} />{ruleSaving ? '保存中…' : '保存规则'}
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
