import { useId, useRef, useState } from 'react'
import './DnsSettings.css'
import Button from './ui/Button'
import Dialog from './ui/Dialog'
import Icon from './ui/Icon'
import Input from './ui/Input'
import Seg from './ui/Seg'
import Toggle from './ui/Toggle'
import { useT } from '../i18n'
import { useAppStore } from '../stores/app'
import { useNotificationStore } from '../stores/notifications'
import type { AppSettings, DnsEnhancedMode, FakeIpFilterMode } from '../types/clash'
import { buildDnsFormOverride, EMPTY_DNS_FORM, normalizeForCompare, parseDnsForm } from '../utils/dnsOverride'
import type { DnsOverrideForm } from '../utils/dnsOverride'

interface RowProps {
  title: string
  desc?: string
  children: React.ReactNode
}

function Row({ title, desc, children }: RowProps) {
  return (
    <div className="dns-row">
      <div className="dns-info">
        <h4>{title}</h4>
        {desc && <p>{desc}</p>}
      </div>
      <div className="dns-ctrl">{children}</div>
    </div>
  )
}

interface DnsSettingsProps {
  onClose: () => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface TextAreaProps {
  label: string
  desc: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
  disabled?: boolean
}

function TextArea({ label, desc, value, onChange, placeholder, rows = 3, disabled }: TextAreaProps) {
  const id = useId()
  return (
    <div className="dns-field">
      <label htmlFor={id}>{label}</label>
      <p id={`${id}-desc`}>{desc}</p>
      <textarea id={id} aria-describedby={`${id}-desc`} rows={rows} value={value}
        placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

export default function DnsSettings({ onClose }: DnsSettingsProps) {
  const t = useT()
  const settings = useAppStore((s) => s.settings)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const notify = useNotificationStore((s) => s.add)

  const [draft, setDraft] = useState<Partial<Record<keyof AppSettings, string>>>({})
  const [form, setForm] = useState<DnsOverrideForm>(() => parseDnsForm(settings.dnsOverride ?? ''))
  const [formDirty, setFormDirty] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const savingRef = useRef(false)
  const draftRef = useRef(draft)
  const pending = useRef(new Set<Promise<boolean>>())

  const editDraft = (key: keyof AppSettings, value: string | undefined): void => {
    draftRef.current = { ...draftRef.current, [key]: value }
    setDraft(draftRef.current)
  }

  const patch = (p: Partial<AppSettings>): Promise<boolean> => {
    const operation = patchSettings(p).then(() => {
      setValidationError(null)
      return true
    }).catch((err: unknown) => {
      setValidationError(`${t('保存 DNS 设置失败')}：${errorMessage(err)}`)
      notify('error', t('保存 DNS 设置失败'), errorMessage(err))
      return false
    })
    pending.current.add(operation)
    setPendingCount(pending.current.size)
    void operation.then(() => {
      pending.current.delete(operation)
      setPendingCount(pending.current.size)
    })
    return operation
  }

  const draftValue = (key: keyof AppSettings, fallback: string): string =>
    (draft[key] as string | undefined) ?? fallback

  const commitText = async (key: 'dnsListen' | 'fakeIpRange'): Promise<boolean> => {
    const raw = draftRef.current[key]
    if (raw === undefined) return true
    const trimmed = raw.trim()

    if (!trimmed) {
      setValidationError(t('DNS 监听地址和 Fake IP 范围不能为空'))
      return false
    }

    // 验证 DNS 监听地址格式: host:port
    if (key === 'dnsListen') {
      const match = trimmed.match(/^(.+):(\d+)$/)
      if (!match) {
        setValidationError(t('DNS 监听地址格式错误，应为 host:port'))
        return false
      }
      const port = parseInt(match[2], 10)
      if (port < 1 || port > 65535) {
        setValidationError(t('端口范围应为 1-65535'))
        return false
      }
    }

    // 验证 Fake IP 范围格式: CIDR
    if (key === 'fakeIpRange') {
      const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/
      if (!cidrRegex.test(trimmed)) {
        setValidationError(t('Fake IP 范围格式错误，应为 CIDR 格式（如 198.18.0.1/16）'))
        return false
      }
      // 验证每个八位组范围
      const parts = trimmed.split('/')
      const octets = parts[0].split('.').map(Number)
      if (octets.some((n) => n > 255)) {
        setValidationError(t('IP 地址段应为 0-255'))
        return false
      }
      const prefix = parseInt(parts[1], 10)
      if (prefix < 1 || prefix > 32) {
        setValidationError(t('CIDR 前缀应为 1-32'))
        return false
      }
    }

    setValidationError(null)
    editDraft(key, undefined)
    const saved = await patch({ [key]: trimmed })
    if (!saved && draftRef.current[key] === undefined) editDraft(key, raw)
    return saved
  }

  const resetDefaults = (): void => {
    setForm(EMPTY_DNS_FORM)
    setFormDirty(true)
    editDraft('dnsListen', undefined)
    editDraft('fakeIpRange', undefined)
    void patch({
      enableDns: true,
      dnsListen: '127.0.0.1:5335',
      dnsEnhancedMode: 'fake-ip',
      fakeIpRange: '198.18.0.1/16',
      fakeIpFilterMode: 'blacklist',
      ipv6Dns: false,
      preferH3: false,
      respectRules: false,
      useHosts: false,
      useSystemHosts: false,
    })
  }

  const saveDnsOverride = async (): Promise<void> => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      if (!await commitText('dnsListen') || !await commitText('fakeIpRange')) return
      if ((await Promise.all([...pending.current])).some((saved) => !saved)) return
      const latestSettings = useAppStore.getState().settings
      const current = latestSettings.dnsOverride ?? ''
      const next = formDirty ? buildDnsFormOverride(latestSettings, form, current) : current
      if (normalizeForCompare(next) !== normalizeForCompare(current)) {
        await patchSettings({ dnsOverride: next })
      }
      onClose()
    } catch (err) {
      setValidationError(`${t('保存 DNS 覆写失败')}：${errorMessage(err)}`)
      notify('error', t('保存 DNS 覆写失败'), errorMessage(err))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const updateForm = (key: keyof DnsOverrideForm, value: string): void => {
    setFormDirty(true)
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <Dialog className="dns-mask" panelClassName="dns-drawer" title={t('DNS 覆写')}
      onClose={onClose} dismissible={!saving && pendingCount === 0}>
        <div className="dns-head">
          <Icon name="zap" size={16} />
          <span>{t('DNS 覆写')}</span>
          <span className="spacer" />
          <Button size="sm" onClick={resetDefaults} disabled={saving || pendingCount > 0}>
            <Icon name="refresh" size={13} />
            {t('重置为默认值')}
          </Button>
          <button type="button" className="icon-btn" aria-label={t('关闭')} onClick={onClose} disabled={saving || pendingCount > 0}>
            <Icon name="x" />
          </button>
        </div>

        <div className="dns-body">
          {validationError && (
            <div className="dns-error" role="alert">
              <Icon name="x" size={14} />
              <span>{validationError}</span>
            </div>
          )}

          <Row title={t('启用 DNS')}>
            <Toggle label={t('启用 DNS')} on={settings.enableDns} onChange={(on) => void patch({ enableDns: on })} disabled={saving} />
          </Row>

          <Row title={t('DNS 监听地址')}>
            <Input
              aria-label={t('DNS 监听地址')}
              style={{ width: 180 }}
              value={draftValue('dnsListen', settings.dnsListen)}
              onChange={(e) => editDraft('dnsListen', e.target.value)}
              onBlur={() => void commitText('dnsListen')}
              disabled={saving || !settings.enableDns}
            />
          </Row>

          <Row title={t('增强模式')}>
            <Seg<DnsEnhancedMode | ''>
              label={t('增强模式')}
              disabled={saving || !settings.enableDns}
              items={[
                { value: '', label: t('关闭') },
                { value: 'fake-ip', label: 'Fake IP' },
                { value: 'redir-host', label: 'Redir Host' },
              ]}
              value={settings.dnsEnhancedMode}
              onChange={(v) => patch({ dnsEnhancedMode: v })}
            />
          </Row>

          {settings.dnsEnhancedMode === 'fake-ip' && (
            <>
              <Row title={t('Fake IP 范围')}>
                <Input
                  aria-label={t('Fake IP 范围')}
                  style={{ width: 180 }}
                  value={draftValue('fakeIpRange', settings.fakeIpRange)}
                  onChange={(e) => editDraft('fakeIpRange', e.target.value)}
                  onBlur={() => void commitText('fakeIpRange')}
                  disabled={saving || !settings.enableDns}
                />
              </Row>

              <Row title={t('Fake IP 过滤模式')}>
                <Seg<FakeIpFilterMode>
                  label={t('Fake IP 过滤模式')}
                  disabled={saving || !settings.enableDns}
                  items={[
                    { value: 'blacklist', label: t('黑名单') },
                    { value: 'whitelist', label: t('白名单') },
                  ]}
                  value={settings.fakeIpFilterMode}
                  onChange={(v) => patch({ fakeIpFilterMode: v })}
                />
              </Row>
            </>
          )}

          <Row title="IPv6" desc={t('启用 IPv6 DNS 解析')}>
            <Toggle
              label="IPv6 DNS"
              on={settings.ipv6Dns}
              onChange={(on) => patch({ ipv6Dns: on })}
              disabled={saving || !settings.enableDns}
            />
          </Row>

          <Row title={t('优先使用 HTTP/3')} desc={t('DNS DOH 使用 HTTP/3 协议')}>
            <Toggle
              label={t('优先使用 HTTP/3')}
              on={settings.preferH3}
              onChange={(on) => patch({ preferH3: on })}
              disabled={saving || !settings.enableDns}
            />
          </Row>

          <Row title={t('遵循路由规则')} desc={t('DNS 连接遵循路由规则')}>
            <Toggle
              label={t('遵循路由规则')}
              on={settings.respectRules}
              onChange={(on) => patch({ respectRules: on })}
              disabled={saving || !settings.enableDns}
            />
          </Row>

          <Row title={t('使用 Hosts')} desc={t('启用通过 hosts 文件解析域名')}>
            <Toggle
              label={t('使用 Hosts')}
              on={settings.useHosts}
              onChange={(on) => patch({ useHosts: on })}
              disabled={saving || !settings.enableDns}
            />
          </Row>

          <Row title={t('使用系统 Hosts')} desc={t('启用通过操作系统 hosts 文件解析')}>
            <Toggle
              label={t('使用系统 Hosts')}
              on={settings.useSystemHosts}
              onChange={(on) => patch({ useSystemHosts: on })}
              disabled={saving || !settings.enableDns}
            />
          </Row>

          <div className="dns-section-title">服务器列表</div>
          <TextArea
            label="域名服务器"
            desc="DNS 服务器列表，用逗号或换行分隔"
            value={form.nameserver}
            onChange={(value) => updateForm('nameserver', value)}
            disabled={saving}
            placeholder={'https://dns.alidns.com/dns-query\nhttps://doh.pub/dns-query\n223.5.5.5'}
          />
          <TextArea
            label="回退服务器"
            desc="回退 DNS 服务器列表，用逗号或换行分隔"
            value={form.fallback}
            onChange={(value) => updateForm('fallback', value)}
            disabled={saving}
            placeholder={'https://1.1.1.1/dns-query\ntls://8.8.4.4:853'}
          />
          <TextArea
            label="代理节点 DNS"
            desc="仅用于解析代理节点域名，用逗号或换行分隔"
            value={form.proxyServerNameserver}
            onChange={(value) => updateForm('proxyServerNameserver', value)}
            disabled={saving}
            placeholder={'https://dns.alidns.com/dns-query\n119.29.29.29'}
          />
          <TextArea
            label="直连域名服务器"
            desc="直连出口域名解析服务器，支持 system 关键字"
            value={form.directNameserver}
            onChange={(value) => updateForm('directNameserver', value)}
            disabled={saving}
            placeholder={'system\n223.5.5.5\nhttps://doh.pub/dns-query'}
          />
          <TextArea
            label="Fake IP 过滤"
            desc="跳过 Fake IP 解析的域名，用逗号或换行分隔"
            value={form.fakeIpFilter}
            onChange={(value) => updateForm('fakeIpFilter', value)}
            disabled={saving}
            placeholder={'geosite:private\ngeosite:cn\n+.lan\n+.local'}
            rows={4}
          />
          <TextArea
            label="域名服务器策略"
            desc="格式：geosite:cn=server1;server2，每行一条"
            value={form.nameserverPolicy}
            onChange={(value) => updateForm('nameserverPolicy', value)}
            disabled={saving}
            placeholder={'geosite:cn=https://doh.pub/dns-query;https://dns.alidns.com/dns-query\n+.google.com=https://dns.google/dns-query'}
            rows={4}
          />
        </div>

        <div className="dns-foot">
          <Button onClick={onClose} disabled={saving || pendingCount > 0}>
            {t('取消')}
          </Button>
          <Button variant="primary" onClick={() => void saveDnsOverride()} disabled={saving || pendingCount > 0}>
            <Icon name="check" size={13} />
            {saving ? t('保存中…') : t('保存')}
          </Button>
        </div>
    </Dialog>
  )
}
