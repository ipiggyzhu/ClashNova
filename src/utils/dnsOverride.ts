import type { AppSettings, DnsEnhancedMode, FakeIpFilterMode } from '../types/clash'

type DnsAdvancedKey =
  | 'enableDns'
  | 'dnsListen'
  | 'dnsEnhancedMode'
  | 'fakeIpRange'
  | 'fakeIpFilterMode'
  | 'ipv6Dns'
  | 'preferH3'
  | 'respectRules'
  | 'useHosts'
  | 'useSystemHosts'

const DNS_ADVANCED_KEYS: readonly DnsAdvancedKey[] = [
  'enableDns',
  'dnsListen',
  'dnsEnhancedMode',
  'fakeIpRange',
  'fakeIpFilterMode',
  'ipv6Dns',
  'preferH3',
  'respectRules',
  'useHosts',
  'useSystemHosts',
]

const MANAGED_YAML_KEYS = new Set([
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
])

const DNS_DEFAULTS = {
  dnsListen: '127.0.0.1:5335',
  dnsEnhancedMode: '' as DnsEnhancedMode | '',
  fakeIpRange: '198.18.0.1/16',
  fakeIpFilterMode: 'blacklist' as FakeIpFilterMode,
  ipv6Dns: false,
  preferH3: false,
  respectRules: false,
  useHosts: false,
  useSystemHosts: false,
}

export function syncDnsSettings(
  prev: AppSettings,
  patch: Partial<AppSettings>,
): AppSettings {
  let next: AppSettings = { ...prev, ...patch }
  const dnsOverrideChanged = Object.prototype.hasOwnProperty.call(patch, 'dnsOverride')
  const advancedChanged = DNS_ADVANCED_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(patch, key),
  )

  if (dnsOverrideChanged) {
    const raw = normalizeDnsRoot(patch.dnsOverride ?? '')
    next = { ...next, ...parseDnsOverride(raw), dnsOverride: raw }
  } else if (advancedChanged || (next.enableDns && !next.dnsOverride.trim())) {
    next.dnsOverride = buildDnsOverride(next, next.dnsOverride)
  }

  return next
}

export function normalizeDnsSettings(settings: AppSettings): AppSettings {
  if (settings.dnsOverride.trim()) {
    const raw = normalizeDnsRoot(settings.dnsOverride)
    return { ...settings, ...parseDnsOverride(raw), dnsOverride: raw }
  }
  return { ...settings, dnsOverride: buildDnsOverride(settings, '') }
}

function buildDnsOverride(settings: AppSettings, current: string): string {
  const managed = new Map<string, string>([
    ['enable', `enable: ${settings.enableDns ? 'true' : 'false'}`],
    ['listen', `listen: ${quoteYaml(settings.dnsListen || DNS_DEFAULTS.dnsListen)}`],
    ['ipv6', `ipv6: ${settings.ipv6Dns ? 'true' : 'false'}`],
    ['prefer-h3', `prefer-h3: ${settings.preferH3 ? 'true' : 'false'}`],
    ['respect-rules', `respect-rules: ${settings.respectRules ? 'true' : 'false'}`],
    ['use-hosts', `use-hosts: ${settings.useHosts ? 'true' : 'false'}`],
    [
      'use-system-hosts',
      `use-system-hosts: ${settings.useSystemHosts ? 'true' : 'false'}`,
    ],
  ])

  if (settings.dnsEnhancedMode) {
    managed.set('enhanced-mode', `enhanced-mode: ${settings.dnsEnhancedMode}`)
  }
  if (settings.dnsEnhancedMode === 'fake-ip') {
    managed.set('fake-ip-range', `fake-ip-range: ${quoteYaml(settings.fakeIpRange)}`)
    managed.set('fake-ip-filter-mode', `fake-ip-filter-mode: ${settings.fakeIpFilterMode}`)
  }

  const preserved = preserveUnmanagedYaml(current)
  const head = Array.from(managed.values())
  return [...head, ...(preserved.length ? ['', ...preserved] : [])].join('\n') + '\n'
}

function preserveUnmanagedYaml(raw: string): string[] {
  const lines = normalizeDnsRoot(raw).split(/\r?\n/)
  const kept: string[] = []
  let skippingManagedBlock = false

  for (const line of lines) {
    const isIndented = /^\s+\S/.test(line)
    if (skippingManagedBlock && isIndented) continue
    skippingManagedBlock = false

    const match = line.match(/^([A-Za-z0-9_-]+)\s*:/)
    if (match && MANAGED_YAML_KEYS.has(match[1])) {
      skippingManagedBlock = true
      continue
    }
    kept.push(line)
  }

  while (kept.length && !kept[0].trim()) kept.shift()
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop()
  return kept
}

