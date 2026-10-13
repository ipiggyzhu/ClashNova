import assert from 'node:assert/strict'

export async function runUpdaterBrowser(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' })
  await context.route('**/*', (route) => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  let passed = 0, failed = 0

  async function test(name, fn) {
    try { await fn(); passed++; console.log(`PASS ${name}`) }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack ?? error}`) }
  }

  async function fixture(options = {}) {
    await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' })
    await page.evaluate(async (options) => {
      const { mockHandlers } = await import('/src/services/mock.ts')
      const state = {
        supported: true, currentBuildId: 'a'.repeat(40), appChecked: true, appDownloaded: true,
        app: { version: '2.4.8', buildId: 'b'.repeat(40), assetName: 'ClashNova_2.4.8_x64-setup.exe', size: 10485760, sha256: 'c'.repeat(64), sameVersion: true },
        core: { version: 'v1.19.28', size: 1000, sha256: 'd'.repeat(64) },
        installedCores: [{ id: 'bundled', version: 'v1.19.27', bundled: true, active: true }],
        phase: 'ready', kind: 'app', downloaded: 10485760, total: 10485760, error: null,
        ...options,
      }
      const calls = { installs: [], switches: [], downloads: 0, coreDownloads: 0, cancels: 0 }
      window.__updaterFixture = { state, calls, failDownload: false, failSwitch: false }
      mockHandlers.get_update_state = () => structuredClone(state)
      mockHandlers.check_app_update = () => state.app
      mockHandlers.check_core_update = () => state.core
      mockHandlers.download_app_update = () => {
        calls.downloads++
        if (window.__updaterFixture.failDownload) {
          state.phase = 'failed'; state.error = 'fixture-digest-mismatch'
          throw new Error(state.error)
        }
        state.error = null; state.phase = 'downloading'; state.kind = 'app'; state.appDownloaded = false; state.downloaded = 5242880
      }
      mockHandlers.cancel_update = () => {
        calls.cancels++; state.phase = 'cancelled'; state.appDownloaded = false; state.error = null
      }
      mockHandlers.install_app_update = ({ confirm }) => { calls.installs.push(confirm) }
      mockHandlers.download_core_update = () => {
        calls.coreDownloads++
        state.phase = 'idle'; state.kind = 'core'; state.error = null
        if (!state.installedCores.some((core) => core.id !== 'bundled')) state.installedCores.push({ id: `v1.19.28-${'d'.repeat(64)}`, version: 'v1.19.28', bundled: false, active: false })
      }
      mockHandlers.switch_core_version = ({ id, confirm }) => {
        calls.switches.push({ id, confirm })
        if (window.__updaterFixture.failSwitch) {
          state.phase = 'failed'; state.error = 'fixture-new-core-failed-rolled-back'
          throw new Error(state.error)
        }
        state.installedCores.forEach((core) => { core.active = core.id === id })
        state.phase = 'idle'; state.error = null
      }
    }, options)
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await page.locator('.update-settings').waitFor()
    await page.locator('.update-settings option').first().waitFor({ state: 'attached' })
  }

  try {
    await test('updater_requires_explicit_install_confirmation', async () => {
      await fixture()
      const card = page.locator('.update-settings')
      await card.getByRole('button', { name: '退出并安装更新', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '确认安装更新', exact: true })
      await dialog.waitFor()
      assert.deepEqual(await page.evaluate(() => window.__updaterFixture.calls.installs), [])
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      assert.deepEqual(await page.evaluate(() => window.__updaterFixture.calls.installs), [])
      await card.getByRole('button', { name: '退出并安装更新', exact: true }).click()
      await dialog.getByRole('button', { name: '确认退出并安装', exact: true }).click()
      await page.waitForFunction(() => window.__updaterFixture.calls.installs.length === 1)
      assert.deepEqual(await page.evaluate(() => window.__updaterFixture.calls.installs), [true])
    })

    await test('updater_shows_progress_and_cancel_does_not_install', async () => {
      await fixture({ phase: 'idle', appDownloaded: false })
      const card = page.locator('.update-settings')
      await card.getByRole('button', { name: '下载更新', exact: true }).click()
      await card.getByRole('progressbar', { name: '更新下载进度', exact: true }).waitFor()
      assert.equal(await card.getByRole('progressbar').getAttribute('value'), '50')
      await card.getByRole('button', { name: '取消下载', exact: true }).click()
      await card.getByText('已取消下载', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.__updaterFixture.calls.cancels), 1)
      assert.deepEqual(await page.evaluate(() => window.__updaterFixture.calls.installs), [])
    })

    await test('updater_failure_is_visible_and_can_retry', async () => {
      await fixture({ phase: 'idle', appDownloaded: false })
      await page.evaluate(() => { window.__updaterFixture.failDownload = true })
      const card = page.locator('.update-settings')
      await card.getByRole('button', { name: '下载更新', exact: true }).click()
      await card.getByRole('alert').filter({ hasText: 'fixture-digest-mismatch' }).waitFor()
      assert.equal(await page.evaluate(() => window.__updaterFixture.calls.downloads), 1)
      await page.evaluate(() => { window.__updaterFixture.failDownload = false })
      await card.getByRole('button', { name: '下载更新', exact: true }).click()
      await card.getByRole('progressbar').waitFor()
      assert.equal(await page.evaluate(() => window.__updaterFixture.calls.downloads), 2)
      assert.equal(await card.getByRole('alert').count(), 0)
    })

    await test('core_download_never_switches_without_confirmation_and_failure_retains_old_selection', async () => {
      await fixture({ phase: 'idle', appDownloaded: false })
      const card = page.locator('.update-settings')
      await card.getByRole('button', { name: '下载内核', exact: true }).click()
      await page.waitForFunction(() => document.querySelectorAll('.update-settings option').length === 2)
      assert.deepEqual(await page.evaluate(() => window.__updaterFixture.calls.switches), [])
      await card.getByLabel('已下载的内核版本', { exact: true }).selectOption({ label: 'v1.19.28' })
      await card.getByRole('button', { name: '切换内核', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '确认切换内核', exact: true })
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      assert.deepEqual(await page.evaluate(() => window.__updaterFixture.calls.switches), [])
      await page.evaluate(() => { window.__updaterFixture.failSwitch = true })
      await card.getByRole('button', { name: '切换内核', exact: true }).click()
      await dialog.getByRole('button', { name: '确认切换', exact: true }).click()
      await card.getByRole('alert').filter({ hasText: 'fixture-new-core-failed-rolled-back' }).waitFor()
      assert.equal(await page.evaluate(() => window.__updaterFixture.state.installedCores.find((core) => core.active).id), 'bundled')
      assert.ok(await dialog.isVisible())
      await page.evaluate(() => { window.__updaterFixture.failSwitch = false })
      await dialog.getByRole('button', { name: '确认切换', exact: true }).click()
      await page.waitForFunction(() => window.__updaterFixture.state.installedCores.find((core) => core.active).version === 'v1.19.28')
      assert.ok((await page.evaluate(() => window.__updaterFixture.calls.switches)).every((call) => call.confirm === true))
    })

    await test('updater_remount_recovers_native_download_state_without_restarting_download', async () => {
      await fixture({ phase: 'downloading', appDownloaded: false, downloaded: 5242880 })
      await page.getByRole('link', { name: '仪表盘', exact: true }).click()
      await page.evaluate(() => { window.__updaterFixture.state.phase = 'ready'; window.__updaterFixture.state.appDownloaded = true })
      await page.getByRole('link', { name: '设置', exact: true }).click()
      await page.locator('.update-settings').getByRole('button', { name: '退出并安装更新', exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.__updaterFixture.calls.downloads), 0)
      assert.deepEqual(await page.evaluate(() => window.__updaterFixture.calls.installs), [])
    })

    await test('updater_has_no_browser_page_errors', async () => { assert.deepEqual(pageErrors, []) })
  } finally { await context.close() }
  return { passed, failed }
}
