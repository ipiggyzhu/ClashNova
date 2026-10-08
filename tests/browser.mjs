import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'
import { createServer, preview } from 'vite'
import { runSettingsBrowser } from './ui-settings.browser.mjs'

const root = path.resolve(import.meta.dirname, '..')
const ownedServers = []
let browser
let passed = 0, failed = 0

async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.stack ?? error}`) }
}

async function context() {
  const value = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' })
  await value.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname
    return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort()
  })
  return value
}

try {
  let base = process.env.BASE_URL
  if (!base) {
    const server = await createServer({ root, cacheDir: path.join(root, '.tmp/browser-vite-cache'), logLevel: 'warn', server: { host: '127.0.0.1', port: 0, strictPort: false } })
    await server.listen()
    ownedServers.push(server)
    base = `http://127.0.0.1:${server.httpServer.address().port}`
  }
  browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    args: ['--enable-unsafe-swiftshader'],
  })
  const ctx = await context()
  const page = await ctx.newPage()
  page.setDefaultTimeout(20_000)
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  for (const route of ['dashboard', 'traffic', 'connections', 'logs', 'topology', 'routemap', 'proxies', 'rules', 'providers', 'test', 'profiles', 'settings']) {
    await check(`route_${route}`, async () => {
      const before = pageErrors.length
      await page.goto(`${base}/${route}`, { waitUntil: 'networkidle' })
      await page.locator(`.pg-${route}`).waitFor()
      assert.equal(await page.locator('.route-error').count(), 0)
      assert.equal(pageErrors.length, before)
    })
  }

  await check('glass_surfaces_and_dialogs_keep_rounding_in_both_themes', async () => {
    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' })
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async (value) => {
        await (await import('/src/stores/app.ts')).useAppStore.getState().setTheme(value)
      }, theme)
      const surfaces = await page.evaluate(() => ['.sidebar', '.topbar', '.card', '.btn', '.input'].map((selector) => {
        const style = getComputedStyle(document.querySelector(selector))
        return { selector, radius: parseFloat(style.borderTopLeftRadius), blur: style.backdropFilter, background: style.backgroundColor, opacity: style.opacity }
      }))
      for (const surface of surfaces) {
        assert.ok(surface.radius >= 10, `${theme} ${surface.selector} must have rounded corners`)
        assert.equal(surface.opacity, '1', 'glass must not fade text with container opacity')
      }
      assert.match(surfaces[0].blur, /blur/)
      assert.equal(surfaces[1].blur, 'none', 'topbar must not isolate the notification backdrop')
      assert.match(surfaces[1].background, /^rgba\(/)
      assert.equal(surfaces[2].blur, 'none', 'live cards must not each create a blur layer')
      assert.match(surfaces[2].background, /^rgba\(/)

      await page.getByRole('button', { name: '高级', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'DNS 覆写', exact: true })
      const panel = await dialog.evaluate((node) => {
        const style = getComputedStyle(node)
        return { radius: parseFloat(style.borderTopLeftRadius), shadow: style.boxShadow, overflow: style.overflow, border: style.borderTopWidth }
      })
      assert.ok(panel.radius >= 18)
      assert.notEqual(panel.shadow, 'none')
      assert.equal(panel.overflow, 'hidden')
      assert.equal(panel.border, '1px')
      await page.keyboard.press('Escape')

      await page.getByRole('button', { name: '通知', exact: true }).click()
      const notification = page.getByRole('dialog', { name: '通知', exact: true })
      assert.ok(await notification.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return parseFloat(getComputedStyle(node).borderTopLeftRadius) >= 18
          && node.contains(document.elementFromPoint(rect.x + 20, rect.y + 20))
      }), 'rounded notification panel must stay above content')
      await page.keyboard.press('Escape')
    }
  })

  await check('globe_theme_preserves_canvas_and_labels', async () => {
    await page.goto(`${base}/routemap`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => document.querySelectorAll('.globe-label').length > 0)
    const canvas = await page.locator('.globe-host canvas').first().elementHandle()
    for (const theme of ['light', 'dark']) {
      await page.getByRole('button', { name: '切换主题', exact: true }).click()
      await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme)
      assert.ok(await page.evaluate((node) => node.isConnected && document.querySelector('.globe-host canvas') === node, canvas))
      assert.equal(await page.locator('.globe-label--origin span').textContent(), 'Local')
      assert.ok(await page.locator('.globe-label').count() > 1)
    }
  })

  await check('system_theme_tracks_media_change', async () => {
    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.evaluate(async () => { await (await import('/src/stores/app.ts')).useAppStore.getState().setTheme('system') })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  })

  await check('dashboard_uses_full_summary_including_unattributed', async () => {
    await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      const { mockHandlers } = await import('/src/services/mock.ts')
      mockHandlers.query_traffic_summary = () => ({ up: 100, down: 900, direct: 500, proxy: 300, unattributed: 200 })
      mockHandlers.query_traffic_rank = () => [{ key: 'other-proxy', up: 1, down: 1 }]
      window.dispatchEvent(new CustomEvent('clashnova-traffic-updated'))
    })
    await page.waitForFunction(() => [...document.querySelectorAll('.sum-legend .row')].some((row) => row.textContent.includes('直连') && row.textContent.includes('500 B')))
    assert.match(await page.locator('.sum-legend .row').filter({ hasText: '代理' }).textContent(), /300 B/)
    assert.match(await page.locator('.sum-legend .row').filter({ hasText: '未归因' }).textContent(), /200 B/)
  })

  await check('traffic_discards_late_previous_range_response', async () => {
    await page.goto(`${base}/traffic`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      const { mockHandlers } = await import('/src/services/mock.ts')
      mockHandlers.query_traffic_rank = ({ range }) => range === '7d'
        ? new Promise((resolve) => { window.__resolveOldRank = () => resolve([{ key: 'late-7d', up: 1, down: 1 }]) })
        : [{ key: `latest-${range}`, up: 2, down: 2 }]
      window.dispatchEvent(new CustomEvent('clashnova-traffic-updated'))
    })
    await page.waitForFunction(() => Boolean(window.__resolveOldRank))
    await page.getByRole('button', { name: '30 天', exact: true }).click()
    await page.getByText('latest-30d', { exact: true }).waitFor()
    await page.evaluate(() => window.__resolveOldRank())
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.getByText('late-7d', { exact: true }).count(), 0)
    assert.ok(await page.getByText('latest-30d', { exact: true }).isVisible())
  })

  await check('connections_render_only_visible_rows_and_reach_the_last_row', async () => {
    await page.goto(`${base}/connections`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      const { useLiveStore } = await import('/src/stores/live.ts')
      useLiveStore.getState().setConnections({ uploadTotal: 0, downloadTotal: 0, connections: Array.from({ length: 5000 }, (_, i) => ({
        id: `conn-${i}`, metadata: { host: `host-${i}.invalid`, destinationIP: '', destinationPort: '443', sourceIP: '127.0.0.1', sourcePort: '1234', network: 'tcp' },
        rule: 'Domain', rulePayload: '', chains: ['DIRECT'], upload: 1, download: 2, start: new Date().toISOString(),
      })) })
    })
    await page.waitForFunction(() => document.querySelector('.pg-connections .chip')?.textContent.includes('5000'))
    assert.ok(await page.locator('.conn-row').count() < 60)
    await page.locator('.conn-scroll').evaluate((node) => { node.scrollTop = node.scrollHeight })
    await page.getByText('host-4999.invalid', { exact: false }).waitFor()
    assert.ok(await page.locator('.conn-row').count() < 60)
  })

  await check('logs_window_buffer_and_report_actual_transport_status', async () => {
    await page.goto(`${base}/logs`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      const { useLiveStore } = await import('/src/stores/live.ts')
      const store = useLiveStore.getState()
      store.clearLogs()
      for (let i = 0; i < 3000; i += 1) store.pushLog({ type: 'info', payload: `log-${i}`, time: '12:00:00' })
    })
    await page.getByText('log-2999', { exact: true }).waitFor()
    assert.ok(await page.locator('.console .line').count() < 60)
    assert.match(await page.locator('.foot').textContent(), /1,024.*已暂停连接/)
    await page.locator('.console').evaluate((node) => { node.scrollTop = 0 })
    await page.getByText('log-1976', { exact: true }).waitFor()
  })

  await check('test_page_rejects_invalid_protocols', async () => {
    await page.goto(`${base}/test`, { waitUntil: 'networkidle' })
    await page.getByPlaceholder('名称', { exact: true }).fill('invalid')
    await page.getByPlaceholder('测试地址 https://…(204 端点或小资源)').fill('file:///fixture')
    await page.getByRole('button', { name: '添加', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'HTTP / HTTPS' }).waitFor()
    assert.equal(await page.getByText('invalid', { exact: true }).count(), 0)
  })
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'))
  await ctx.close()

  await check('rules_paginate_beyond_500_and_normalize_types', async () => {
    const fixture = await context()
    try {
      await fixture.addInitScript(() => { window.__ruleFixture = Array.from({ length: 1205 }, (_, i) => ({ type: i % 2 ? 'IPCIDR' : 'DomainSuffix', payload: `rule-${i}.invalid`, proxy: 'DIRECT' })) })
      const rulePage = await fixture.newPage()
      // 只替换 Mock 分支的数据源；不在生产代码增加测试开关。
      await rulePage.route('**/src/services/api.ts*', async (route) => {
        const response = await route.fetch()
        const source = await response.text()
        assert.match(source, /return mockRules\(\)/)
        await route.fulfill({ response, body: source.replace(/return mockRules\(\)/, 'return window.__ruleFixture') })
      })
      await rulePage.goto(`${base}/rules`, { waitUntil: 'networkidle' })
      await rulePage.getByText('第 1 / 13 页 · 1,205 条', { exact: true }).waitFor()
      assert.equal(await rulePage.locator('.rule-row').count(), 100)
      for (let i = 0; i < 6; i += 1) await rulePage.getByRole('button', { name: '下一页', exact: true }).click()
      await rulePage.getByText('rule-600.invalid', { exact: true }).waitFor()
      await rulePage.getByRole('button', { name: 'DOMAIN-SUFFIX', exact: true }).click()
      await rulePage.getByText('第 1 / 7 页 · 603 条', { exact: true }).waitFor()
      assert.equal(await rulePage.locator('.hits').count(), 0)
    } finally { await fixture.close() }
  })

  await check('production_flat_map_does_not_load_3d_until_requested', async () => {
    const server = await preview({ root, logLevel: 'warn', preview: { host: '127.0.0.1', port: 0, strictPort: false } })
    ownedServers.push(server)
    const production = `http://127.0.0.1:${server.httpServer.address().port}`
    const fixture = await context()
    try {
      const mapPage = await fixture.newPage()
      const requests = []
      mapPage.on('request', (request) => requests.push(request.url()))
      await mapPage.goto(`${production}/routemap?view=flat`, { waitUntil: 'networkidle' })
      await mapPage.locator('.flat-svg .route-trace').first().waitFor()
      assert.ok(!requests.some((url) => /RouteMapGlobe|vendor-globe|vendor-three|earth-.*\.jpg/.test(url)))
      await mapPage.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      assert.ok(await mapPage.locator('.flat-svg').evaluate((node) => node.animationsPaused()))
      assert.equal(await mapPage.locator('.route-trace').first().evaluate((node) => getComputedStyle(node).animationPlayState), 'paused')
      await mapPage.evaluate(() => {
        delete document.hidden
        document.dispatchEvent(new Event('visibilitychange'))
      })
      assert.equal(await mapPage.locator('.flat-svg').evaluate((node) => node.animationsPaused()), false)
      await mapPage.getByRole('button', { name: '球面视图', exact: true }).click()
      await mapPage.locator('.globe-host canvas').first().waitFor()
      await mapPage.locator('.globe-label--origin span').waitFor()
      assert.ok(requests.some((url) => /RouteMapGlobe/.test(url)))
    } finally { await fixture.close() }
  })

  const ui = await runSettingsBrowser(browser, base)
  passed += ui.passed
  failed += ui.failed
  console.log(`BROWSER SUMMARY ${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
} finally {
  await browser?.close()
  for (const server of ownedServers.reverse()) await server.close()
}
