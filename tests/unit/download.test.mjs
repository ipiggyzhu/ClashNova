import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { root } from '../helpers.mjs'

const archive = Buffer.from('fixture archive')
const binary = Buffer.from('fixture verified binary')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const fixtureLock = { version: 'fixture', targets: { fixture: {
  asset: 'fixture.zip', url: 'https://download.invalid/fixture.zip', size: archive.length, sha256: sha256(archive),
  binary: 'fixture.exe', binarySize: binary.length, binarySha256: sha256(binary),
} } }
const source = await readFile(path.join(root, 'scripts/fetch-mihomo-common.mjs'), 'utf8')
const declaration = "const lock = JSON.parse(await readFile(new URL('./mihomo.lock.json', import.meta.url), 'utf8'))"
assert.ok(source.includes(declaration), 'lock fixture injection must match the production declaration')
const { fetchMihomo } = await import(`data:text/javascript;base64,${Buffer.from(source.replace(declaration, `const lock = ${JSON.stringify(fixtureLock)}`)).toString('base64')}`)

async function fixture(t) {
  const temp = path.join(root, '.tmp')
  await mkdir(temp, { recursive: true })
  const directory = await mkdtemp(path.join(temp, 'unit-download-'))
  const parent = path.join(directory, 'src-tauri/binaries')
  const output = path.join(parent, 'fixture.exe')
  await mkdir(parent, { recursive: true })
  const originalFetch = globalThis.fetch
  t.after(async () => {
    globalThis.fetch = originalFetch
    // 仅删除刚创建且已核对位置的已知文件/空目录，不递归删除工作区。
    assert.ok((await realpath(directory)).startsWith(`${await realpath(temp)}${path.sep}`))
    for (const file of [path.join(output, 'keep.txt'), output]) {
      await unlink(file).catch((error) => { if (!['ENOENT', 'ENOTDIR', 'EPERM', 'EISDIR'].includes(error.code)) throw error })
    }
    for (const folder of [output, parent, path.dirname(parent), path.join(directory, '.tmp'), directory]) {
      await rmdir(folder).catch((error) => { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error })
    }
  })
  return { directory, output, run: (unpack = () => binary) => fetchMihomo({ root: directory, platform: 'fixture', unpack }) }
}

test('download verifies existing bytes rather than trusting existence or size', async (t) => {
  const { run, directory, output } = await fixture(t)
  let requests = 0
  globalThis.fetch = async () => { requests += 1; return new Response(archive) }
  assert.equal((await run()).downloaded, true)
  assert.equal((await run()).downloaded, false)
  assert.equal(requests, 1)
  await writeFile(output, Buffer.alloc(binary.length))
  assert.equal((await run()).downloaded, true)
  assert.equal(requests, 2)
  assert.deepEqual(await readFile(output), binary)
  assert.deepEqual(await readdir(path.join(directory, '.tmp')), [])
})

test('bad archive digest leaves old binary unchanged and removes staging files', async (t) => {
  const { run, directory, output } = await fixture(t)
  const previous = Buffer.from('previous binary')
  await writeFile(output, previous)
  globalThis.fetch = async () => new Response(Buffer.alloc(archive.length))
  await assert.rejects(run(), /SHA256\/大小校验失败/)
  assert.deepEqual(await readFile(output), previous)
  assert.deepEqual(await readdir(path.join(directory, '.tmp')), [])
})

test('unpacked binary must match the separately locked digest', async (t) => {
  const { run, output } = await fixture(t)
  await writeFile(output, 'previous')
  globalThis.fetch = async () => new Response(archive)
  await assert.rejects(run(() => Buffer.alloc(binary.length)), /解包内容校验失败/)
  assert.equal(await readFile(output, 'utf8'), 'previous')
})

test('HTTP failure and oversized archive retain the original target', async (t) => {
  const { run, output } = await fixture(t)
  await writeFile(output, 'previous')
  globalThis.fetch = async () => new Response('unavailable', { status: 503 })
  await assert.rejects(run(), /HTTP 503/)
  globalThis.fetch = async () => new Response(Buffer.alloc(archive.length + 1))
  await assert.rejects(run(), /超出锁定大小/)
  assert.equal(await readFile(output, 'utf8'), 'previous')
})

test('rename failure never pre-deletes an existing target', async (t) => {
  const { run, output } = await fixture(t)
  await mkdir(output)
  await writeFile(path.join(output, 'keep.txt'), 'preserved')
  globalThis.fetch = async () => new Response(archive)
  await assert.rejects(run(), /EISDIR|EPERM|EEXIST/)
  assert.equal(await readFile(path.join(output, 'keep.txt'), 'utf8'), 'preserved')
})
