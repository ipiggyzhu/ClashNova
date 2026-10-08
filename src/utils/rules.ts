const RULE_TYPES = [
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX', 'GEOSITE',
  'IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX', 'IP-ASN', 'SRC-IP-CIDR', 'SRC-IP-SUFFIX', 'SRC-IP-ASN',
  'GEOIP', 'SRC-GEOIP', 'RULE-SET', 'PROCESS-NAME', 'PROCESS-PATH', 'PROCESS-NAME-REGEX',
  'PROCESS-PATH-REGEX', 'SRC-PORT', 'DST-PORT', 'IN-PORT', 'IN-TYPE', 'IN-USER', 'IN-NAME',
  'UID', 'NETWORK', 'DSCP', 'AND', 'OR', 'NOT', 'SUB-RULE', 'MATCH',
]
const names = new Map(RULE_TYPES.map((type) => [type.replaceAll('-', ''), type]))

/** mihomo REST 使用 DomainSuffix / IPCIDR 等名字，配置使用 DOMAIN-SUFFIX / IP-CIDR。 */
export function normalizeRuleType(type: string): string {
  return names.get(type.replace(/[-_\s]/g, '').toUpperCase()) ?? type.toUpperCase()
}
