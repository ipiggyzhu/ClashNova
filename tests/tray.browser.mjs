import assert from 'node:assert/strict'

export async function runTrayBrowser(browser, base) {
  const context = await browser.newContext({ viewport: { width: 368, height: 600 } })
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let passed = 0, failed = 0
  const check = async (name, action) => {
    try { await action(); passed++; console.log('PASS ' + name) }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + (error.stack ?? error)) }
  }
  const visit = async () => {
    await page.goto(base + '/tray', { waitUntil: 'networkidle' })
    await page.locator('.tray-panel').waitFor()
    await page.getByLabel('切换配置', { exact: true }).waitFor()
  }
  const reload = () => page.getByRole('button', { name: '刷新', exact: true }).click()

  try {
    await check('tray_is_a_standalone_compact_panel_with_live_metrics', async () => {
      await visit()
      assert.equal(await page.locator('.sidebar, .topbar').count(), 0)
      await page.waitForFunction(() => document.querySelectorAll('.tray-plots svg').length === 2)
      const streams = await page.evaluate(async () => (await import('/src/stores/live.ts')).useLiveStore.getState().status)
      assert.deepEqual(streams, { traffic: 'connected', connections: 'connected', memory: 'connected', logs: 'disconnected' })
      assert.ok(await page.getByText('内核内存', { exact: true }).isVisible())
      assert.equal(await page.locator('.tray-root').evaluate(node => node.scrollWidth > node.clientWidth), false)
    })

    await check('tray_switches_mode_proxy_and_tun_and_rolls_back_failures', async () => {
      await visit()
      await page.getByRole('button', { name: '全局', exact: true }).click()
      await page.waitForFunction(async () => (await import('/src/services/ipc.ts')).call('get_settings').then(s => s.mode === 'global'))
      await page.waitForFunction(() => document.querySelector('.tray-panel .seg button:last-child')?.getAttribute('aria-pressed') === 'true')
      await page.getByRole('switch', { name: '系统代理', exact: true }).click()
      await page.waitForFunction(async () => (await import('/src/services/ipc.ts')).call('get_settings').then(s => !s.sysProxy))
      await page.evaluate(async () => {
        const { mockHandlers } = await import('/src/services/mock.ts')
        mockHandlers.set_tun = () => { throw new Error('fixture-tun-failed') }
      })
      await page.getByRole('switch', { name: 'TUN 模式', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: 'fixture-tun-failed' }).waitFor()
      assert.equal(await page.getByRole('switch', { name: 'TUN 模式', exact: true }).getAttribute('aria-checked'), 'false')
    })

    await check('tray_quota_tracks_profile_switch_and_never_invents_local_quota', async () => {
      await visit()
      await page.evaluate(async () => {
        const { mockHandlers } = await import('/src/services/mock.ts')
        window.__trayProfile = 'remote'
        mockHandlers.list_profiles = () => [
          { id: 'remote', name: 'remote-fixture', kind: 'remote', current: window.__trayProfile === 'remote', updatedAt: 1, quota: { used: 600, total: 500, expireAt: 1 } },
          { id: 'local', name: 'local-fixture', kind: 'local', current: window.__trayProfile === 'local', updatedAt: 1 },
        ]
        mockHandlers.select_profile = ({ id }) => { window.__trayProfile = id }
      })
      await reload()
      const quota = page.getByRole('progressbar', { name: '订阅用量', exact: true })
      await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '100')
      assert.equal(await quota.getAttribute('aria-valuenow'), '100')
      assert.ok(await page.getByText('已过期', { exact: true }).isVisible())
      await page.getByLabel('切换配置', { exact: true }).selectOption('local')
      await page.waitForFunction(() => document.querySelector('.tray-profile select')?.value === 'local')
      assert.equal(await page.locator('.tray-quota').count(), 0)
    })

    await check('tray_only_mutates_selectable_groups_and_reports_selection_failure', async () => {
      await page.route('**/src/services/api.ts*', async route => {
        const response = await route.fetch()
        const source = await response.text()
        assert.ok(source.includes('mockSelectProxy(group, name)'))
        await route.fulfill({ response, body: source.replace('mockSelectProxy(group, name)', 'if (window.__trayRejectSelection) throw new Error("fixture-selection-failed"); mockSelectProxy(group, name)') })
      })
      await visit()
      const selector = page.locator('.tray-group select:not([disabled])').first()
      await selector.waitFor()
      const label = await selector.getAttribute('aria-label')
      const previous = await selector.inputValue()
      const next = await selector.locator('option').evaluateAll((nodes, current) => nodes.map(node => node.value).find(value => value !== current), previous)
      assert.ok(next)
      await selector.selectOption(next)
      await page.waitForFunction(({ label, value }) => Array.from(document.querySelectorAll('.tray-group select')).some(node => node.getAttribute('aria-label') === label && node.value === value && !node.disabled), { label, value: next })
      await page.evaluate(() => { window.__trayRejectSelection = true })
      await page.getByLabel(label, { exact: true }).selectOption(previous)
      await page.getByRole('alert').filter({ hasText: 'fixture-selection-failed' }).waitFor()
      await page.waitForFunction(({ label, value }) => Array.from(document.querySelectorAll('.tray-group select')).some(node => node.getAttribute('aria-label') === label && node.value === value && !node.disabled), { label, value: next })
      for (const group of await page.locator('.tray-group[data-type="Fallback"], .tray-group[data-type="LoadBalance"]').all()) {
        assert.ok(await group.locator('select').isDisabled())
      }
      await page.unroute('**/src/services/api.ts*')
    })

    await check('tray_deduplicates_core_actions_and_is_usable_when_core_stopped', async () => {
      await visit()
      await page.evaluate(async () => {
        const { mockHandlers } = await import('/src/services/mock.ts')
        window.__trayStarts = 0
        mockHandlers.core_status = () => ({ running: false, version: '', uptimeSec: 0, memoryBytes: 0 })
        mockHandlers.start_core = () => {
          window.__trayStarts++
          return new Promise(resolve => { window.__trayFinishStart = resolve })
        }
      })
      await reload()
      const start = page.getByRole('button', { name: '启动内核', exact: true })
      await start.click()
      await page.waitForFunction(() => Boolean(window.__trayFinishStart))
      assert.equal(await page.evaluate(() => window.__trayStarts), 1)
      assert.ok(await page.getByRole('switch', { name: '系统代理', exact: true }).isDisabled())
      await page.evaluate(() => window.__trayFinishStart())
      await start.waitFor()
      await page.getByText('内核未运行，启动后可切换策略组', { exact: true }).waitFor()
    })

    await check('tray_hidden_panel_releases_streams_and_reloads_on_show', async () => {
      await visit()
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await page.locator('.tray-panel').waitFor({ state: 'detached' })
      const streams = await page.evaluate(async () => (await import('/src/stores/live.ts')).useLiveStore.getState().status)
      assert.ok(Object.values(streams).every(value => value === 'disconnected'))
      await page.evaluate(() => {
        delete document.hidden
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await page.locator('.tray-panel').waitFor()
      await page.getByLabel('切换配置', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await page.locator('.tray-panel').waitFor({ state: 'detached' })
    })

    await check('tray_theme_language_and_keyboard_controls_fit_small_viewports', async () => {
      await visit()
      for (const theme of ['light', 'dark']) {
        await page.evaluate(async value => (await import('/src/stores/app.ts')).useAppStore.getState().patchSettings({ theme: value, language: 'en' }), theme)
        await page.getByRole('button', { name: 'Open main window', exact: true }).waitFor()
        const style = await page.locator('.tray-panel').evaluate(node => ({ radius: parseFloat(getComputedStyle(node).borderTopLeftRadius), overflow: node.scrollWidth > node.clientWidth }))
        assert.ok(style.radius >= 14)
        assert.equal(style.overflow, false)
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme)
      }
      await page.setViewportSize({ width: 300, height: 360 })
      assert.equal(await page.locator('.tray-root').evaluate(node => node.scrollWidth > node.clientWidth), false)
      assert.ok(await page.getByRole('button', { name: 'Open main window', exact: true }).isVisible())
    })
    await check('tray_native_events_ignore_stale_visibility_and_suspend_polling', async () => {
      const native = await browser.newContext({ viewport: { width: 368, height: 600 } })
      try {
        await native.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
        await native.addInitScript(() => {
          let sequence = 0
          const callbacks = new Map(), listeners = new Map()
          const fixture = window.__trayNative = { calls: {}, pendingVisibility: [], language: 'zh' }
          fixture.events = () => [...listeners.values()].map(listener => listener.event)
          fixture.emitVisibility = payload => {
            for (const [id, listener] of listeners) {
              if (listener.event === 'tray-visibility') callbacks.get(listener.handler)?.({ event: listener.event, id, payload })
            }
          }
          window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
            unregisterListener: (_event, id) => {
              callbacks.delete(listeners.get(id)?.handler)
              listeners.delete(id)
            },
          }
          window.__TAURI_INTERNALS__ = {
            transformCallback: callback => { const id = ++sequence; callbacks.set(id, callback); return id },
            invoke: async (command, args = {}) => {
              fixture.calls[command] = (fixture.calls[command] ?? 0) + 1
              if (command === 'plugin:event|listen') {
                const id = ++sequence
                listeners.set(id, args)
                return id
              }
              if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return }
              if (command === 'tray_panel_visible') return new Promise(resolve => fixture.pendingVisibility.push(resolve))
              if (command === 'core_status') return { running: false, version: '', uptimeSec: 0, memoryBytes: 0 }
              const { mockHandlers, DEFAULT_SETTINGS } = await import('/src/services/mock.ts')
              if (command === 'get_settings') return { ...DEFAULT_SETTINGS, language: fixture.language }
              const handler = mockHandlers[command]
              if (!handler) throw new Error('Unexpected native command: ' + command)
              return handler(args)
            },
          }
        })
        const nativePage = await native.newPage()
        nativePage.on('pageerror', error => errors.push(error.message))
        await nativePage.goto(base + '/tray', { waitUntil: 'networkidle' })
        await nativePage.waitForFunction(() => window.__trayNative.pendingVisibility.length > 0)
        assert.equal(await nativePage.evaluate(async () => (await import('/src/services/ipc.ts')).isMock), false)
        assert.equal(await nativePage.locator('.tray-panel').count(), 0)

        await nativePage.evaluate(() => window.__trayNative.emitVisibility(true))
        await nativePage.getByLabel('切换配置', { exact: true }).waitFor()
        await nativePage.evaluate(() => {
          for (const resolve of window.__trayNative.pendingVisibility.splice(0)) resolve(false)
        })
        await nativePage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        assert.ok(await nativePage.locator('.tray-panel').isVisible(), 'late initial visibility must not overwrite a newer show event')

        await nativePage.evaluate(() => window.__trayNative.emitVisibility(false))
        await nativePage.locator('.tray-panel').waitFor({ state: 'detached' })
        await nativePage.waitForFunction(() => window.__trayNative.events().every(event => event === 'tray-visibility'))
        const before = await nativePage.evaluate(() => ({ settings: window.__trayNative.calls.get_settings, profiles: window.__trayNative.calls.list_profiles }))
        // 等待越过 5 秒轮询周期，验证原生隐藏事件也会取消轮询。
        await nativePage.waitForTimeout(5300)
        assert.deepEqual(await nativePage.evaluate(() => ({ settings: window.__trayNative.calls.get_settings, profiles: window.__trayNative.calls.list_profiles })), before)

        await nativePage.evaluate(() => { window.__trayNative.language = 'en'; window.__trayNative.emitVisibility(true) })
        await nativePage.getByRole('button', { name: 'Open main window', exact: true }).waitFor()
        await nativePage.waitForFunction(count => window.__trayNative.calls.list_profiles > count, before.profiles)
      } finally { await native.close() }
    })

    await check('tray_browser_has_no_page_errors', async () => assert.deepEqual(errors, []))
  } finally { await context.close() }
  return { passed, failed }
}
