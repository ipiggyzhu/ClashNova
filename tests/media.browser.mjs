import assert from 'node:assert/strict'

export async function runMediaBrowser(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route('**/*', (route) => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  let passed = 0, failed = 0
  async function test(name, fn) {
    try { await fn(); passed++; console.log(`PASS ${name}`) }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack ?? error}`) }
  }
  async function fixture(mode = 'ready', running = true) {
    await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' })
    await page.evaluate(async ({ mode, running }) => {
      const { mockHandlers } = await import('/src/services/mock.ts')
      const { useAppStore } = await import('/src/stores/app.ts')
      useAppStore.setState({ coreStatus: { ...useAppStore.getState().coreStatus, running } })
      mockHandlers.core_status = () => ({ ...useAppStore.getState().coreStatus, running })
      const report = { proxyPort: 7897, results: [
        { service: 'youtube', status: 'reachable', elapsedMs: 30, httpStatus: 200, detail: '官方页面可达；未登录、未播放' },
        { service: 'netflix', status: 'restricted', elapsedMs: 40, httpStatus: 451, detail: '服务明确返回法律访问限制，未推断地区' },
        { service: 'disney', status: 'unknown', elapsedMs: 50, httpStatus: 403, detail: '返回访问拦截，不能认定地区限制' },
      ] }
      window.__mediaFixture = { calls: [], cancels: [], report, resolve: null }
      mockHandlers.media_probe = ({ requestId }) => {
        window.__mediaFixture.calls.push(requestId)
        if (mode === 'error') throw new Error('fixture media timeout; no direct fallback')
        if (mode === 'pending') return new Promise((resolve) => { window.__mediaFixture.resolve = resolve })
        return structuredClone(report)
      }
      mockHandlers.media_cancel = ({ requestId }) => { window.__mediaFixture.cancels.push(requestId) }
    }, { mode, running })
    await page.getByRole('link', { name: '测试', exact: true }).click()
    await page.locator('.media-check').waitFor()
  }

  try {
    await test('media_is_manual_and_does_not_claim_playback_from_200', async () => {
      await fixture()
      assert.deepEqual(await page.evaluate(() => window.__mediaFixture.calls), [])
      const card = page.locator('.media-check')
      assert.match(await card.innerText(), /遵循当前策略/)
      await card.getByRole('button', { name: '检测媒体服务', exact: true }).click()
      await card.getByText('页面可达', { exact: true }).waitFor()
      await card.getByText('明确限制提示', { exact: true }).waitFor()
      await card.getByText('未能判定', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.__mediaFixture.calls.length), 1)
      assert.equal(await card.getByText('已解锁', { exact: true }).count(), 0)
      assert.match(await card.innerText(), /未登录、未播放/)
    })

    await test('media_stopped_core_disables_network_probe', async () => {
      await fixture('ready', false)
      assert.ok(await page.locator('.media-check').getByRole('button', { name: '检测媒体服务', exact: true }).isDisabled())
      assert.equal(await page.evaluate(() => window.__mediaFixture.calls.length), 0)
    })

    await test('media_timeout_is_reported_without_stale_success', async () => {
      await fixture('error')
      const card = page.locator('.media-check')
      await card.getByRole('button', { name: '检测媒体服务', exact: true }).click()
      await card.getByRole('alert').filter({ hasText: 'fixture media timeout' }).waitFor()
      assert.equal(await card.getByText('页面可达', { exact: true }).count(), 0)
      assert.ok(await card.getByRole('button', { name: '检测媒体服务', exact: true }).isEnabled())
    })

    await test('media_cancel_ignores_late_response_and_uses_request_identity', async () => {
      await fixture('pending')
      const card = page.locator('.media-check')
      await card.getByRole('button', { name: '检测媒体服务', exact: true }).click()
      await page.waitForFunction(() => window.__mediaFixture.resolve != null)
      await card.getByRole('button', { name: '取消媒体检测', exact: true }).click()
      await page.waitForFunction(() => window.__mediaFixture.cancels.length === 1)
      await page.evaluate(() => {
        const fixture = window.__mediaFixture
        fixture.report.results[0].detail = 'late-report-do-not-render'
        fixture.resolve(fixture.report)
      })
      assert.deepEqual(await page.evaluate(() => window.__mediaFixture.cancels), await page.evaluate(() => window.__mediaFixture.calls))
      await card.getByRole('alert').filter({ hasText: '媒体检测已取消' }).waitFor()
      assert.equal(await card.getByText('late-report-do-not-render').count(), 0)
    })

    await test('media_unmount_cancels_and_old_completion_cannot_update_new_page', async () => {
      await fixture('pending')
      await page.locator('.media-check').getByRole('button', { name: '检测媒体服务', exact: true }).click()
      await page.waitForFunction(() => window.__mediaFixture.resolve != null)
      await page.getByRole('link', { name: '仪表盘', exact: true }).click()
      await page.waitForFunction(() => window.__mediaFixture.cancels.length === 1)
      await page.getByRole('link', { name: '测试', exact: true }).click()
      await page.evaluate(() => {
        window.__mediaFixture.report.results[0].detail = 'late-unmount-report'
        window.__mediaFixture.resolve(window.__mediaFixture.report)
      })
      const card = page.locator('.media-check')
      assert.equal(await card.getByText('未检测', { exact: true }).count(), 3)
      assert.equal(await card.getByText('late-unmount-report').count(), 0)
    })

    await test('media_browser_has_no_page_errors', async () => { assert.deepEqual(errors, []) })
  } finally { await context.close() }
  return { passed, failed }
}
