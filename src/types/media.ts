export type MediaService = 'youtube' | 'netflix' | 'disney'
export type MediaStatus = 'reachable' | 'restricted' | 'unknown' | 'error'

export interface MediaResult {
  service: MediaService
  status: MediaStatus
  elapsedMs: number
  httpStatus: number | null
  detail: string
}

export interface MediaReport {
  proxyPort: number
  results: MediaResult[]
}
