export interface ProfileDownloadOptions {
  userAgent?: string
  timeoutSec: number
  proxy: 'system' | 'direct' | 'core'
  updateIntervalFromHeader: boolean
}

export const DEFAULT_PROFILE_DOWNLOAD_OPTIONS: ProfileDownloadOptions = {
  timeoutSec: 30,
  proxy: 'system',
  updateIntervalFromHeader: true,
}

export interface ProfileTopology {
  content: string
  proxies: Record<string, unknown>[]
  groups: Record<string, unknown>[]
}
