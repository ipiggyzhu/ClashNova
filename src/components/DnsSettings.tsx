import { useState } from 'react'
import './DnsSettings.css'
import Button from './ui/Button'
import Icon from './ui/Icon'
import Input from './ui/Input'
import Seg from './ui/Seg'
import Toggle from './ui/Toggle'
import { useT } from '../i18n'
import { useAppStore } from '../stores/app'
import { useNotificationStore } from '../stores/notifications'
import type { AppSettings, DnsEnhancedMode, FakeIpFilterMode } from '../types/clash'

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

interface DnsOverrideForm {
  nameserver: string
  fallback: string
  proxyServerNameserver: string
  directNameserver: string
  fakeIpFilter: string
  nameserverPolicy: string
}

const EMPTY_DNS_FORM: DnsOverrideForm = {
  nameserver: '',
  fallback: '',
  proxyServerNameserver: '',
  directNameserver: '',
  fakeIpFilter: '',
  nameserverPolicy: '',
}

const DNS_FORM_MANAGED_KEYS = new Set([
  'enable',
  'listen',
  'enhanced-mode',
  'fake-ip-range',
  'fake-ip-filter-mode',
  'ipv6',
  'prefer-h3',
  'respect-rules',
  'use-hosts',
  'use-system-hosts',
  'nameserver',
  'fallback',
  'proxy-server-nameserver',
  'direct-nameserver',
  'fake-ip-filter',
  'nameserver-policy',
])

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

function normalizeDnsRoot(raw: string): string {
  const lines = raw.split(/\r?\n/)
  const dnsStart = lines.findIndex((line) => /^dns\s*:\s*(?:#.*)?$/.test(line))
  if (dnsStart === -1) return raw
  const out: string[] = []
  for (let i = dnsStart + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) {
      if (out.length) out.push('')
      continue
    }
    if (/^\s+/.test(line)) {
      out.push(line.replace(/^\s{2}/, ''))
      continue
    }
    break
  }
  return out.join('\n')
}

function stripYamlValue(value: string): string {
  const trimmed = value.trim().replace(/\s+#.*$/, '')
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function findYamlKeyDelimiter(line: string): number {
  let quote: '"' | "'" | '' = ''
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quote) {
      if (char === quote && line[i - 1] !== '\\') quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ':' && (i === line.length - 1 || /\s/.test(line[i + 1]))) return i
  }
  return -1
}

function parseYamlMapEntry(line: string): { key: string; value: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('- ')) return null
  const delimiter = findYamlKeyDelimiter(trimmed)
  if (delimiter <= 0) return null
  return {
    key: stripYamlValue(trimmed.slice(0, delimiter)),
    value: trimmed.slice(delimiter + 1).trim(),
  }
}

function extractYamlList(raw: string, key: string): string {
  const lines = normalizeDnsRoot(raw).split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line))
  if (start === -1) return ''
  const inline = lines[start].replace(new RegExp(`^${key}\\s*:\\s*`), '').trim()
  if (inline && inline !== '[]') {
    if (inline.startsWith('[') && inline.endsWith(']')) {
      return inline.slice(1, -1).split(',').map(stripYamlValue).filter(Boolean).join(', ')
    }
    return inline.split(',').map(stripYamlValue).filter(Boolean).join(', ')
  }
  const items: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!/^\s+/.test(line)) break
    const match = line.match(/^\s*-\s*(.+)$/)
    if (match) items.push(stripYamlValue(match[1]))
  }
  return items.join(', ')
}

function extractNameserverPolicy(raw: string): string {
  const lines = normalizeDnsRoot(raw).split(/\r?\n/)
  const start = lines.findIndex((line) => /^nameserver-policy\s*:/.test(line))
  if (start === -1) return ''
  const entries: string[] = []
  let currentKey = ''
  let currentServers: string[] = []
  const flush = (): void => {
    if (currentKey && currentServers.length) entries.push(`${currentKey}=${currentServers.join(';')}`)
    currentKey = ''
    currentServers = []
  }

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!/^\s+/.test(line)) break
    const entry = parseYamlMapEntry(line)
    if (entry) {
      flush()
      currentKey = entry.key
      const inline = entry.value
      if (inline) currentServers = inline.split(/[;,]/).map(stripYamlValue).filter(Boolean)
      continue
    }
    const itemMatch = line.match(/^\s*-\s*(.+)$/)
    if (itemMatch) currentServers.push(stripYamlValue(itemMatch[1]))
  }
  flush()
  return entries.join('\n')
}

