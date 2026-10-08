import test from 'node:test'
import assert from 'node:assert/strict'
import { deferred, loadSource, tick } from '../helpers.mjs'

test('global task queue deduplicates and releases slots after failure', async () => {
  const { createTaskQueue } = loadSource('src/utils/taskQueue.ts').module
  const queue = createTaskQueue(2)
  const first = deferred(), second = deferred()
  let started = 0
  const a = queue('a', () => { started += 1; return first.promise })
  const duplicate = queue('a', async () => { throw new Error('duplicate ran') })
  const b = queue('b', () => { started += 1; return second.promise })
  const rejected = assert.rejects(b, /injected/)
  const c = queue('c', async () => { started += 1; return 3 })
  await tick()
  assert.equal(a, duplicate)
  assert.equal(started, 2)
  second.reject(new Error('injected'))
  await rejected
  assert.equal(await c, 3)
  first.resolve(1)
  assert.equal(await a, 1)
  assert.equal(started, 3)
})

function apiFixture(call, fetch) {
  return loadSource('src/services/api.ts', {
    './ipc': { isMock: false, call },
    './mock': { mockSettings: () => ({ secret: '' }) },
  }, { fetch }).module
}

test('API setup is single-flight and configuration changes cancel old requests', async () => {
  const settings = deferred()
  let loads = 0
  const pending = []
  const api = apiFixture(async () => { loads += 1; return settings.promise }, (url, options) => {
    pending.push({ url, options })
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  })
  const one = api.ensureConfigured(), two = api.ensureConfigured()
  assert.equal(loads, 1)
  settings.resolve({ externalController: '127.0.0.1:9097', secret: '' })
  await Promise.all([one, two])
  const request = api.getVersion()
  const rejected = assert.rejects(request, { name: 'AbortError' })
  await tick()
  assert.equal(pending.length, 1)
  api.configureApi('127.0.0.1:9098', '')
  await rejected
  assert.equal(pending[0].options.signal.aborted, true)
})

test('simultaneous group and node delay tests share an eight-request budget', async () => {
  let active = 0, peak = 0, requests = 0
  const api = apiFixture(async () => ({ externalController: '127.0.0.1:9097', secret: '' }), async () => {
    requests += 1
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 8))
    active -= 1
    return { ok: true, status: 200, text: async () => '{"delay":12}' }
  })
  const results = await Promise.all([...Array.from({ length: 20 }, (_, i) => api.testDelay(`node-${i}`)), api.testDelay('node-0')])
  assert.equal(requests, 20)
  assert.equal(peak, 8)
  assert.ok(results.every((value) => value === 12))
})

test('REST timeout aborts the request and always clears its timer', async () => {
  const timers = [], cleared = []
  const { module: api } = loadSource('src/services/api.ts', {
    './ipc': { isMock: false, call: async () => ({ externalController: '127.0.0.1:9097', secret: '' }) },
    './mock': { mockSettings: () => ({ secret: '' }) },
  }, {
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
    clearTimeout: (id) => cleared.push(id),
    fetch: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')))),
  })
  const request = api.getVersion()
  const rejected = assert.rejects(request, { name: 'AbortError' })
  await tick()
  assert.equal(timers[0].delay, 10_000)
  timers[0].callback()
  await rejected
  assert.deepEqual(cleared, [1])
})

test('WebSocket waits for configuration and closes while hidden', async () => {
  const configured = deferred(), sockets = [], statuses = []
  class Socket {
    constructor(url) { this.url = url; sockets.push(this) }
    close() { this.closed = true; this.onclose?.() }
  }
  const { module, environment } = loadSource('src/services/ws.ts', {
    './ipc': { isMock: false }, './mock': {},
    './api': { apiConfig: () => ({ baseUrl: 'http://127.0.0.1:9097', secret: '' }), ensureConfigured: () => configured.promise },
  }, { WebSocket: Socket })
  const release = module.subscribeLogs(() => {}, 'debug', (status) => statuses.push(status))
  assert.equal(sockets.length, 0)
  configured.resolve()
  await tick()
  assert.match(sockets[0].url, /level=debug/)
  sockets[0].onopen()
  assert.equal(statuses.at(-1), 'connected')
  environment.document.hidden = true
  environment.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(sockets[0].closed, true)
  assert.equal(statuses.at(-1), 'paused')
  release()
})
