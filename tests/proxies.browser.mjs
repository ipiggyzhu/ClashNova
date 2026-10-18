import assert from 'node:assert/strict'

export async function runProxiesBrowser(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname
    return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort()
  })
  await context.addInitScript(() => {
    window.__proxyProfileId = 'profile-a'
    window.__proxyRefreshFails = false
    window.__proxyProbeCalls = []
    window.__groupProbeCalls = 0
    window.__probeDelay = async (args) => { window.__proxyProbeCalls.push(args); return 36 }
    window.__proxyFixture = { proxies: {
      'HK-PCCW': { name: 'HK-PCCW', type: 'Trojan', history: [{ time: '2026-10-18T00:00:00Z', delay: 88 }] },
      'HK-ViuTV': { name: 'HK-ViuTV', type: 'Vless', provider: 'fixture-provider', history: [{ time: '2026-10-18T00:00:00Z', delay: 96 }] },
      Streaming: { name: 'Streaming', type: 'Selector', now: 'HK-PCCW', all: ['HK-PCCW', 'HK-ViuTV'], testUrl: 'https://group.example.invalid/204', history: [] },
      '全部节点': { name: '全部节点', type: 'Selector', now: 'HK-PCCW', all: ['HK-PCCW'], history: [] },
      'virtual:all': { name: 'virtual:all', type: 'Selector', now: 'HK-PCCW', all: ['HK-PCCW'], history: [] },
      GLOBAL: { name: 'GLOBAL', type: 'Selector', now: 'Streaming', all: ['DIRECT', 'virtual:all', 'HK-PCCW', '全部节点', 'Streaming'], history: [] },
    } }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/src/services/api.ts*', async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    await route.fulfill({ response, body: source
      .replace('return mockProxies()', 'if (window.__proxyRefreshFails) throw new Error("fixture proxy refresh failed"); return structuredClone(window.__proxyFixture)')
      .replace('const delay = mockTestDelay(name)', 'const delay = await window.__probeDelay({ name, timeout, url, provider: typeof provider === "undefined" ? undefined : provider })')
      .replace('return mockTestGroupDelay(group, timeout)', 'window.__groupProbeCalls++; return {}') })
  })
  const card = (name) => page.locator('.pg-proxies .card').filter({ has: page.getByRole('heading', { name, exact: true }) })
  async function visit(setup) {
    await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      localStorage.clear()
      const { mockHandlers } = await import('/src/services/mock.ts')
      mockHandlers.list_profiles = () => [{ id: window.__proxyProfileId, name: 'fixture', current: true, kind: 'local', updatedAt: 0 }]
    })
    if (setup) await page.evaluate(setup)
    await page.locator('a[href="/proxies"]').click()
    await page.getByRole('heading', { name: 'Streaming', exact: true }).waitFor()
  }
  let passed = 0, failed = 0
  const check = async (name, action) => {
    try { await action(); passed += 1; console.log(`PASS ${name}`) }
    catch (error) { failed += 1; console.log(`FAIL ${name}: ${error.message}`) }
  }
  try {
    await check('proxies_only_render_real_groups_and_start_collapsed', async () => {
      await visit()
      assert.equal(await page.locator('.pg-proxies .card').count(), 3)
      assert.equal(await page.getByRole('heading', { name: '全部节点', exact: true }).count(), 1)
      assert.equal(await page.locator('.node-grid').count(), 0)
      assert.equal(await card('Streaming').getByRole('button', { name: '展开', exact: true }).getAttribute('aria-expanded'), 'false')
    })

    await check('proxies_keep_configuration_group_order_instead_of_api_map_order', async () => {
      await visit()
      assert.deepEqual(await page.locator('.pg-proxies .card h3').allTextContents(), ['virtual:all', '全部节点', 'Streaming'])
      await page.getByRole('group', { name: '节点排序' }).getByRole('button', { name: '名称', exact: true }).click()
      assert.deepEqual(await page.locator('.pg-proxies .card h3').allTextContents(), ['virtual:all', '全部节点', 'Streaming'])
    })

    await check('proxies_remember_open_groups_per_profile_without_virtual_key_collisions', async () => {
      await visit()
      await card('全部节点').getByRole('button', { name: '展开', exact: true }).click()
      assert.equal(await card('全部节点').locator('.node').count(), 1)
      assert.equal(await card('virtual:all').locator('.node').count(), 0)
      await page.locator('a[href="/settings"]').click()
      await page.locator('a[href="/proxies"]').click()
      await card('全部节点').locator('.node').waitFor()
      await page.evaluate(() => {
        window.__proxyProfileId = 'profile-b'
        window.dispatchEvent(new Event('clashnova-api-config-changed'))
      })
      await page.waitForFunction(() => document.querySelectorAll('.node-grid').length === 0)
      await page.evaluate(() => {
        window.__proxyProfileId = 'profile-a'
        window.dispatchEvent(new Event('clashnova-api-config-changed'))
      })
      await card('全部节点').locator('.node').waitFor()
      assert.equal(await card('virtual:all').locator('.node').count(), 0)
    })

    await check('proxies_keep_open_group_mounted_when_background_refresh_fails', async () => {
      await visit()
      await card('Streaming').getByRole('button', { name: '展开', exact: true }).click()
      await page.evaluate(() => { window.__openGroup = document.querySelector('.node-grid[data-group="Streaming"]') })
      await page.evaluate(() => { window.__proxyRefreshFails = true })
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await page.getByText(/fixture proxy refresh failed/).waitFor()
      assert.equal(await page.evaluate(() => window.__openGroup.isConnected), true)
      assert.equal(await card('Streaming').getByRole('button', { name: '折叠', exact: true }).getAttribute('aria-expanded'), 'true')
      await page.evaluate(() => {
        window.__proxyRefreshFails = false
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await page.getByRole('alert').filter({ hasText: 'fixture proxy refresh failed' }).waitFor({ state: 'hidden' })
      assert.equal(await page.evaluate(() => document.querySelector('.node-grid[data-group="Streaming"]') === window.__openGroup), true)
    })

    await check('proxies_clear_previous_profile_fold_state_when_no_profile_is_selected', async () => {
      await visit()
      await card('Streaming').getByRole('button', { name: '展开', exact: true }).click()
      await page.evaluate(async () => {
        const { mockHandlers } = await import('/src/services/mock.ts')
        mockHandlers.list_profiles = () => []
        window.dispatchEvent(new Event('clashnova-api-config-changed'))
      })
      await page.waitForFunction(() => document.querySelectorAll('.node-grid').length === 0)
    })

    await check('proxies_group_probe_uses_each_member_origin_and_group_url_while_collapsed', async () => {
      await visit()
      await card('Streaming').getByRole('button', { name: '测速', exact: true }).click()
      await card('Streaming').getByRole('button', { name: '测速', exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.__groupProbeCalls), 0)
      const calls = await page.evaluate(() => window.__proxyProbeCalls)
      assert.deepEqual(calls.map((call) => call.name).sort(), ['HK-PCCW', 'HK-ViuTV'])
      assert.ok(calls.every((call) => call.url === 'https://group.example.invalid/204'))
      assert.equal(calls.find((call) => call.name === 'HK-ViuTV').provider, 'fixture-provider')
      assert.equal(await page.locator('.node-grid').count(), 0)
      await card('Streaming').getByRole('button', { name: '展开', exact: true }).click()
      assert.equal(await card('Streaming').getByText('36 ms', { exact: true }).count(), 2)
    })

    await check('proxies_all_probe_deduplicates_shared_members_and_uses_configured_url', async () => {
      await visit(() => { delete window.__proxyFixture.proxies.Streaming.testUrl })
      await page.evaluate(async () => {
        const { useAppStore } = await import('/src/stores/app.ts')
        useAppStore.setState((state) => ({ settings: { ...state.settings, delayTestUrl: 'https://default.example.invalid/204', delayTestTimeout: 7600 } }))
      })
      await page.getByRole('button', { name: '全部测速', exact: true }).click()
      await page.getByRole('button', { name: '全部测速', exact: true }).waitFor()
      const calls = await page.evaluate(() => window.__proxyProbeCalls)
      assert.deepEqual(calls.map((call) => call.name).sort(), ['HK-PCCW', 'HK-ViuTV'])
      assert.ok(calls.every((call) => call.timeout === 7600 && call.url === 'https://default.example.invalid/204'))
    })

    await check('proxies_show_url_specific_history_on_entry_and_after_navigation', async () => {
      await visit(() => {
        const node = window.__proxyFixture.proxies['HK-PCCW']
        node.extra = {
          'https://group.example.invalid/204': { alive: true, history: [{ time: '2026-10-18T01:00:00Z', delay: 23 }] },
        }
      })
      await card('Streaming').getByRole('button', { name: '展开', exact: true }).click()
      await card('Streaming').getByText('23 ms', { exact: true }).waitFor()
      await card('Streaming').getByText('96 ms', { exact: true }).waitFor()
      await page.locator('a[href="/settings"]').click()
      await page.locator('.pg-settings').waitFor()
      await page.locator('a[href="/proxies"]').click()
      await card('Streaming').getByText('23 ms', { exact: true }).waitFor()
      assert.deepEqual(await page.evaluate(() => window.__proxyProbeCalls), [])
    })

    await check('proxies_automatically_fill_missing_delays_without_opening_groups', async () => {
      await visit(() => {
        window.__proxyFixture.proxies['HK-PCCW'].history = []
        window.__proxyFixture.proxies['HK-ViuTV'].history = []
      })
      await page.waitForFunction(() => window.__proxyProbeCalls.some((call) => call.name === 'HK-ViuTV'))
      assert.equal(await page.locator('.node-grid').count(), 0)
      await card('Streaming').getByRole('button', { name: '展开', exact: true }).click()
      await page.waitForFunction(() => [...document.querySelectorAll('.node-grid[data-group="Streaming"] .badge')].filter((node) => node.textContent === '36 ms').length === 2)
      await page.waitForFunction(() => window.__proxyProbeCalls.length === 3)
      const calls = await page.evaluate(() => window.__proxyProbeCalls)
      assert.equal(calls.filter((call) => call.name === 'HK-ViuTV').length, 1)
      assert.ok(calls.every((call) => call.url === 'https://group.example.invalid/204' || call.name === 'HK-PCCW'))
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await page.waitForTimeout(400)
      assert.equal(await page.evaluate(() => window.__proxyProbeCalls.length), calls.length)
    })

    await check('proxies_manual_delays_survive_navigation_and_are_isolated_by_profile', async () => {
      await visit()
      await card('Streaming').getByRole('button', { name: '测速', exact: true }).click()
      await card('Streaming').getByRole('button', { name: '测速', exact: true }).waitFor()
      await card('Streaming').getByRole('button', { name: '展开', exact: true }).click()
      await card('Streaming').getByText('36 ms', { exact: true }).first().waitFor()
      await card('全部节点').getByRole('button', { name: '展开', exact: true }).click()
      await card('全部节点').getByText('88 ms', { exact: true }).waitFor()
      await page.locator('a[href="/settings"]').click()
      await page.locator('.pg-settings').waitFor()
      await page.locator('a[href="/proxies"]').click()
      await card('Streaming').getByText('36 ms', { exact: true }).first().waitFor()
      await page.evaluate(() => {
        window.__proxyProfileId = 'profile-b'
        window.dispatchEvent(new Event('clashnova-profiles-changed'))
      })
      await page.waitForFunction(() => document.querySelectorAll('.node-grid').length === 0)
      await card('Streaming').getByRole('button', { name: '展开', exact: true }).click()
      await card('Streaming').getByText('88 ms', { exact: true }).waitFor()
      assert.equal(await card('Streaming').getByText('36 ms', { exact: true }).count(), 0)
    })

    await check('proxies_ignore_delays_from_the_previous_profile_after_automatic_tests', async () => {
      await visit(() => {
        window.__proxyFixture.proxies['HK-PCCW'].history = []
        window.__proxyFixture.proxies['HK-ViuTV'].history = []
        window.__finishOldProbes = []
        window.__probeDelay = (args) => {
          window.__proxyProbeCalls.push(args)
          return new Promise((resolve) => window.__finishOldProbes.push((delay = 999) => resolve(delay)))
        }
      })
      await page.waitForFunction(() => window.__finishOldProbes.length === 3)
      await page.evaluate(() => {
        window.__proxyProfileId = 'profile-b'
        window.__proxyFixture.proxies.Streaming.now = 'HK-ViuTV'
        window.dispatchEvent(new Event('clashnova-profiles-changed'))
      })
      await card('Streaming').locator('.grp-now b').filter({ hasText: 'HK-ViuTV' }).waitFor()
      await page.waitForFunction(() => window.__finishOldProbes.length === 6)
      await card('Streaming').getByRole('button', { name: '展开', exact: true }).click()
      await page.evaluate(() => window.__finishOldProbes.slice(0, 3).forEach((finish) => finish()))
      await page.waitForTimeout(200)
      assert.equal(await card('Streaming').getByText('999 ms', { exact: true }).count(), 0)
      await page.evaluate(() => window.__finishOldProbes.slice(3).forEach((finish) => finish(42)))
      await card('Streaming').getByText('42 ms', { exact: true }).first().waitFor()
    })

    await check('proxies_refill_expired_delays_when_the_core_has_no_history', async () => {
      await visit(() => {
        window.__proxyFixture.proxies['HK-PCCW'].history = []
        window.__proxyFixture.proxies['HK-ViuTV'].history = []
      })
      await card('Streaming').getByRole('button', { name: '展开', exact: true }).click()
      await page.waitForFunction(() => window.__proxyProbeCalls.length === 3 && [...document.querySelectorAll('.node-grid[data-group="Streaming"] .badge')].filter((node) => node.textContent === '36 ms').length === 2)
      await page.evaluate(() => {
        const now = Date.now
        Date.now = () => now() + 31 * 60 * 1000
        window.__proxyProbeCalls = []
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await page.waitForFunction(() => window.__proxyProbeCalls.some((call) => call.name === 'HK-ViuTV'))
      await card('Streaming').getByText('36 ms', { exact: true }).first().waitFor()
    })

    await check('proxies_all_probe_updates_groups_with_their_own_test_urls', async () => {
      await visit()
      await page.getByRole('button', { name: '全部测速', exact: true }).click()
      await page.getByRole('button', { name: '全部测速', exact: true }).waitFor()
      await card('Streaming').getByRole('button', { name: '展开', exact: true }).click()
      await page.waitForFunction(() => [...document.querySelectorAll('.node-grid[data-group="Streaming"] .badge')].filter((node) => node.textContent === '36 ms').length === 2)
      await card('全部节点').getByRole('button', { name: '展开', exact: true }).click()
      await card('全部节点').getByText('36 ms', { exact: true }).waitFor()
      const calls = await page.evaluate(() => window.__proxyProbeCalls)
      assert.equal(calls.length, 3)
      assert.equal(calls.filter((call) => call.url === 'https://group.example.invalid/204').length, 2)
    })

    assert.deepEqual(errors, [])
    console.log(`PROXIES BROWSER SUMMARY ${passed} passed, ${failed} failed, pageErrors=${errors.length}`)
    return { passed, failed, errors }
  } finally { await context.close() }
}
