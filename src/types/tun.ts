export interface TunOptions {
  stack: 'system' | 'gvisor' | 'mixed' | null
  device: string | null
  mtu: number | null
  autoRoute: boolean
  autoDetectInterface: boolean
  interfaceName: string | null
  strictRoute: boolean | null
  dnsHijack: string[] | null
  routeExcludeAddress: string[] | null
}

export const DEFAULT_TUN_OPTIONS: TunOptions = {
  stack: null,
  device: null,
  mtu: null,
  autoRoute: true,
  autoDetectInterface: true,
  interfaceName: null,
  strictRoute: null,
  dnsHijack: null,
  routeExcludeAddress: null,
}
