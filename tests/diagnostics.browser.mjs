import assert from 'node:assert/strict'

export async function runDiagnosticsBrowser(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let passed = 0, failed = 0
  const test = async (name, action) => {
    try { await action(); passed++; console.log(`PASS ${name}`) }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack ?? error}`) }
  }
  const card = () => page.locator('.network-diagnostics')
  const start = () => card().getByRole('button', { name: '开始诊断', exact: true })

  async function fixture(mode = 'ready') {
    await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' })
    await page.evaluate(async mode => {
      const { mockHandlers } = await import('/src/services/mock.ts')
      const { useAppStore } = await import('/src/stores/app.ts')
      useAppStore.setState({ coreStatus: { ...useAppStore.getState().coreStatus, running: false } })
      mockHandlers.core_status = () => ({ running: false, version: '', uptimeSec: 0, memoryBytes: 0 })
      const report = { schemaVersion: 1, source: 'mock', appVersion: '2.4.8', platform: 'mock', generatedAt: 123, durationMs: 42, includeInternet: false,
        checks: ['pass', 'warn', 'fail', 'unknown', 'skipped'].map((status, index) => ({ id: `check-${index}`, title: `检查 ${index}`, status, detail: `诊断结论 ${index}`, suggestion: '', elapsedMs: index === 0 ? 2 : null })) }
      window.__diagnosticFixture = { calls: [], report, resolve: null }
      mockHandlers.diagnostics_run = args => {
        window.__diagnosticFixture.calls.push(args)
        if (mode === 'error') throw new Error('private-credential-and-path-must-not-display')
        if (mode === 'pending') return new Promise(resolve => { window.__diagnosticFixture.resolve = resolve })
        return { ...structuredClone(report), includeInternet: args.includeInternet }
      }
    }, mode)
    await page.getByRole('link', { name: '测试', exact: true }).click()
    await card().waitFor()
  }

  try {
    await test('diagnostics_are_manual_opt_out_of_internet_and_work_with_core_stopped', async () => {
      await fixture()
      assert.equal(await card().getByRole('switch', { name: '包含外网探测' }).getAttribute('aria-checked'), 'false')
      assert.deepEqual(await page.evaluate(() => window.__diagnosticFixture.calls), [])
      assert.ok(await start().isEnabled())
      assert.ok(await card().getByRole('button', { name: '导出脱敏报告' }).isDisabled())
      await start().click()
      await card().getByRole('status').waitFor()
      assert.deepEqual(await page.evaluate(() => window.__diagnosticFixture.calls), [{ includeInternet: false }])
      assert.match(await card().getByRole('status').innerText(), /1 项异常 \/ 1 项需注意 \/ 2 项未确认或未检测/)
      for (const status of ['通过', '需注意', '异常', '未确认', '未检测']) assert.equal(await card().getByText(status, { exact: true }).count(), 1)
    })

    await test('diagnostic_internet_opt_in_is_explicit_and_invalidates_previous_report', async () => {
      await fixture()
      await start().click()
      await card().getByRole('status').waitFor()
      await card().getByRole('switch', { name: '包含外网探测' }).click()
      assert.equal(await card().getByRole('status').count(), 0)
      assert.ok(await card().getByRole('button', { name: '导出脱敏报告' }).isDisabled())
      assert.equal(await page.evaluate(() => window.__diagnosticFixture.calls.length), 1)
      await start().click()
      await card().getByRole('status').filter({ hasText: '包含外网探测' }).waitFor()
      assert.deepEqual(await page.evaluate(() => window.__diagnosticFixture.calls[1]), { includeInternet: true })
    })

    await test('diagnostic_export_is_local_json_and_identifies_mock_results', async () => {
      await fixture()
      await start().click()
      await card().getByRole('status').waitFor()
      const event = page.waitForEvent('download')
      await card().getByRole('button', { name: '导出脱敏报告' }).click()
      const download = await event
      assert.equal(download.suggestedFilename(), 'ClashNova-diagnostics.json')
      const stream = await download.createReadStream()
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.equal(exported.source, 'mock')
      assert.equal(exported.includeInternet, false)
      assert.equal(exported.checks.length, 5)
      assert.doesNotMatch(JSON.stringify(exported), /secret|password|token|subscription|processPath/i)
    })

    await test('diagnostic_failure_clears_stale_results_and_does_not_echo_raw_errors', async () => {
      await fixture()
      await start().click()
      await card().getByRole('status').waitFor()
      await page.evaluate(async () => { (await import('/src/services/mock.ts')).mockHandlers.diagnostics_run = () => { throw new Error('private-credential-and-path-must-not-display') } })
      await start().click()
      await card().getByRole('alert').waitFor()
      assert.equal(await card().getByRole('status').count(), 0)
      assert.equal(await card().getByText('诊断结论 0', { exact: true }).count(), 0)
      assert.doesNotMatch(await card().innerText(), /private-credential/)
      assert.ok(await card().getByRole('button', { name: '导出脱敏报告' }).isDisabled())
    })

    await test('diagnostics_prevent_double_requests_and_ignore_results_after_unmount', async () => {
      await fixture('pending')
      await start().dblclick()
      await page.waitForFunction(() => window.__diagnosticFixture.resolve != null)
      assert.equal(await page.evaluate(() => window.__diagnosticFixture.calls.length), 1)
      assert.ok(await card().getByRole('switch', { name: '包含外网探测' }).isDisabled())
      await page.getByRole('link', { name: '仪表盘', exact: true }).click()
      await page.getByRole('link', { name: '测试', exact: true }).click()
      await page.evaluate(() => { window.__diagnosticFixture.report.checks[0].detail = 'late-old-report'; window.__diagnosticFixture.resolve(window.__diagnosticFixture.report) })
      assert.equal(await card().getByText('late-old-report', { exact: true }).count(), 0)
      assert.equal(await card().getByRole('status').count(), 0)
    })

    await test('diagnostic_glass_cards_keep_rounding_in_both_themes_without_overflow', async () => {
      await fixture()
      await start().click()
      await card().getByRole('status').waitFor()
      for (const theme of ['light', 'dark']) {
        await page.evaluate(async theme => { await (await import('/src/stores/app.ts')).useAppStore.getState().setTheme(theme) }, theme)
        for (const width of [1280, 1000]) {
          await page.setViewportSize({ width, height: 900 })
          assert.ok(await card().evaluate(node => node.scrollWidth <= node.clientWidth))
          assert.ok(await card().locator('.diagnostic-result').first().evaluate(node => parseFloat(getComputedStyle(node).borderTopLeftRadius) >= 10))
        }
      }
    })

    await test('diagnostics_browser_has_no_page_errors', async () => { assert.deepEqual(errors, []) })
  } finally { await context.close() }
  return { passed, failed }
}
