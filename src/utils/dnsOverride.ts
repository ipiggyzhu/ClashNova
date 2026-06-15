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

function quoteYaml(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function stripInlineComment(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed
  return trimmed.replace(/\s+#.*$/, '').trim()
}

function parseString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
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
