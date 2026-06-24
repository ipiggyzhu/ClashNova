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
  logo?: BrandLogoName
}

type BrandLogoName = 'apple' | 'google' | 'github' | 'youtube' | 'cloudflare' | 'baidu'

const DEFAULT_SITES: TestSite[] = [
  { name: 'Apple', url: 'https://captive.apple.com/generate_204', color: '#8E8E93', logo: 'apple' },
  { name: 'Google', url: 'https://www.gstatic.com/generate_204', color: '#4285F4', logo: 'google' },
  { name: 'GitHub', url: 'https://github.com/favicon.ico', color: '#24292F', logo: 'github' },
  { name: 'YouTube', url: 'https://www.youtube.com/favicon.ico', color: '#FF0000', logo: 'youtube' },
  { name: 'Cloudflare', url: 'https://cp.cloudflare.com/generate_204', color: '#F48120', logo: 'cloudflare' },
  { name: '百度', url: 'https://www.baidu.com/favicon.ico', color: '#2932E1', logo: 'baidu' },
]

const STORE_KEY = 'nova-test-sites'
const TIMEOUT_MS = 5000

const BRAND_LOGOS: Record<BrandLogoName, JSX.Element> = {
  apple: (
    <path d="M12.15 6.9c-.95 0-2.41-1.08-3.96-1.04-2.04.03-3.91 1.18-4.96 3.01-2.12 3.68-.55 9.1 1.52 12.09 1.01 1.45 2.21 3.09 3.79 3.04 1.52-.07 2.09-.99 3.94-.99 1.83 0 2.35.99 3.96.95 1.64-.03 2.68-1.48 3.68-2.95 1.16-1.69 1.64-3.33 1.66-3.42-.04-.01-3.18-1.22-3.22-4.86-.03-3.04 2.48-4.49 2.6-4.56-1.43-2.09-3.62-2.32-4.39-2.38-2-.15-3.68 1.09-4.62 1.09zM15.53 3.83c.84-1.01 1.4-2.43 1.25-3.83-1.21.05-2.66.81-3.53 1.82-.78.9-1.45 2.34-1.27 3.71 1.34.1 2.71-.69 3.55-1.7z" />
  ),
  google: (
    <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.85 3.19-1.79 4.13-1.15 1.15-2.93 2.4-6.05 2.4-4.83 0-8.6-3.89-8.6-8.72s3.77-8.72 8.6-8.72c2.6 0 4.51 1.03 5.91 2.35l2.31-2.31C18.75 1.44 16.13 0 12.48 0 5.87 0 .31 5.39.31 12s5.56 12 12.17 12c3.57 0 6.27-1.17 8.37-3.36 2.16-2.16 2.84-5.21 2.84-7.67 0-.76-.05-1.47-.17-2.05H12.48z" />
  ),
  github: (
    <path d="M12 .3c-6.63 0-12 5.37-12 12 0 5.3 3.44 9.8 8.21 11.38.6.11.82-.26.82-.58 0-.28-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.38-1.34-1.75-1.34-1.75-1.09-.74.08-.73.08-.73 1.21.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1.01-.32 3.3 1.23.96-.27 1.98-.4 3-.41 1.02.01 2.04.14 3 .41 2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18.76.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.63-5.48 5.92.42.36.81 1.1.81 2.22 0 1.61-.01 2.9-.01 3.29 0 .31.21.69.82.57C20.57 22.09 24 17.59 24 12.3c0-6.63-5.37-12-12-12z" />
  ),
  youtube: (
    <path d="M9.75 7.75v8.5L17 12 9.75 7.75z" />
  ),
  cloudflare: (
    <>
      <path d="M8.1 16.9h9.8c1.76 0 3.2-1.35 3.2-3.02 0-1.54-1.23-2.82-2.82-3-.56-2.71-3.04-4.75-6-4.75-2.65 0-4.9 1.64-5.75 3.93-2.05.25-3.63 1.92-3.63 3.94 0 1.6 1.06 2.9 2.55 2.9h2.65z" />
      <path d="M8.4 18.9h8.9c1.06 0 2.06-.31 2.91-.85-.78 1.12-2.15 1.85-3.7 1.85H7.9c-2.32 0-4.2-1.55-4.2-3.47 0-.25.03-.49.09-.73.54 1.86 2.36 3.2 4.61 3.2z" opacity=".5" />
    </>
  ),
  baidu: (
    <>
      <ellipse cx="7.1" cy="8.1" rx="2" ry="2.8" transform="rotate(-24 7.1 8.1)" />
      <ellipse cx="16.9" cy="8.1" rx="2" ry="2.8" transform="rotate(24 16.9 8.1)" />
      <ellipse cx="10.1" cy="5.3" rx="1.7" ry="2.5" transform="rotate(-8 10.1 5.3)" />
      <ellipse cx="13.9" cy="5.3" rx="1.7" ry="2.5" transform="rotate(8 13.9 5.3)" />
      <path d="M6.2 16.4c0-3.1 2.5-5.5 5.8-5.5s5.8 2.4 5.8 5.5c0 2.5-1.9 3.8-3.7 3.1a6.2 6.2 0 0 0-4.2 0c-1.8.7-3.7-.6-3.7-3.1z" />
    </>
  ),
}

function inferLogo(site: Pick<TestSite, 'name' | 'url'>): BrandLogoName | undefined {
  const marker = `${site.name} ${hostOf(site.url)}`.toLowerCase()
  if (marker.includes('apple')) return 'apple'
  if (marker.includes('google') || marker.includes('gstatic')) return 'google'
  if (marker.includes('github')) return 'github'
  if (marker.includes('youtube')) return 'youtube'
  if (marker.includes('cloudflare')) return 'cloudflare'
  if (marker.includes('baidu') || marker.includes('百度')) return 'baidu'
  return undefined
}

function normalizeSites(sites: TestSite[]): TestSite[] {
  return sites.map((site) => ({ ...site, logo: site.logo ?? inferLogo(site) }))
}

function loadSites(): TestSite[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as TestSite[]
      if (Array.isArray(parsed) && parsed.length > 0) return normalizeSites(parsed)
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

function BrandLogo({ logo, label }: { logo: BrandLogoName; label: string }): JSX.Element {
  return (
    <svg aria-label={`${label} logo`} viewBox="0 0 24 24" role="img">
      {BRAND_LOGOS[logo]}
    </svg>
  )
}

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
            <div className={`logo ${s.logo ? `brand-${s.logo}` : ''}`} style={{ background: s.color }}>
              {s.logo ? <BrandLogo logo={s.logo} label={s.name} /> : s.name.slice(0, 1).toUpperCase()}
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
