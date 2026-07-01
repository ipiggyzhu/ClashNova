/** 数值/时间格式化工具(页面共享)。 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** 字节 → "162.4 GB" */
export function fmtBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const i = Math.max(0, Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024))))
  const v = n / 1024 ** i
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : digits)} ${UNITS[i]}`
}

/** 字节/秒 → "1.2 MB/s" */
export function fmtSpeed(n: number): string {
  return `${fmtBytes(n)}/s`
}

/** 秒 → "6:07"(时:分) */
export function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}`
}

/** 秒 → "02:41"(分:秒) 或 "1:02:41" */
export function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const mm = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return h > 0 ? `${h}:${mm}` : mm
}

/** 时间戳 → "2 小时前" */
export function fmtRelTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 时间戳 → 剩余天数(向上取整, 过期为 0) */
export function daysLeft(ts: number): number {
  return Math.max(0, Math.ceil((ts - Date.now()) / 86_400_000))
}

/** 延迟 → Badge 色调(与设计稿一致: <100 绿 / <200 黄 / 其余橙; 超时由调用方处理红) */
export function delayTone(ms: number): 'green' | 'yellow' | 'orange' {
  if (ms < 100) return 'green'
  if (ms < 200) return 'yellow'
  return 'orange'
}
