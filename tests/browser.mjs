import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { createServer, preview } from 'vite'
import { runSettingsBrowser } from './ui-settings.browser.mjs'
import { runTrayBrowser } from './tray.browser.mjs'
import { runProfilesBrowser } from './profiles.browser.mjs'
import { runBackupBrowser } from './backup.browser.mjs'
import { runUpdaterBrowser } from './ui-updater.browser.mjs'
import { runMediaBrowser } from './media.browser.mjs'
import { runDiagnosticsBrowser } from './diagnostics.browser.mjs'
import { runWindowsSettingsBrowser } from './windows-settings.browser.mjs'

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

  await check('connections_window_20000_rows_and_recover_after_snapshot_shrink', async () => {
    await page.goto(`${base}/connections`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      const { useLiveStore } = await import('/src/stores/live.ts')
      useLiveStore.getState().setConnections({ uploadTotal: 0, downloadTotal: 0, connections: Array.from({ length: 20000 }, (_, i) => ({
        id: `conn-${i}`, metadata: { host: `host-${i}.invalid`, destinationIP: '', destinationPort: '443', sourceIP: '127.0.0.1', sourcePort: '1234', network: 'tcp' },
        rule: 'Domain', rulePayload: '', chains: ['DIRECT'], upload: 1, download: 2, start: new Date().toISOString(),
      })) })
    })
    await page.waitForFunction(() => document.querySelector('.pg-connections .chip')?.textContent.includes('20000'))
    assert.ok(await page.locator('.conn-row').count() < 60)
    await page.locator('.conn-scroll').evaluate((node) => { node.scrollTop = node.scrollHeight })
    await page.getByText('host-19999.invalid', { exact: false }).waitFor()
    assert.ok(await page.locator('.conn-row').count() < 60)
    await page.evaluate(async () => {
      const { useLiveStore } = await import('/src/stores/live.ts')
      const store = useLiveStore.getState()
      store.setConnections({ ...store.connections, connections: store.connections.connections.slice(0, 5) })
    })
    await page.getByText('host-4.invalid', { exact: false }).waitFor()
    assert.equal(await page.locator('.conn-row').count(), 5)
  })

  await check('logs_bound_100000_events_and_report_actual_transport_status', async () => {
    await page.goto(`${base}/logs`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      const { useLiveStore } = await import('/src/stores/live.ts')
      const store = useLiveStore.getState()
      store.clearLogs()
      for (let i = 0; i < 100000; i += 1) store.pushLog({ type: 'info', payload: `log-${i}`, time: '12:00:00' })
    })
    await page.getByText('log-99999', { exact: true }).waitFor()
    assert.ok(await page.locator('.console .line').count() < 60)
    assert.match(await page.locator('.foot').textContent(), /1,024.*已暂停连接/)
    await page.locator('.console').evaluate((node) => { node.scrollTop = 0 })
    await page.getByText('log-98976', { exact: true }).waitFor()
  })

  await check('connections_detail_dialog_and_closed_history', async () => {
    await page.goto(`${base}/connections`, { waitUntil: 'networkidle' })
    const firstRow = page.locator('.conn-row').first()
    await firstRow.waitFor()
    await firstRow.click()
    const detail = page.getByRole('dialog', { name: '连接详情' })
    await detail.getByText('连接 ID', { exact: true }).waitFor()
    await detail.getByText('DEFAULT-MIXED', { exact: false }).waitFor()
    await page.keyboard.press('Escape')
    await detail.waitFor({ state: 'detached' })
    const host = (await firstRow.locator('.host-cell .h').innerText()).split(':')[0].trim()
    await page.locator('.conn-row').filter({ hasText: host }).getByTitle('关闭连接').click()
    assert.equal(await page.getByRole('dialog').count(), 0, 'closing a row must not open its detail')
    const closedTab = page.getByRole('group', { name: '连接分类' }).getByRole('button', { name: /^已关闭/ })
    await page.waitForFunction(() => /已关闭 [1-9]/.test(document.querySelector('[aria-label="连接分类"]')?.textContent ?? ''))
    await closedTab.click()
    await page.locator('.conn-row .host-cell').filter({ hasText: host }).first().waitFor()
    await page.getByRole('button', { name: '清空记录' }).click()
    await page.getByText('暂无已关闭的连接', { exact: false }).waitFor()
  })

  await check('proxies_sort_by_delay_orders_nodes_and_persists', async () => {
    await page.goto(`${base}/proxies`, { waitUntil: 'networkidle' })
    await page.locator('.node-grid[data-group="Streaming"] .node').first().waitFor()
    await page.getByRole('group', { name: '节点排序' }).getByRole('button', { name: '延迟', exact: true }).click()
    const delays = await page.locator('.node-grid[data-group="Streaming"] .node').evaluateAll((nodes) => nodes.map((node) => {
      const match = node.querySelector('.meta')?.lastElementChild?.textContent?.match(/^(\d+) ms$/)
      return match ? Number(match[1]) : Infinity
    }))
    assert.ok(delays.filter(Number.isFinite).length > 1, `expected measured delays, got ${delays}`)
    assert.deepEqual(delays, [...delays].sort((a, b) => a - b))
    assert.equal(await page.evaluate(() => localStorage.getItem('proxies:sort')), 'delay')
    await page.getByRole('group', { name: '节点排序' }).getByRole('button', { name: '默认', exact: true }).click()
  })

  await check('logs_export_contains_only_filtered_lines', async () => {
    await page.goto(`${base}/logs`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      const { useLiveStore } = await import('/src/stores/live.ts')
      const store = useLiveStore.getState()
      store.clearLogs()
      store.pushLog({ type: 'error', payload: 'export-fixture-keep', time: '12:00:00' })
      store.pushLog({ type: 'info', payload: 'export-fixture-drop', time: '12:00:01' })
    })
    await page.getByText('export-fixture-keep', { exact: true }).waitFor()
    await page.getByPlaceholder('过滤关键字…').fill('export-fixture-keep')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出', exact: true }).click(),
    ])
    assert.match(download.suggestedFilename(), /^ClashNova-logs-\d{8}-\d{6}\.log$/)
    const text = await readFile(await download.path(), 'utf8')
    assert.equal(text, '12:00:00 [ERROR] export-fixture-keep\n')
  })

  await check('dns_query_renders_core_answers', async () => {
    await page.goto(`${base}/test`, { waitUntil: 'networkidle' })
    await page.getByLabel('查询域名').fill('https://example.com/path')
    await page.getByRole('button', { name: '查询', exact: true }).click()
    await page.getByText('NOERROR', { exact: true }).waitFor()
    await page.getByRole('cell', { name: 'edge.example.com.' }).first().waitFor()
    assert.equal(await page.getByRole('cell', { name: 'CNAME', exact: true }).count(), 1)
  })

  await check('settings_latency_fields_validate_before_saving', async () => {
    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => { window.__notifications = (await import('/src/stores/notifications.ts')).useNotificationStore })
    const url = page.getByLabel('测速地址', { exact: true })
    await url.fill('ftp://bad.example')
    await url.blur()
    await page.waitForFunction(() => window.__notifications.getState().notifications.some((item) => item.message.includes('http:// 或 https://')))
    assert.equal(await url.inputValue(), 'ftp://bad.example')
    await url.fill('https://cp.cloudflare.com/generate_204')
    await url.blur()
    await page.waitForFunction(async () => (await import('/src/stores/app.ts')).useAppStore.getState().settings.delayTestUrl === 'https://cp.cloudflare.com/generate_204')
    const timeout = page.getByLabel('测速超时', { exact: true })
    await timeout.fill('100')
    await timeout.blur()
    await page.waitForFunction(() => window.__notifications.getState().notifications.some((item) => item.message.includes('500-30000 毫秒')))
    await timeout.fill('8000')
    await timeout.blur()
    await page.waitForFunction(async () => (await import('/src/stores/app.ts')).useAppStore.getState().settings.delayTestTimeout === 8000)
  })

  await check('settings_tun_row_installs_service_on_first_enable_and_confirms_uninstall', async () => {
    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' })
    assert.equal(await page.getByRole('heading', { name: '服务模式', exact: true }).count(), 0)
    await page.getByText('服务未安装', { exact: true }).waitFor()
    const tun = page.getByRole('switch', { name: 'TUN 模式', exact: true })
    await tun.click()
    const install = page.getByRole('dialog', { name: '安装系统服务' })
    await install.waitFor()
    assert.equal(await tun.getAttribute('aria-checked'), 'false', 'TUN must wait for the install confirmation')
    await install.getByRole('button', { name: '安装并开启 TUN', exact: true }).click()
    await install.waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="TUN 模式"]')?.getAttribute('aria-checked') === 'true')
    await page.getByRole('button', { name: '卸载服务', exact: true }).click()
    const uninstall = page.getByRole('dialog', { name: '卸载系统服务' })
    await uninstall.getByRole('button', { name: '确认卸载', exact: true }).click()
    await uninstall.waitFor({ state: 'detached' })
    await page.getByText('服务未安装', { exact: true }).waitFor()
    assert.equal(await tun.getAttribute('aria-checked'), 'false')
  })

  await check('settings_tun_success_survives_a_followup_service_query_failure', async () => {
    const fixture = await context()
    try {
      const settingsPage = await fixture.newPage()
      await settingsPage.goto(`${base}/settings`, { waitUntil: 'networkidle' })
      await settingsPage.getByText('服务未安装', { exact: true }).waitFor()
      await settingsPage.evaluate(async () => {
        const { mockHandlers } = await import('/src/services/mock.ts')
        const install = mockHandlers.install_service
        mockHandlers.install_service = async (args) => {
          const result = await install(args)
          mockHandlers.service_status = () => { throw new Error('fixture-status-query-failed') }
          return result
        }
      })
      const tun = settingsPage.getByRole('switch', { name: 'TUN 模式', exact: true })
      await tun.click()
      const install = settingsPage.getByRole('dialog', { name: '安装系统服务' })
      await install.getByRole('button', { name: '安装并开启 TUN', exact: true }).click()
      await settingsPage.getByText('服务查询失败', { exact: true }).waitFor()
      assert.equal(await tun.getAttribute('aria-checked'), 'true')
      await install.waitFor({ state: 'detached', timeout: 3000 })
      await settingsPage.getByRole('button', { name: '通知', exact: true }).click()
      assert.equal(await settingsPage.getByText('服务已安装，但开启 TUN 失败', { exact: true }).count(), 0)
    } finally { await fixture.close() }
  })

  await check('dashboard_exit_ip_is_masked_until_revealed', async () => {
    await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' })
    await page.getByText('203.0.*.*', { exact: true }).waitFor()
    await page.getByRole('button', { name: '显示出口 IP' }).click()
    await page.getByText('203.0.113.42', { exact: true }).waitFor()
    await page.getByRole('button', { name: '隐藏出口 IP' }).click()
    await page.getByText('203.0.*.*', { exact: true }).waitFor()
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

  await check('proxies_distinguish_historical_timeouts_untested_and_successful_nodes', async () => {
    const fixture = await context()
    try {
      await fixture.addInitScript(() => { window.__proxyFixture = { proxies: {
        'previous-timeout': { name: 'previous-timeout', type: 'Vmess', history: [{ time: '2026-10-10T00:00:00Z', delay: 0 }] },
        'never-tested': { name: 'never-tested', type: 'Vmess', history: [] },
        'previous-success': { name: 'previous-success', type: 'Vmess', history: [{ time: '2026-10-10T00:00:00Z', delay: 24 }] },
      } } })
      const proxiesPage = await fixture.newPage()
      await proxiesPage.route('**/src/services/api.ts*', async (route) => {
        const response = await route.fetch()
        const source = await response.text()
        assert.match(source, /return mockProxies\(\)/)
        await route.fulfill({ response, body: source.replace(/return mockProxies\(\)/, 'return window.__proxyFixture') })
      })
      await proxiesPage.goto(base + '/proxies', { waitUntil: 'networkidle' })
      await proxiesPage.getByText('previous-timeout', { exact: true }).waitFor()
      const node = (name) => proxiesPage.locator('.node').filter({ hasText: name })
      // mihomo 历史记录中 delay 0 不区分超时与其他失败, 统一显示 Failed
      assert.match(await node('previous-timeout').innerText(), /Failed/)
      assert.match(await node('never-tested').innerText(), /— ms/)
      assert.match(await node('previous-success').innerText(), /24 ms/)
      assert.equal(await proxiesPage.locator('.testing').count(), 0)
    } finally { await fixture.close() }
  })

  for (const outcome of ['resolve', 'reject']) {
    await check('polling_reconfigures_after_pending_query_' + outcome, async () => {
      const fixture = await context()
      try {
        await fixture.addInitScript((result) => {
          window.__rulePhase = 'initial'
          window.__ruleQueries = 0
          window.__loadRules = () => {
            const rule = (payload) => [{ type: 'DomainSuffix', payload, proxy: 'DIRECT' }]
            if (window.__rulePhase === 'initial') return rule('initial.invalid')
            window.__ruleQueries += 1
            if (window.__rulePhase === 'pending') return new Promise((resolve, reject) => {
              window.__finishOldRules = () => result === 'resolve'
                ? resolve(rule('stale.invalid'))
                : reject(new DOMException('stale-query', 'AbortError'))
            })
            return rule('current.invalid')
          }
        }, outcome)
        const rulePage = await fixture.newPage()
        await rulePage.route('**/src/services/api.ts*', async (route) => {
          const response = await route.fetch()
          const source = await response.text()
          assert.match(source, /return mockRules\(\)/)
          await route.fulfill({ response, body: source.replace(/return mockRules\(\)/, 'return window.__loadRules()') })
        })
        await rulePage.goto(base + '/rules', { waitUntil: 'networkidle' })
        await rulePage.getByText('initial.invalid', { exact: true }).waitFor()
        await rulePage.evaluate(() => {
          window.__rulePhase = 'pending'
          window.__staleRendered = false
          new MutationObserver(() => {
            if (/stale\.invalid|stale-query/.test(document.querySelector('.pg-rules').textContent)) window.__staleRendered = true
          }).observe(document.querySelector('.pg-rules'), { childList: true, subtree: true, characterData: true })
          window.dispatchEvent(new CustomEvent('clashnova-traffic-updated'))
        })
        await rulePage.waitForFunction(() => Boolean(window.__finishOldRules))
        await rulePage.evaluate(() => {
          window.__rulePhase = 'current'
          for (let i = 0; i < 32; i += 1) window.dispatchEvent(new CustomEvent('clashnova-api-config-changed'))
          window.__finishOldRules()
        })
        // 必须主动重查，不能等 15 秒轮询掩盖遗漏的刷新事件。
        await rulePage.getByText('current.invalid', { exact: true }).waitFor({ timeout: 3000 })
        assert.equal(await rulePage.evaluate(() => window.__ruleQueries), 2)
        assert.equal(await rulePage.evaluate(() => window.__staleRendered), false)
        assert.equal(await rulePage.getByRole('alert').count(), 0)
      } finally { await fixture.close() }
    })
  }

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

  await check('production_flat_map_pauses_animations_when_hidden', async () => {
    const server = await preview({ root, logLevel: 'warn', preview: { host: '127.0.0.1', port: 0, strictPort: false } })
    ownedServers.push(server)
    const production = `http://127.0.0.1:${server.httpServer.address().port}`
    const fixture = await context()
    try {
      const mapPage = await fixture.newPage()
      await mapPage.goto(`${production}/routemap`, { waitUntil: 'networkidle' })
      await mapPage.locator('.flat-svg .route-trace').first().waitFor()
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
    } finally { await fixture.close() }
  })

  for (const suite of [runTrayBrowser, runSettingsBrowser, runProfilesBrowser, runBackupBrowser, runUpdaterBrowser, runMediaBrowser, runWindowsSettingsBrowser, runDiagnosticsBrowser]) {
    const ui = await suite(browser, base)
    passed += ui.passed
    failed += ui.failed
  }
  console.log(`BROWSER SUMMARY ${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
} finally {
  await browser?.close()
  for (const server of ownedServers.reverse()) await server.close()
}