function parseDnsForm(raw: string): DnsOverrideForm {
  return {
    nameserver: extractYamlList(raw, 'nameserver'),
    fallback: extractYamlList(raw, 'fallback'),
    proxyServerNameserver: extractYamlList(raw, 'proxy-server-nameserver'),
    directNameserver: extractYamlList(raw, 'direct-nameserver'),
    fakeIpFilter: extractYamlList(raw, 'fake-ip-filter'),
    nameserverPolicy: extractNameserverPolicy(raw),
  }
}

function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function appendList(lines: string[], key: string, value: string): void {
  const items = splitList(value)
  if (!items.length) return
  lines.push(`${key}:`)
  for (const item of items) lines.push(`  - ${JSON.stringify(item)}`)
}

function appendPolicy(lines: string[], value: string): void {
  const entries = value
    .split(/\n|,\s*(?=[^=]+=)/)
    .map((item) => item.trim())
    .filter(Boolean)
  if (!entries.length) return
  lines.push('nameserver-policy:')
  for (const entry of entries) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const key = entry.slice(0, eq).trim()
    const servers = entry.slice(eq + 1).split(';').map((item) => item.trim()).filter(Boolean)
    if (!key || !servers.length) continue
    lines.push(`  ${JSON.stringify(key)}:`)
    for (const server of servers) lines.push(`    - ${JSON.stringify(server)}`)
  }
}

function preserveUnmanagedDnsYaml(raw: string): string[] {
  const lines = normalizeDnsRoot(raw).split(/\r?\n/)
  const kept: string[] = []
  let skippingManagedBlock = false

  for (const line of lines) {
    if (!line.trim()) {
      if (!skippingManagedBlock && kept.length) kept.push('')
      continue
    }

    const topLevel = /^\S/.test(line)
    if (topLevel) {
      const entry = parseYamlMapEntry(line)
      skippingManagedBlock = Boolean(entry && DNS_FORM_MANAGED_KEYS.has(entry.key))
      if (!skippingManagedBlock) kept.push(line)
      continue
    }

    if (!skippingManagedBlock) kept.push(line)
  }

  while (kept.length && !kept[0].trim()) kept.shift()
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop()
  return kept
}

