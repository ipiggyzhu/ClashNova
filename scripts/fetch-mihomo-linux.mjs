#!/usr/bin/env node
/**
 * 拉取锁定版 mihomo Linux amd64-compatible sidecar，并检查归档/二进制 SHA256。
 * 已有文件也校验；--force 强制下载。临时文件仅位于项目 .tmp/，不运行内核。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { fetchMihomo } from './fetch-mihomo-common.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

fetchMihomo({
  root,
  platform: 'linux',
  force: process.argv.includes('--force'),
  unpack: (archive, asset) => gunzipSync(archive, { maxOutputLength: asset.binarySize }),
}).catch((error) => {
  console.error('mihomo Linux 拉取失败:', error?.message ?? error)
  process.exitCode = 1
})
