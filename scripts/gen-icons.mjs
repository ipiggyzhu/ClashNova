#!/usr/bin/env node
/**
 * 生成 ClashNova 品牌图标 → src-tauri/icons/
 *   32x32.png / 128x128.png / 128x128@2x.png(256) / icon.png(512) / icon.ico(16~256 多尺寸)
 *
 * 直接基于 public/logo.png 生成，保证桌面图标与应用内品牌图一致。
 * icon.icns 跳过(M1 仅 Windows 目标)。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'src-tauri', 'icons')

const SIZE = 512
const source = path.join(root, 'public', 'logo.png')

async function renderPng(size) {
  return sharp(source)
    .resize(size, size, { fit: 'cover' })
    .png()
    .toBuffer()
}

async function main() {
  await mkdir(outDir, { recursive: true })

  const targets = [
    ['32x32.png', 32],
    ['128x128.png', 128],
    ['128x128@2x.png', 256],
    ['icon.png', 512],
  ]
  for (const [name, size] of targets) {
    await writeFile(path.join(outDir, name), await renderPng(size))
    console.log(`已生成 icons/${name} (${size}x${size})`)
  }

  // ico 内置多尺寸, 供任务栏/资源管理器各 DPI 取用
  const icoPngs = await Promise.all([16, 24, 32, 48, 64, 128, 256].map(renderPng))
  await writeFile(path.join(outDir, 'icon.ico'), await pngToIco(icoPngs))
  console.log('已生成 icons/icon.ico (16~256 多尺寸)')
}

main().catch((err) => {
  console.error('图标生成失败:', err)
  process.exit(1)
})