function normalizeForCompare(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

function buildDnsOverride(settings: AppSettings, form: DnsOverrideForm, current: string): string {
  const lines = [
    `enable: ${settings.enableDns ? 'true' : 'false'}`,
    `listen: ${JSON.stringify(settings.dnsListen)}`,
    `ipv6: ${settings.ipv6Dns ? 'true' : 'false'}`,
    `prefer-h3: ${settings.preferH3 ? 'true' : 'false'}`,
    `respect-rules: ${settings.respectRules ? 'true' : 'false'}`,
    `use-hosts: ${settings.useHosts ? 'true' : 'false'}`,
    `use-system-hosts: ${settings.useSystemHosts ? 'true' : 'false'}`,
  ]
  if (settings.dnsEnhancedMode) lines.push(`enhanced-mode: ${settings.dnsEnhancedMode}`)
  if (settings.dnsEnhancedMode === 'fake-ip') {
    lines.push(`fake-ip-range: ${JSON.stringify(settings.fakeIpRange)}`)
    lines.push(`fake-ip-filter-mode: ${settings.fakeIpFilterMode}`)
  }
  appendList(lines, 'nameserver', form.nameserver)
  appendList(lines, 'fallback', form.fallback)
  appendList(lines, 'proxy-server-nameserver', form.proxyServerNameserver)
  appendList(lines, 'direct-nameserver', form.directNameserver)
  appendList(lines, 'fake-ip-filter', form.fakeIpFilter)
  appendPolicy(lines, form.nameserverPolicy)
  const preserved = preserveUnmanagedDnsYaml(current)
  if (preserved.length) lines.push('', ...preserved)
  return `${lines.join('\n')}\n`
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

  const patch = (p: Partial<AppSettings>): void => {
    void patchSettings(p)
      .then(() => setValidationError(null))
      .catch((err) => setValidationError(`${t('保存 DNS 设置失败')}：${errorMessage(err)}`))
  }

  const draftValue = (key: keyof AppSettings, fallback: string): string =>
    (draft[key] as string | undefined) ?? fallback

  const commitText = (key: 'dnsListen' | 'fakeIpRange'): void => {
    const raw = draft[key]
    if (raw === undefined) return
    const trimmed = raw.trim()

    if (!trimmed) {
      setDraft((d) => ({ ...d, [key]: undefined }))
      return
    }

    // 验证 DNS 监听地址格式: host:port
    if (key === 'dnsListen') {
      const match = trimmed.match(/^(.+):(\d+)$/)
      if (!match) {
        setValidationError(t('DNS 监听地址格式错误，应为 host:port'))
        return
      }
      const port = parseInt(match[2], 10)
      if (port < 1 || port > 65535) {
        setValidationError(t('端口范围应为 1-65535'))
        return
      }
    }

    // 验证 Fake IP 范围格式: CIDR
    if (key === 'fakeIpRange') {
      const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/
      if (!cidrRegex.test(trimmed)) {
        setValidationError(t('Fake IP 范围格式错误，应为 CIDR 格式（如 198.18.0.1/16）'))
        return
      }
      // 验证每个八位组范围
      const parts = trimmed.split('/')
      const octets = parts[0].split('.').map(Number)
      if (octets.some((n) => n > 255)) {
        setValidationError(t('IP 地址段应为 0-255'))
        return
      }
      const prefix = parseInt(parts[1], 10)
      if (prefix < 1 || prefix > 32) {
        setValidationError(t('CIDR 前缀应为 1-32'))
        return
      }
    }

    setValidationError(null)
    patch({ [key]: trimmed })
    setDraft((d) => ({ ...d, [key]: undefined }))
  }

  const resetDefaults = (): void => {
    setForm(EMPTY_DNS_FORM)
    setFormDirty(true)
    patch({
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

  const saveDnsOverride = (): void => {
    if (!formDirty) {
      onClose()
      return
    }

    const current = settings.dnsOverride ?? ''
    const next = buildDnsOverride(settings, form, current)
    if (normalizeForCompare(next) === normalizeForCompare(current)) {
      onClose()
      return
    }

    onClose()
    void patchSettings({ dnsOverride: next }).catch((err) => {
      notify('error', t('保存 DNS 覆写失败'), errorMessage(err))
    })
  }

  const updateForm = (key: keyof DnsOverrideForm, value: string): void => {
    setFormDirty(true)
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const TextArea = ({
    label,
    desc,
    field,
    placeholder,
    rows = 3,
  }: {
    label: string
    desc: string
    field: keyof DnsOverrideForm
    placeholder?: string
    rows?: number
  }) => (
    <div className="dns-field">
      <label>{label}</label>
      <p>{desc}</p>
      <textarea
        rows={rows}
        value={form[field]}
        placeholder={placeholder}
        onChange={(e) => updateForm(field, e.target.value)}
      />
    </div>
  )

  return (
    <div className="dns-mask" onClick={onClose}>
      <div className="dns-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="dns-head">
          <Icon name="zap" size={16} />
          <span>{t('DNS 覆写')}</span>
          <span className="spacer" />
          <Button size="sm" onClick={resetDefaults}>
            <Icon name="refresh" size={13} />
            {t('重置为默认值')}
          </Button>
          <button className="icon-btn" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        <div className="dns-body">
          {validationError && (
            <div className="dns-error">
              <Icon name="x" size={14} />
              <span>{validationError}</span>
            </div>
          )}

          <Row title={t('启用 DNS')}>
            <Toggle on={settings.enableDns} onChange={(on) => patch({ enableDns: on })} />
          </Row>

          <Row title={t('DNS 监听地址')}>
            <Input
              style={{ width: 180 }}
              value={draftValue('dnsListen', settings.dnsListen)}
              onChange={(e) => setDraft((d) => ({ ...d, dnsListen: e.target.value }))}
              onBlur={() => commitText('dnsListen')}
              disabled={!settings.enableDns}
            />
          </Row>

          <Row title={t('增强模式')}>
            <Seg<DnsEnhancedMode | ''>
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
                  style={{ width: 180 }}
                  value={draftValue('fakeIpRange', settings.fakeIpRange)}
                  onChange={(e) => setDraft((d) => ({ ...d, fakeIpRange: e.target.value }))}
                  onBlur={() => commitText('fakeIpRange')}
                  disabled={!settings.enableDns}
                />
              </Row>

              <Row title={t('Fake IP 过滤模式')}>
                <Seg<FakeIpFilterMode>
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
              on={settings.ipv6Dns}
              onChange={(on) => patch({ ipv6Dns: on })}
              disabled={!settings.enableDns}
            />
          </Row>

          <Row title={t('优先使用 HTTP/3')} desc={t('DNS DOH 使用 HTTP/3 协议')}>
            <Toggle
              on={settings.preferH3}
              onChange={(on) => patch({ preferH3: on })}
              disabled={!settings.enableDns}
            />
          </Row>

          <Row title={t('遵循路由规则')} desc={t('DNS 连接遵循路由规则')}>
            <Toggle
              on={settings.respectRules}
              onChange={(on) => patch({ respectRules: on })}
              disabled={!settings.enableDns}
            />
          </Row>

          <Row title={t('使用 Hosts')} desc={t('启用通过 hosts 文件解析域名')}>
            <Toggle
              on={settings.useHosts}
              onChange={(on) => patch({ useHosts: on })}
              disabled={!settings.enableDns}
            />
          </Row>

          <Row title={t('使用系统 Hosts')} desc={t('启用通过操作系统 hosts 文件解析')}>
            <Toggle
              on={settings.useSystemHosts}
              onChange={(on) => patch({ useSystemHosts: on })}
              disabled={!settings.enableDns}
            />
          </Row>

          <div className="dns-section-title">服务器列表</div>
          <TextArea
            label="域名服务器"
            desc="DNS 服务器列表，用逗号或换行分隔"
            field="nameserver"
            placeholder={'https://dns.alidns.com/dns-query\nhttps://doh.pub/dns-query\n223.5.5.5'}
          />
          <TextArea
            label="回退服务器"
            desc="回退 DNS 服务器列表，用逗号或换行分隔"
            field="fallback"
            placeholder={'https://1.1.1.1/dns-query\ntls://8.8.4.4:853'}
          />
          <TextArea
            label="代理节点 DNS"
            desc="仅用于解析代理节点域名，用逗号或换行分隔"
            field="proxyServerNameserver"
            placeholder={'https://dns.alidns.com/dns-query\n119.29.29.29'}
          />
          <TextArea
            label="直连域名服务器"
            desc="直连出口域名解析服务器，支持 system 关键字"
            field="directNameserver"
            placeholder={'system\n223.5.5.5\nhttps://doh.pub/dns-query'}
          />
          <TextArea
            label="Fake IP 过滤"
            desc="跳过 Fake IP 解析的域名，用逗号或换行分隔"
            field="fakeIpFilter"
            placeholder={'geosite:private\ngeosite:cn\n+.lan\n+.local'}
            rows={4}
          />
          <TextArea
            label="域名服务器策略"
            desc="格式：geosite:cn=server1;server2，每行一条"
            field="nameserverPolicy"
            placeholder={'geosite:cn=https://doh.pub/dns-query;https://dns.alidns.com/dns-query\n+.google.com=https://dns.google/dns-query'}
            rows={4}
          />
        </div>

        <div className="dns-foot">
          <Button onClick={onClose}>
            {t('取消')}
          </Button>
          <Button variant="primary" onClick={saveDnsOverride}>
            <Icon name="check" size={13} />
            {t('保存')}
          </Button>
        </div>
      </div>
    </div>
  )
}
