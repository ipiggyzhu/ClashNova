import type { TunOptions } from '../types/tun'

export interface TunDraft {
  options: TunOptions
  mtu: string
  device: string
  interfaceName: string
  dnsHijack: string
  routeExcludeAddress: string
}

function isIp(value: string): boolean {
  if (value.includes(':')) {
    try { return new URL(`http://[${value}]/`).hostname.startsWith('[') }
    catch { return false }
  }
  const parts = value.split('.')
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
}

function list(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

/** 仅保存管理的 TUN 字段；null 沿用订阅，空数组明确清空。 */
export function parseTunDraft(draft: TunDraft): TunOptions {
  const { options } = draft
  const device = draft.device.trim() || null
  const interfaceName = draft.interfaceName.trim() || null
  for (const value of [device, interfaceName]) {
    if (value && (new TextEncoder().encode(value).length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(value))) {
      throw new Error('TUN 网卡名称应为 1–128 字节且不含控制字符')
    }
  }
  const rawMtu = draft.mtu.trim()
  const mtu = rawMtu ? Number(rawMtu) : null
  if (mtu !== null && (!/^\d+$/.test(rawMtu) || !Number.isInteger(mtu) || mtu < 576 || mtu > 65535)) {
    throw new Error('TUN MTU 应为 576–65535 的整数')
  }
  const dnsHijack = options.dnsHijack === null ? null : list(draft.dnsHijack)
  if (dnsHijack && (dnsHijack.length > 64 || dnsHijack.some((value) => {
    const match = /^(?:(?:tcp|udp):\/\/)?(.+):(\d+)$/.exec(value)
    if (!match) return true
    const host = match[1]
    const validHost = host.startsWith('[') && host.endsWith(']')
      ? host.includes(':') && isIp(host.slice(1, -1))
      : host === 'any' || (!host.includes(':') && isIp(host))
    const port = Number(match[2])
    return !validHost || port < 1 || port > 65535
  }))) throw new Error('DNS 劫持地址应为 any:53、IP:端口或 tcp://IP:端口，最多 64 条')
  const routeExcludeAddress = options.routeExcludeAddress === null ? null : list(draft.routeExcludeAddress)
  if (routeExcludeAddress && (routeExcludeAddress.length > 256 || routeExcludeAddress.some((value) => {
    const match = /^(.+)\/(\d+)$/.exec(value)
    return !match || !isIp(match[1]) || Number(match[2]) > (match[1].includes(':') ? 128 : 32)
  }))) throw new Error('路由排除应为合法 IPv4/IPv6 CIDR，最多 256 条')
  return { ...options, mtu, device, interfaceName, dnsHijack, routeExcludeAddress }
}
