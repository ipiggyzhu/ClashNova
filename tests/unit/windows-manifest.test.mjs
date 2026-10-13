import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createUpdateManifest } from '../../scripts/windows-update-manifest.mjs'
import { root } from '../helpers.mjs'

test('Windows update manifest hashes final installer bytes and locks build identity', async () => {
  await mkdir(path.join(root, '.tmp'), { recursive: true })
  const dir = await mkdtemp(path.join(root, '.tmp/manifest-test-'))
  try {
    const file = path.join(dir, 'ClashNova_2.4.8_x64-setup.exe')
    const bytes = Buffer.alloc(4096, 42)
    await writeFile(file, bytes)
    const manifest = await createUpdateManifest(file, '2.4.8', 'a'.repeat(40))
    assert.deepEqual(manifest, { schema: 1, version: '2.4.8', buildId: 'a'.repeat(40), assetName: path.basename(file), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    await writeFile(file, Buffer.concat([bytes, Buffer.from('final signature')]))
    assert.notEqual((await createUpdateManifest(file, '2.4.8', 'a'.repeat(40))).sha256, manifest.sha256)
    await assert.rejects(createUpdateManifest(file, '2.4.8', 'dev'), /commit/)
    await assert.rejects(createUpdateManifest(file, '2.4.9', 'a'.repeat(40)), /filename/)
    await writeFile(file, 'MZ')
    await assert.rejects(createUpdateManifest(file, '2.4.8', 'a'.repeat(40)), /truncated/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
