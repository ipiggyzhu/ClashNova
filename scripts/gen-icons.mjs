#!/usr/bin/env node
/**
 * 生成 ClashNova 品牌图标 → src-tauri/icons/
 *   32x32.png / 128x128.png / 128x128@2x.png(256) / icon.png(512) / icon.ico(16~256 多尺寸)
 *
 * 品牌图形与设计稿 design/shell-head.html 的 .brand-logo 完全一致:
 *   135° 渐变(#0A84FF → #64D2FF)圆角方块 + 白色 N 折线(M5 19V5l9 14h5V5)
 *   圆角比例 9/30、字形比例 17/30 均取自设计稿。
 * icon.icns 跳过(M1 仅 Windows 目标)。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'src-tauri', 'icons')

// 以 512 为母版尺寸按设计稿比例放大
const SIZE = 512
const RADIUS = Math.round(SIZE * (9 / 30)) // 圆角 ≈154
const GLYPH = SIZE * (17 / 30) // 字形区 ≈290
const SCALE = GLYPH / 24 // 字形 viewBox 为 24
const OFFSET = (SIZE - GLYPH) / 2

const brandSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0A84FF"/>
      <stop offset="1" stop-color="#64D2FF"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="url(#g)"/>
  <g transform="translate(${OFFSET} ${OFFSET}) scale(${SCALE})">
    <path d="M5 19V5l9 14h5V5" fill="none" stroke="#fff" stroke-width="2.4"
      stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`

/** 渲染指定边长的 PNG Buffer(保留透明圆角, RGBA — Tauri 要求带 alpha 通道) */
function renderPng(size) {
  return sharp(Buffer.from(brandSvg)).resize(size, size).ensureAlpha().png().toBuffer()
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
