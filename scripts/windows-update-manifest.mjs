import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 必须在安装包最终签名之后调用，摘要覆盖最终发布字节。 */
export async function createUpdateManifest(assetPath, version, buildId) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/i.test(buildId ?? '')) {
    throw new Error('A stable version and full 40-character build commit are required')
  }
  const assetName = path.basename(assetPath)
  if (assetName !== `ClashNova_${version}_x64-setup.exe`) throw new Error('Unexpected Windows installer filename')
  const info = await stat(assetPath)
  if (!info.isFile() || info.size < 4096) throw new Error('Missing or truncated Windows installer')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(assetPath)) hash.update(chunk)
  return { schema: 1, version, buildId: buildId.toLowerCase(), assetName, sha256: hash.digest('hex'), size: info.size }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  const { version } = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  const directory = path.join(root, 'target/release/bundle/nsis')
  const manifest = await createUpdateManifest(path.join(directory, `ClashNova_${version}_x64-setup.exe`), version, process.env.GITHUB_SHA)
  const filename = `ClashNova_${version}_windows-build.json`
  await writeFile(path.join(directory, filename), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Verified Windows build manifest: ${filename}`)
}
