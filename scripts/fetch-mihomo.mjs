#!/usr/bin/env node
/**
 * 拉取 mihomo Windows sidecar，版本及摘要由 mihomo.lock.json 固定。
 * 已有二进制也检查 SHA256；--force 在校验后强制重新下载。
 * 下载与解包仅使用项目 .tmp/，验证通过后原子替换目标，不运行内核。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { fetchMihomo } from './fetch-mihomo-common.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

fetchMihomo({
  root,
  platform: 'windows',
  force: process.argv.includes('--force'),
  unpack(archive, asset) {
    const entries = new AdmZip(archive).getEntries().filter(
      (entry) => !entry.isDirectory && entry.entryName === asset.archiveEntry,
    )
    if (entries.length !== 1) throw new Error(`${asset.asset} 缺少唯一入口 ${asset.archiveEntry}`)
    return entries[0].getData()
  },
}).catch((error) => {
  console.error('mihomo 拉取失败:', error?.message ?? error)
  process.exitCode = 1
})
