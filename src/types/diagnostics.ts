export type DiagnosticStatus = 'pass' | 'warn' | 'fail' | 'unknown' | 'skipped'

export interface DiagnosticCheck {
  id: string
  title: string
  status: DiagnosticStatus
  detail: string
  suggestion: string
  elapsedMs: number | null
}

/** 仅含固定诊断文案、状态和耗时；不包含配置、地址、原始日志或错误。 */
export interface DiagnosticReport {
  schemaVersion: number
  source: 'native' | 'mock'
  appVersion: string
  platform: string
  generatedAt: number
  durationMs: number
  includeInternet: boolean
  checks: DiagnosticCheck[]
}
