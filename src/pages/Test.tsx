import { useCallback, useEffect, useRef, useState } from 'react'
import './Test.css'
import Button from '../components/ui/Button'
import Icon from '../components/ui/Icon'
import Input from '../components/ui/Input'
import { isMock } from '../services/ipc'
import { delayTone } from '../utils/format'

interface TestSite {
  name: string
  url: string
  color: string
}

const DEFAULT_SITES: TestSite[] = [
  { name: 'Apple', url: 'https://captive.apple.com/generate_204', color: '#8E8E93' },
  { name: 'Google', url: 'https://www.gstatic.com/generate_204', color: '#4285F4' },
  { name: 'GitHub', url: 'https://github.com/favicon.ico', color: '#6E5494' },
  { name: 'YouTube', url: 'https://www.youtube.com/favicon.ico', color: '#FF0000' },
  { name: 'Cloudflare', url: 'https://cp.cloudflare.com/generate_204', color: '#F48120' },
  { name: '百度', url: 'https://www.baidu.com/favicon.ico', color: '#2932E1' },
]

const STORE_KEY = 'nova-test-sites'
const TIMEOUT_MS = 5000

function loadSites(): TestSite[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as TestSite[]
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }
  } catch {
    /* 损坏即回退默认 */
  }
  return DEFAULT_SITES
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** 经当前网络栈(真实模式即代理)对站点计时;失败/超时返回 -1 */
async function probe(url: string): Promise<number> {
  if (isMock) {
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 800))
    return Math.random() < 0.9 ? Math.round(40 + Math.random() * 460) : -1
  }
  const begin = performance.now()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
    clearTimeout(timer)
    return Math.round(performance.now() - begin)
  } catch {
    return -1
  }
}

/** 0=测试中, -1=失败, >0=延迟 ms */
type DelayMap = Record<string, number>

export default function Test() {
  const [sites, setSites] = useState<TestSite[]>(loadSites)
  const [delays, setDelays] = useState<DelayMap>({})
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(sites))
  }, [sites])

  const testOne = useCallback(async (site: TestSite): Promise<void> => {
    setDelays((d) => ({ ...d, [site.url]: 0 }))
    const ms = await probe(site.url)
    if (aliveRef.current) setDelays((d) => ({ ...d, [site.url]: ms }))
  }, [])

  const testAll = useCallback(async (): Promise<void> => {
    await Promise.all(sites.map((s) => testOne(s)))
  }, [sites, testOne])

  useEffect(() => {
    void testAll()
    // 仅首次进入页面自动全测
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addSite = (): void => {
    const n = name.trim()
    const u = url.trim()
    if (!n || !u) return
    if (sites.some((s) => s.url === u)) return
    const colors = ['#0A84FF', '#32D74B', '#BF5AF2', '#FF9F0A', '#64D2FF', '#FF375F']
    const site: TestSite = {
      name: n,
      url: u,
      color: colors[sites.length % colors.length] ?? '#0A84FF',
    }
    setSites((prev) => [...prev, site])
    setName('')
    setUrl('')
    void testOne(site)
  }

  const renderDelay = (site: TestSite): JSX.Element => {
    const v = delays[site.url]
    if (v === undefined) return <span className="delay gray">未测试</span>
    if (v === 0) return <span className="delay gray">测试中…</span>
    if (v === -1) return <span className="delay red">失败</span>
    return <span className={`delay ${delayTone(v)}`}>{v} ms</span>
  }

  return (
    <div className="pg-test">
      <div className="toolbar">
        <Input placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          className="url"
          placeholder="测试地址 https://…(204 端点或小资源)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addSite()
          }}
        />
        <Button onClick={addSite}>
          <Icon name="plus" size={13} />添加
        </Button>
        <Button variant="primary" onClick={() => void testAll()}>
          <Icon name="zap" size={13} />全部测试
        </Button>
      </div>

      <div className="grid">
        {sites.map((s) => (
          <div className="site" key={s.url} onClick={() => void testOne(s)} title="点击重测">
            <button
              className="rm"
              title="移除"
              onClick={(e) => {
                e.stopPropagation()
                setSites((prev) => prev.filter((it) => it.url !== s.url))
              }}
            >
              <Icon name="x" size={12} />
            </button>
            <div className="logo" style={{ background: s.color }}>
              {s.name.slice(0, 1).toUpperCase()}
            </div>
            <span className="nm">{s.name}</span>
            <span className="host">{hostOf(s.url)}</span>
            {renderDelay(s)}
          </div>
        ))}
      </div>
    </div>
  )
}
