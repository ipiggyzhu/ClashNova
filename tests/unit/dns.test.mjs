import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSource, plain } from '../helpers.mjs'

const dns = loadSource('src/utils/dnsOverride.ts').module
const base = {
  enableDns: true, dnsOverride: '', dnsListen: '127.0.0.1:5335', dnsEnhancedMode: 'fake-ip',
  fakeIpRange: '198.18.0.1/16', fakeIpFilterMode: 'blacklist',
  ipv6Dns: false, preferH3: false, respectRules: false, useHosts: true, useSystemHosts: true,
}

test('DNS quoted scalars ignore trailing comments but preserve quoted #', () => {
  const result = dns.normalizeDnsSettings({ ...base,
    dnsOverride: 'listen: "127.0.0.1:5335" # listener\nenhanced-mode: "fake-ip" # mode\n',
  })
  assert.equal(result.dnsListen, '127.0.0.1:5335')
  assert.equal(result.dnsEnhancedMode, 'fake-ip')
  const form = dns.parseDnsForm('nameserver: ["https://resolver.invalid/dns-query#h3", "1.1.1.1"] # comment\n')
  assert.equal(form.nameserver, 'https://resolver.invalid/dns-query#h3\n1.1.1.1')
})

test('DNS policy flow sequences do not retain bracket characters', () => {
  const result = dns.parseDnsForm('nameserver-policy:\n  "+.example.invalid": [1.1.1.1, 8.8.8.8]\n')
  assert.equal(result.nameserverPolicy, '+.example.invalid=1.1.1.1;8.8.8.8')
})

test('DNS form round trip preserves unmanaged nested keys', () => {
  const current = 'cache-algorithm: arc\nfallback-filter:\n  geoip: true\n  geosite:\n    - gfw\n'
  const form = { ...dns.EMPTY_DNS_FORM, nameserver: '1.1.1.1\nhttps://resolver.invalid/dns-query#h3', nameserverPolicy: '+.example.invalid=8.8.8.8;1.1.1.1' }
  const built = dns.buildDnsFormOverride(base, form, current)
  assert.match(built, /cache-algorithm: arc/)
  assert.match(built, /fallback-filter:\n  geoip: true\n  geosite:\n    - gfw/)
  assert.deepEqual(plain(dns.parseDnsForm(built)), plain(form))
})

test('DNS advanced edit keeps unowned YAML lists', () => {
  const updated = dns.syncDnsSettings({ ...base, dnsOverride: 'enable: true\nnameserver:\n  - 1.1.1.1\n' }, { ipv6Dns: true })
  assert.match(updated.dnsOverride, /ipv6: true/)
  assert.match(updated.dnsOverride, /nameserver:\n  - 1.1.1.1/)
})

test('mihomo rule API names normalize to filter labels', () => {
  const { normalizeRuleType } = loadSource('src/utils/rules.ts').module
  for (const [input, expected] of [['DomainSuffix', 'DOMAIN-SUFFIX'], ['IPCIDR', 'IP-CIDR'], ['IP-CIDR6', 'IP-CIDR6'], ['GeoIP', 'GEOIP'], ['RuleSet', 'RULE-SET'], ['ProcessName', 'PROCESS-NAME']]) {
    assert.equal(normalizeRuleType(input), expected)
  }
})
