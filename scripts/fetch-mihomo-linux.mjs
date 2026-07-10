#!/usr/bin/env node
/**
 * 拉取 mihomo Linux 内核(Tauri sidecar):
 *   GitHub API releases/latest (MetaCubeX/mihomo)
 *   → 资产匹配 mihomo-linux-amd64-compatible-v*.gz(兼容更多 CPU,最稳)
 *   → 内置 fetch 下载, zlib.gunzip 纯 Node 解压
 *   → 产出 src-tauri/binaries/mihomo-x86_64-unknown-linux-gnu(可执行, 无扩展名)
 * 目标已存在时跳过, 传 --force 强制覆盖。
 * 可设环境变量 GITHUB_TOKEN 规避 API 限流(CI 中自动注入)。
 */
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest'
// 首选 compatible 变体(不依赖较新 CPU 指令集, 覆盖面最广)
const ASSET_STRICT = /^mihomo-linux-amd64-compatible-v\d+\.\d+(\.\d+)?\.gz$/
// 兜底: 标准 amd64(排除 go120 等旧 Go 兼容构建)
const ASSET_LOOSE = /^mihomo-linux-amd64-v\d[\d.]*\.gz$/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outFile = path.join(root, 'src-tauri', 'binaries', 'mihomo-x86_64-unknown-linux-gnu')
const force = process.argv.includes('--force')

const apiHeaders = {
  'User-Agent': 'ClashNova-build-script',
  Accept: 'application/vnd.github+json',
}
if (process.env.GITHUB_TOKEN) {
  apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function main() {
  if (!force && (await exists(outFile))) {
    console.log(`已存在 ${path.relative(root, outFile)}, 跳过下载(--force 可强制覆盖)`)
    return
  }

  console.log('查询 mihomo 最新 release ...')

  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`尝试 ${attempt}/3 ...`)
      const res = await fetch(API, {
        headers: apiHeaders,
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) {
        const errorText = await res.text()
        throw new Error(`GitHub API 返回 ${res.status}: ${errorText.slice(0, 200)}`)
      }

      const release = await res.json()
      console.log(`找到 release: ${release.tag_name}`)

      const assets = release.assets ?? []
      const asset =
        assets.find((a) => ASSET_STRICT.test(a.name)) ??
        assets.find((a) => ASSET_LOOSE.test(a.name) && !/-go\d+/.test(a.name))

      if (!asset) {
        throw new Error(`未在 release ${release.tag_name} 中找到 mihomo-linux-amd64(-compatible)-v*.gz 资产`)
      }

      console.log(`下载 ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB) ...`)
      const dl = await fetch(asset.browser_download_url, {
        headers: { 'User-Agent': apiHeaders['User-Agent'] },
        signal: AbortSignal.timeout(300000),
      })
      if (!dl.ok) throw new Error(`资产下载失败: HTTP ${dl.status}`)

      const gzBuf = Buffer.from(await dl.arrayBuffer())
      const binBuf = gunzipSync(gzBuf)
      if (binBuf.length < 1_000_000) {
        throw new Error(`解压后体积异常(${binBuf.length} bytes), 疑似下载损坏`)
      }

      await mkdir(path.dirname(outFile), { recursive: true })
      await writeFile(outFile, binBuf)
      await chmod(outFile, 0o755)
      console.log(`完成: ${path.relative(root, outFile)} (内核 ${release.tag_name})`)
      return
    } catch (err) {
      lastError = err
      console.error(`尝试 ${attempt} 失败: ${err.message}`)
      if (attempt < 3) {
        const waitTime = attempt * 2000
        console.log(`等待 ${waitTime / 1000} 秒后重试...`)
        await new Promise((resolve) => setTimeout(resolve, waitTime))
      }
    }
  }

  throw lastError || new Error('未知错误')
}

main().catch((err) => {
  console.error('mihomo Linux 拉取失败:', err?.message ?? err)
  process.exit(1)
})