function parseDnsOverride(raw: string): Partial<AppSettings> {
  const text = normalizeDnsRoot(raw).trim()
  if (!hasDnsContent(text)) return { enableDns: false }

  const scalars = extractTopLevelScalars(text)
  const patch: Partial<AppSettings> = {
    enableDns: parseBoolean(scalars.get('enable')) ?? true,
    dnsListen: parseString(scalars.get('listen')) ?? DNS_DEFAULTS.dnsListen,
    dnsEnhancedMode: parseEnhancedMode(scalars.get('enhanced-mode')),
    fakeIpRange: parseString(scalars.get('fake-ip-range')) ?? DNS_DEFAULTS.fakeIpRange,
    fakeIpFilterMode:
      parseFakeIpFilterMode(scalars.get('fake-ip-filter-mode')) ??
      DNS_DEFAULTS.fakeIpFilterMode,
    ipv6Dns: parseBoolean(scalars.get('ipv6')) ?? DNS_DEFAULTS.ipv6Dns,
    preferH3: parseBoolean(scalars.get('prefer-h3')) ?? DNS_DEFAULTS.preferH3,
    respectRules: parseBoolean(scalars.get('respect-rules')) ?? DNS_DEFAULTS.respectRules,
    useHosts: parseBoolean(scalars.get('use-hosts')) ?? DNS_DEFAULTS.useHosts,
    useSystemHosts:
      parseBoolean(scalars.get('use-system-hosts')) ?? DNS_DEFAULTS.useSystemHosts,
  }
  return patch
}

function hasDnsContent(raw: string): boolean {
  return raw
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim()
      return trimmed.length > 0 && !trimmed.startsWith('#')
    })
}

function extractTopLevelScalars(raw: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!match) continue
    const value = match[2].trim()
    if (!value || value === '|' || value === '>') continue
    out.set(match[1], stripInlineComment(value))
  }
  return out
}

function normalizeDnsRoot(raw: string): string {
  const lines = raw.split(/\r?\n/)
  const dnsStart = lines.findIndex((line) => /^dns\s*:\s*(?:#.*)?$/.test(line))
  if (dnsStart === -1) return raw

  const out: string[] = []
  let baseIndent: string | null = null

  for (let i = dnsStart + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) {
      if (out.length) out.push('')
      continue
    }
    const indent = line.match(/^\s+/)?.[0]
    if (indent) {
      // 按 dns: 段下首个子键的实际缩进量去缩进(兼容 2/4 空格、Tab)
      if (baseIndent === null) baseIndent = indent
      out.push(line.startsWith(baseIndent) ? line.slice(baseIndent.length) : line.replace(/^\s+/, ''))
      continue
    }
    break
  }

  return out.join('\n')
}

function quoteYaml(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function stripInlineComment(value: string): string {
  let quote = ''
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (quote) {
      if (quote === '"' && char === '\\') { i += 1; continue }
      if (quote === "'" && char === "'" && value[i + 1] === "'") { i += 1; continue }
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trim()
    }
  }
  return value.trim()
}

function parseString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string } catch { return trimmed.slice(1, -1) }
  }
  return trimmed
}

function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = parseString(value)?.toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(normalized ?? '')) return true
  if (['false', 'no', 'off', '0'].includes(normalized ?? '')) return false
  return undefined
}

function parseEnhancedMode(value: string | undefined): DnsEnhancedMode | '' {
  const normalized = parseString(value)
  return normalized === 'fake-ip' || normalized === 'redir-host' ? normalized : ''
}

function parseFakeIpFilterMode(value: string | undefined): FakeIpFilterMode | undefined {
  const normalized = parseString(value)
  return normalized === 'blacklist' || normalized === 'whitelist' ? normalized : undefined
}

export interface DnsOverrideForm {
  nameserver: string
  fallback: string
  proxyServerNameserver: string
  directNameserver: string
  fakeIpFilter: string
  nameserverPolicy: string
}

export const EMPTY_DNS_FORM: DnsOverrideForm = {
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

function stripYamlValue(value: string): string {
  return parseString(stripInlineComment(value)) ?? ''
}

function splitYamlSequence(value: string): string[] {
  const text = stripInlineComment(value)
  if (!text.startsWith('[')) return text ? [stripYamlValue(text)] : []
  if (!text.endsWith(']')) throw new Error('DNS 行内列表缺少结束方括号')
  const body = text.slice(1, -1)
  const items: string[] = []
  let quote = ''
  let start = 0
  for (let i = 0; i <= body.length; i += 1) {
    const char = body[i]
    if (quote) {
      if (quote === '"' && char === '\\') { i += 1; continue }
      if (quote === "'" && char === "'" && body[i + 1] === "'") { i += 1; continue }
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === ',' || i === body.length) {
      const item = stripYamlValue(body.slice(start, i))
      if (item) items.push(item)
      start = i + 1
    }
  }
  return items
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
  const inline = stripInlineComment(lines[start].replace(new RegExp(`^${key}\\s*:\\s*`), ''))
  if (inline && inline !== '[]') {
    if (inline.startsWith('[') && inline.endsWith(']')) {
      return splitYamlSequence(inline).join('\n')
    }
    return splitYamlSequence(inline).join('\n')
  }
  const items: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (!/^\s+/.test(line) && !line.startsWith('- ')) break
    const match = line.match(/^\s*-\s*(.+)$/)
    if (match) items.push(stripYamlValue(match[1]))
  }
  return items.join('\n')
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
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (!/^\s+/.test(line)) break
    const entry = parseYamlMapEntry(line)
    if (entry) {
      flush()
      currentKey = entry.key
      const inline = stripInlineComment(entry.value)
      if (inline) currentServers = splitYamlSequence(inline)
      continue
    }
    const itemMatch = line.match(/^\s*-\s*(.+)$/)
    if (itemMatch) currentServers.push(stripYamlValue(itemMatch[1]))
  }
  flush()
  return entries.join('\n')
}

export function parseDnsForm(raw: string): DnsOverrideForm {
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

export function normalizeForCompare(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

export function buildDnsFormOverride(settings: AppSettings, form: DnsOverrideForm, current: string): string {
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
