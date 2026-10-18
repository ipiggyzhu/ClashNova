import test from 'node:test'
import assert from 'node:assert/strict'
import { deferred, loadSource, tick, plain } from '../helpers.mjs'

function appFixture(save) {
  const base = { theme: 'dark', language: 'zh', enableDns: false, dnsOverride: '', externalController: '127.0.0.1:9097', secret: '' }
  let persisted = { ...base }
  const dns = loadSource('src/utils/dnsOverride.ts').module
  const loaded = loadSource('src/stores/app.ts', {
    '../services/api': { configureApi() {}, getRuntimeConfigs: async () => ({ mode: 'rule' }), getVersion: async () => ({ version: 'fixture' }) },
    '../services/ipc': { call: async (command, args) => {
      if (command === 'patch_settings') {
        await save({ ...persisted, ...args.patch }, args.patch)
        persisted = { ...persisted, ...args.patch }
        return { ...persisted }
      }
      if (command === 'get_settings') return { ...persisted }
      if (command === 'core_status') return { running: false, version: 'fixture', uptimeSec: 0, memoryBytes: 0 }
      if (command === 'check_update') return null
    } },
    '../services/mock': { DEFAULT_SETTINGS: base }, '../utils/dnsOverride': dns,
  })
  return { ...loaded, store: loaded.module.useAppStore, changeNative: (patch) => { persisted = { ...persisted, ...patch } } }
}

test('later settings patch survives an earlier rejected save', async () => {
  const first = deferred()
  const saves = []
  const { store } = appFixture(async (settings) => {
    saves.push({ theme: settings.theme, language: settings.language })
    if (saves.length === 1) await first.promise
  })
  await store.getState().loadAll()
  const a = store.getState().patchSettings({ language: 'en' })
  const rejected = assert.rejects(a, /first save failed/)
  await tick()
  const b = store.getState().patchSettings({ theme: 'light' })
  first.reject(new Error('first save failed'))
  await Promise.all([rejected, b])
  assert.equal(store.getState().settings.theme, 'light')
  assert.equal(store.getState().settings.language, 'zh')
  assert.deepEqual(saves, [{ theme: 'dark', language: 'en' }, { theme: 'light', language: 'zh' }])
})

test('system theme follows OS changes and unsubscribes cleanly', async () => {
  const { store, media, module, environment } = appFixture(async () => {})
  await store.getState().setTheme('system')
  const release = module.watchSystemTheme()
  media.matches = true
  media.dispatchEvent(new Event('change'))
  assert.equal(store.getState().resolvedTheme, 'light')
  assert.equal(environment.document.documentElement.dataset.theme, 'light')
  release()
  media.matches = false
  media.dispatchEvent(new Event('change'))
  assert.equal(store.getState().resolvedTheme, 'light')
})

test('settings intents preserve concurrent native changes to other fields', async () => {
  const saving = deferred()
  let submitted
  const { store, changeNative } = appFixture(async (_settings, patch) => {
    submitted = plain(patch)
    await saving.promise
  })
  await store.getState().loadAll()
  const operation = store.getState().patchSettings({ theme: 'light' })
  await tick()
  changeNative({ language: 'en' })
  await store.getState().loadAll()
  saving.resolve()
  await operation
  assert.equal(submitted.language, undefined)
  assert.equal(store.getState().settings.theme, 'light')
  assert.equal(store.getState().settings.language, 'en')
})

test('live transports are reference-counted per requested stream', () => {
  const started = [], stopped = []
  const subscribe = (stream) => () => { started.push(stream); return () => stopped.push(stream) }
  const { module } = loadSource('src/stores/live.ts', { '../services/ws': {
    subscribeTraffic: subscribe('traffic'), subscribeConnections: subscribe('connections'),
    subscribeMemory: subscribe('memory'), subscribeLogs: subscribe('logs'),
  } })
  const sidebar = module.startLiveStreams(['memory'])
  const dashboard = module.startLiveStreams(['traffic', 'connections', 'memory'])
  assert.deepEqual(started, ['memory', 'traffic', 'connections'])
  dashboard()
  assert.deepEqual(stopped, ['traffic', 'connections'])
  sidebar(); sidebar()
  assert.deepEqual(stopped, ['traffic', 'connections', 'memory'])
})

