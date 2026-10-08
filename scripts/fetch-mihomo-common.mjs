import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'

const lock = JSON.parse(await readFile(new URL('./mihomo.lock.json', import.meta.url), 'utf8'))

async function matchesBinary(file, asset) {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size !== asset.binarySize) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest('hex') === asset.binarySha256
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function downloadArchive(asset, file) {
  const response = await fetch(asset.url, {
    headers: { 'User-Agent': 'ClashNova-build-script' },
    signal: AbortSignal.timeout(300000),
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`资产下载失败: HTTP ${response.status} (${asset.asset})`)
  }

  const handle = await open(file, 'wx')
  const hash = createHash('sha256')
  let size = 0
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > asset.size) throw new Error(`${asset.asset} 超出锁定大小 ${asset.size} bytes`)
      hash.update(chunk)
      await handle.writeFile(chunk)
    }
    const digest = hash.digest('hex')
    if (size !== asset.size || digest !== asset.sha256) {
      throw new Error(`${asset.asset} SHA256/大小校验失败: ${digest}, ${size} bytes`)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** 归档摘要来自官方 release；二进制摘要来自已通过归档校验的解包内容。 */
export async function fetchMihomo({ root, platform, unpack, force = false }) {
  const asset = lock.targets[platform]
  if (!asset) throw new Error(`未锁定的 mihomo 平台: ${platform}`)
  const outFile = path.join(root, 'src-tauri', 'binaries', asset.binary)
  const verified = await matchesBinary(outFile, asset)
  if (verified && !force) {
    if (asset.executable) await chmod(outFile, 0o755)
    console.log(`已校验 ${path.relative(root, outFile)} (内核 ${lock.version}, SHA256 匹配)`)
    return { path: outFile, downloaded: false }
  }

  const tempRoot = path.join(root, '.tmp')
  await mkdir(tempRoot, { recursive: true })
  const tempDir = await mkdtemp(path.join(tempRoot, 'mihomo-'))
  const archiveFile = path.join(tempDir, asset.asset)
  const stagedFile = path.join(tempDir, asset.binary)
  try {
    console.log(`下载锁定内核 ${lock.version}: ${asset.asset} (${(asset.size / 1048576).toFixed(1)} MB) ...`)
    await downloadArchive(asset, archiveFile)
    const binary = await unpack(await readFile(archiveFile), asset)
    const digest = createHash('sha256').update(binary).digest('hex')
    if (binary.byteLength !== asset.binarySize || digest !== asset.binarySha256) {
      throw new Error(`${asset.binary} 解包内容校验失败: ${digest}, ${binary.byteLength} bytes`)
    }

    const handle = await open(stagedFile, 'wx', asset.executable ? 0o755 : 0o644)
    try {
      await handle.writeFile(binary)
      if (asset.executable) await handle.chmod(0o755)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await mkdir(path.dirname(outFile), { recursive: true })
    // 临时文件与目标都在项目所在文件系统；rename 失败时保留原文件，不先删除目标。
    await rename(stagedFile, outFile)
    console.log(`完成: ${path.relative(root, outFile)} (内核 ${lock.version}, 归档和二进制 SHA256 均匹配)`)
    return { path: outFile, downloaded: true }
  } finally {
    // 只删除本次 mkdtemp 创建目录中的两个已知临时文件，不做递归清理。
    await rm(archiveFile, { force: true })
    await rm(stagedFile, { force: true })
    await rmdir(tempDir)
  }
}
