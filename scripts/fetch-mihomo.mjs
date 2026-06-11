#!/usr/bin/env node
/**
 * 拉取 mihomo Windows 内核(Tauri sidecar):
 *   GitHub API releases/latest (MetaCubeX/mihomo)
 *   → 资产匹配 mihomo-windows-amd64-v*.zip(排除 go120/compatible 变体)
 *   → 内置 fetch 下载到临时目录, adm-zip 纯 Node 解压
 *   → 产出 src-tauri/binaries/mihomo-x86_64-pc-windows-msvc.exe
 * 目标已存在时跳过, 传 --force 强制覆盖。
 * 可设环境变量 GITHUB_TOKEN 规避 API 限流(CI 中自动注入)。
 */
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest'
// 主构建: mihomo-windows-amd64-v1.19.27.zip(纯版本号后缀)
const ASSET_STRICT = /^mihomo-windows-amd64-v\d+\.\d+(\.\d+)?\.zip$/
// 兜底: 任意 v* 后缀但排除 go120/go121 等旧 Go 兼容构建与 compatible 变体
const ASSET_LOOSE = /^mihomo-windows-amd64-v\d.*\.zip$/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outFile = path.join(root, 'src-tauri', 'binaries', 'mihomo-x86_64-pc-windows-msvc.exe')
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
  const res = await fetch(API, { headers: apiHeaders })
  if (!res.ok) {
    throw new Error(`GitHub API 返回 ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const release = await res.json()
  const assets = release.assets ?? []
  const asset =
    assets.find((a) => ASSET_STRICT.test(a.name)) ??
    assets.find(
      (a) => ASSET_LOOSE.test(a.name) && !/-go\d+/.test(a.name) && !a.name.includes('compatible'),
    )
  if (!asset) {
    throw new Error(`未在 release ${release.tag_name} 中找到 mihomo-windows-amd64-v*.zip 资产`)
  }

  console.log(`下载 ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB) ...`)
  const dl = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': apiHeaders['User-Agent'] },
  })
  if (!dl.ok) throw new Error(`资产下载失败: HTTP ${dl.status}`)

  const zipPath = path.join(os.tmpdir(), `mihomo-${process.pid}-${Date.now()}.zip`)
  await writeFile(zipPath, Buffer.from(await dl.arrayBuffer()))

  try {
    const zip = new AdmZip(zipPath)
    const entry = zip
      .getEntries()
      .find((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.exe'))
    if (!entry) throw new Error(`${asset.name} 中未找到 .exe 文件`)

    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, entry.getData())
    console.log(`完成: ${path.relative(root, outFile)} (内核 ${release.tag_name})`)
  } finally {
    await rm(zipPath, { force: true })
  }
}

main().catch((err) => {
  console.error('mihomo 拉取失败:', err?.message ?? err)
  process.exit(1)
})
