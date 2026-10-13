import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { deferred, loadSource, plain, tick } from '../helpers.mjs'

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

function apiFixture(call, fetch, coreStatus = async () => ({ running: true })) {
  return loadSource('src/services/api.ts', {
    './ipc': { isMock: false, call: (command, args) => command === 'core_status' ? coreStatus() : call(command, args) },
    './mock': { mockSettings: () => ({ secret: '' }) },
  }, { fetch }).module
}


test('REST sends no requests to a local listener while the core is stopped', async () => {
  let running = false, requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"version":"fixture"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const api = apiFixture(async () => ({ externalController: '127.0.0.1:' + server.address().port, secret: '' }), fetch, async () => ({ running }))
    await assert.rejects(api.getVersion(), /内核未运行/)
    assert.equal(requests, 0)
    running = true
    assert.equal((await api.getVersion()).version, 'fixture')
    assert.equal(requests, 1)
    running = false
    await assert.rejects(api.getVersion(), /内核未运行/)
    assert.equal(requests, 1)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('REST rejects unconfirmed core status and stale pending status checks before fetch', async () => {
  const status = deferred()
  let requests = 0
  const api = apiFixture(async () => ({ externalController: '127.0.0.1:9097', secret: '' }), async () => {
    requests += 1
    return { ok: true, status: 200, text: async () => '{"version":"fixture"}' }
  }, () => status.promise)
  const request = api.getVersion()
  const rejected = assert.rejects(request, { name: 'AbortError' })
  await tick()
  api.configureApi('127.0.0.1:9098', '')
  status.resolve({ running: true })
  await rejected
  assert.equal(requests, 0)
  assert.equal((await api.getVersion()).version, 'fixture')
  assert.equal(requests, 1)

  const unavailable = apiFixture(async () => ({ externalController: '127.0.0.1:9097', secret: '' }), async () => { requests += 1 }, async () => { throw new Error('status unavailable') })
  await assert.rejects(unavailable.getVersion(), /status unavailable/)
  assert.equal(requests, 1)
})

test('4096 delay calls deduplicate 2048 nodes and retain the concurrency budget after failures', async () => {
  let active = 0, peak = 0, requests = 0
  const api = apiFixture(async () => ({ externalController: '127.0.0.1:9097', secret: '' }), async (url) => {
    requests += 1
    active += 1
    peak = Math.max(peak, active)
    await tick()
    active -= 1
    const index = Number(new URL(url).pathname.match(/node-(\d+)/)[1])
    return { ok: index % 17 !== 0, status: index % 17 === 0 ? 503 : 200, text: async () => '{"delay":12}' }
  })
  const nodes = Array.from({ length: 2048 }, (_, i) => 'node-' + i)
  const results = await Promise.allSettled([...nodes, ...nodes].map((name) => api.testDelay(name)))
  assert.equal(requests, 2048)
  assert.equal(peak, 8)
  assert.equal(active, 0)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 242)
  assert.equal(await api.testDelay('node-1'), 12)
  assert.equal(requests, 2049)
})

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

test('group delay forwards custom URL and timeout, drops timed-out members and maps 504 to empty', async () => {
  const urls = []
  let status = 200
  const api = apiFixture(async () => ({ externalController: '127.0.0.1:9097', secret: '' }), async (url) => {
    urls.push(url)
    return { ok: status === 200, status, text: async () => '{"HK":42,"JP":0,"SG":"bad"}' }
  })
  assert.deepEqual(plain(await api.testGroupDelay('Auto 组', 3000, 'https://cp.cloudflare.com/')), { HK: 42 })
  const sent = new URL(urls[0])
  assert.equal(sent.pathname, '/group/Auto%20%E7%BB%84/delay')
  assert.equal(sent.searchParams.get('timeout'), '3000')
  assert.equal(sent.searchParams.get('url'), 'https://cp.cloudflare.com/')
  status = 504
  assert.deepEqual(plain(await api.testGroupDelay('Auto 组')), {})
  status = 404
  await assert.rejects(api.testGroupDelay('missing'), /HTTP 404/)
  await api.testDelay('HK', 1500, 'http://example.test/204').catch(() => {})
  const single = new URL(urls[urls.length - 1])
  assert.equal(single.searchParams.get('timeout'), '1500')
  assert.equal(single.searchParams.get('url'), 'http://example.test/204')
})

test('closing group connections deletes only matching chains and never rejects', async () => {
  const deleted = []
  let failSnapshot = false
  const api = apiFixture(async () => ({ externalController: '127.0.0.1:9097', secret: '' }), async (url, options) => {
    const { pathname } = new URL(url)
    if (options.method === 'DELETE') {
      deleted.push(decodeURIComponent(pathname.slice('/connections/'.length)))
      return { ok: pathname.endsWith('c3'), status: pathname.endsWith('c3') ? 204 : 500, text: async () => '' }
    }
    if (failSnapshot) return { ok: false, status: 500, text: async () => '' }
    return { ok: true, status: 200, text: async () => JSON.stringify({ connections: [
      { id: 'c1', chains: ['HK', 'Proxy'] },
      { id: 'c2', chains: ['DIRECT'] },
      { id: 'c3', chains: ['JP', 'Streaming', 'Proxy'] },
      { id: 'c4', chains: 'Proxy' },
    ] }) }
  })
  await api.closeGroupConnections('Proxy')
  assert.deepEqual(deleted.sort(), ['c1', 'c3'])
  failSnapshot = true
  await api.closeGroupConnections('Proxy')
  assert.equal(deleted.length, 2)
})

test('REST timeout aborts the request and always clears its timer', async () => {
  const timers = [], cleared = []
  const { module: api } = loadSource('src/services/api.ts', {
    './ipc': { isMock: false, call: async (command) => command === 'core_status' ? { running: true } : { externalController: '127.0.0.1:9097', secret: '' } },
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
    './ipc': { isMock: false, call: async () => ({ running: true }) }, './mock': {},
    './api': { apiConfig: () => ({ baseUrl: 'http://127.0.0.1:9097', secret: '' }), ensureConfigured: () => configured.promise },
  }, { WebSocket: Socket })
  const release = module.subscribeLogs(() => {}, 'debug', (status) => statuses.push(status))
  try {
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
  } finally { release() }
})

test('WebSocket skips stopped cores, resumes after startup and ignores disposed status checks', async () => {
  let running = false, pending = false, timerId = 0
  const coreReady = deferred(), sockets = [], timers = new Map()
  class Socket {
    constructor() { sockets.push(this) }
    close() { this.onclose?.() }
  }
  const { module } = loadSource('src/services/ws.ts', {
    './ipc': { isMock: false, call: async (command) => {
      assert.equal(command, 'core_status')
      return pending ? coreReady.promise : { running }
    } },
    './mock': {},
    './api': { apiConfig: () => ({ baseUrl: 'http://127.0.0.1:9097', secret: '' }), ensureConfigured: async () => {} },
  }, {
    WebSocket: Socket,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId },
    clearTimeout: id => timers.delete(id),
  })
  const retry = () => {
    const [id, callback] = timers.entries().next().value
    timers.delete(id)
    callback()
  }
  const release = module.subscribeMemory(() => {})
  try {
    await tick()
    assert.equal(sockets.length, 0)
    assert.equal(timers.size, 1)
    running = true
    retry()
    await tick()
    assert.equal(sockets.length, 1)
    running = false
    sockets[0].close()
    retry()
    await tick()
    assert.equal(sockets.length, 1)
    release()
    assert.equal(timers.size, 0)

    pending = true
    const releasePending = module.subscribeMemory(() => {})
    await tick()
    releasePending()
    coreReady.resolve({ running: true })
    await tick()
    assert.equal(sockets.length, 1)
    assert.equal(timers.size, 0)
  } finally { release() }
})
