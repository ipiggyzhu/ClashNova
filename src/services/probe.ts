import { call } from './ipc'
import { createTaskQueue } from '../utils/taskQueue'

const queueProbe = createTaskQueue<number>(4)

/** 原生 HTTP 探测核验 2xx；不把浏览器 no-cors 的 opaque 响应当作成功。 */
export async function probeUrl(url: string): Promise<number> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.reject(new Error('仅支持 HTTP / HTTPS 测试地址'))
  }
  return queueProbe(parsed.href, () => call('probe_url', { url: parsed.href }))
}
