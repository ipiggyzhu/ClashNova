import type { AppSettings, LogItem } from '../types/clash'

const LOG_RANK = { debug: 0, info: 1, warning: 2, error: 3, silent: 4 }

export function meetsLogLevel(type: LogItem['type'], minimum: AppSettings['logLevel']): boolean {
  return LOG_RANK[type] >= LOG_RANK[minimum]
}