test('log bursts batch notifications, cap storage, and keep stable unique IDs', async () => {
  const { module } = loadSource('src/stores/live.ts', { '../services/ws': {} })
  const store = module.useLiveStore
  let updates = 0
  const release = store.subscribe(() => { updates += 1 })
  for (let i = 0; i < 1200; i += 1) store.getState().pushLog({ type: 'debug', payload: `line ${i}`, time: '12:00:00' })
  assert.equal(updates, 0)
  await new Promise((resolve) => setTimeout(resolve, 140))
  assert.equal(updates, 1)
  assert.equal(store.getState().logs.length, module.LOG_CAPACITY)
  const ids = store.getState().logs.map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length)
  store.getState().pushLog({ type: 'info', payload: 'pending', time: '12:00:01' })
  store.getState().clearLogs()
  await new Promise((resolve) => setTimeout(resolve, 140))
  assert.deepEqual(plain(store.getState().logs), [])
  release()
})

test('log transport uses the selected minimum level and defaults to info', () => {
  const levels = []
  const { module } = loadSource('src/stores/live.ts', { '../services/ws': {
    subscribeLogs: (_onLog, level) => { levels.push(level); return () => {} },
  } })
  for (const level of [undefined, 'warning', 'debug', 'silent']) {
    const release = module.startLiveStreams(['logs'], level)
    release()
  }
  assert.deepEqual(levels, ['info', 'warning', 'debug', 'silent'])
})

test('closed connection history ignores baselines and disconnect snapshots, dedupes revived IDs and caps size', () => {
  const { module } = loadSource('src/stores/live.ts', { '../services/ws': {
    subscribeTraffic: () => () => {}, subscribeConnections: () => () => {},
    subscribeMemory: () => () => {}, subscribeLogs: () => () => {},
  } })
  const store = module.useLiveStore
  const conn = (id) => ({ id, metadata: { host: `${id}.test`, network: 'tcp' }, chains: ['DIRECT'], upload: 1, download: 2, start: '2026-10-10T00:00:00Z', curUp: 5, curDown: 6 })
  const snap = (...ids) => ({ uploadTotal: 10, downloadTotal: 20, connections: ids.map(conn) })
  const closedIds = () => plain(store.getState().closedConnections.map((c) => c.id))
  const release = module.startLiveStreams(['connections'])

  store.getState().setConnections(snap('a', 'b', 'c'))
  assert.deepEqual(closedIds(), [], 'first snapshot only sets the baseline')
  store.getState().setConnections(snap('a', 'c', 'd'))
  assert.deepEqual(closedIds(), ['b'])
  const closed = store.getState().closedConnections[0]
  assert.equal(closed.curUp, 0)
  assert.equal(typeof closed.closedAt, 'number')

  store.getState().setConnections({ uploadTotal: 0, downloadTotal: 0, connections: [] })
  assert.deepEqual(closedIds(), ['b'], 'disconnect snapshot is not treated as closing everything')
  store.getState().setConnections(snap('b', 'x'))
  assert.deepEqual(closedIds(), [], 'reconnect sets a new baseline and drops revived IDs')
  store.getState().setConnections(snap('x'))
  assert.deepEqual(closedIds(), ['b'])

  release()
  const again = module.startLiveStreams(['connections'])
  store.getState().setConnections(snap('y'))
  assert.deepEqual(closedIds(), ['b'], 'resubscribing starts from a fresh baseline')

  const many = Array.from({ length: module.CLOSED_CAPACITY + 50 }, (_, i) => `m${i}`)
  store.getState().setConnections(snap(...many))
  store.getState().setConnections(snap())
  assert.equal(store.getState().closedConnections.length, module.CLOSED_CAPACITY)
  store.getState().clearClosedConnections()
  assert.deepEqual(closedIds(), [])
  again()
})

test('notification buffer bounds unread count after eviction', () => {
  const { useNotificationStore } = loadSource('src/stores/notifications.ts').module
  for (let i = 0; i < 250; i += 1) useNotificationStore.getState().add('info', `notice ${i}`, '')
  const current = useNotificationStore.getState()
  assert.equal(current.notifications.length, 200)
  assert.equal(current.unreadCount, 200)
  current.markAllAsRead()
  assert.equal(useNotificationStore.getState().unreadCount, 0)
})
