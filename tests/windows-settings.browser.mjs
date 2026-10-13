import assert from 'node:assert/strict'

export async function runWindowsSettingsBrowser(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route('**/*', (route) => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  let passed = 0, failed = 0
  const check = async (name, action) => {
    try { await action(); passed += 1; console.log(`PASS ${name}`) }
    catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.stack ?? error}`) }
  }
  const visit = async () => {
    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' })
    await page.waitForFunction(async () => (await import('/src/stores/app.ts')).useAppStore.getState().loaded)
  }
  const openTun = async () => {
    await page.getByRole('button', { name: 'TUN 高级设置', exact: true }).click()
    return page.getByRole('dialog', { name: 'TUN 高级设置', exact: true })
  }

  try {
    await check('tun_invalid_input_does_not_persist_or_enable_tun', async () => {
      await visit()
      const dialog = await openTun()
      await dialog.getByLabel('TUN MTU', { exact: true }).fill('575')
      await dialog.getByRole('button', { name: '保存 TUN 设置' }).click()
      await dialog.getByRole('alert').filter({ hasText: 'MTU' }).waitFor()
      assert.equal(await dialog.getByLabel('TUN MTU', { exact: true }).inputValue(), '575')
      const settings = await page.evaluate(async () => (await import('/src/services/ipc.ts')).call('get_settings'))
      assert.equal(settings.tun, false)
      assert.equal(settings.tunOptions.mtu, null)
      await page.keyboard.press('Escape')
    })

    await check('tun_failed_native_save_preserves_draft_then_retries_once', async () => {
      await visit()
      await page.evaluate(async () => {
        const { mockHandlers } = await import('/src/services/mock.ts')
        const original = mockHandlers.patch_settings
        window.__tunSaves = []
        mockHandlers.patch_settings = (args) => {
          if (args.patch.tunOptions) {
            window.__tunSaves.push(structuredClone(args.patch))
            if (window.__tunSaves.length === 1) throw new Error('fixture-tun-validation-failed')
          }
          return original(args)
        }
      })
      const dialog = await openTun()
      await dialog.getByLabel('TUN MTU', { exact: true }).fill('1500')
      await dialog.getByLabel('TUN 协议栈', { exact: true }).selectOption('mixed')
      await dialog.getByLabel('DNS 劫持设置方式', { exact: true }).selectOption('override')
      await dialog.getByLabel('TUN DNS 劫持', { exact: true }).fill('any:53\ntcp://[::1]:53')
      await dialog.getByRole('button', { name: '保存 TUN 设置' }).click()
      await dialog.getByRole('alert').filter({ hasText: 'fixture-tun-validation-failed' }).waitFor()
      assert.equal(await dialog.getByLabel('TUN MTU', { exact: true }).inputValue(), '1500')
      await dialog.getByRole('button', { name: '保存 TUN 设置' }).click()
      await dialog.waitFor({ state: 'detached' })
      const saves = await page.evaluate(() => window.__tunSaves)
      assert.equal(saves.length, 2)
      assert.deepEqual(saves[1].tunOptions.dnsHijack, ['any:53', 'tcp://[::1]:53'])
      assert.equal(saves[1].tunOptions.mtu, 1500)
      assert.equal(Object.hasOwn(saves[1], 'tun'), false)
    })

    await check('tun_inherit_and_explicit_empty_round_trip_and_lightweight_setting', async () => {
      await visit()
      let dialog = await openTun()
      await dialog.getByLabel('路由排除设置方式', { exact: true }).selectOption('override')
      await dialog.getByRole('button', { name: '保存 TUN 设置' }).click()
      await dialog.waitFor({ state: 'detached' })
      let settings = await page.evaluate(async () => (await import('/src/services/ipc.ts')).call('get_settings'))
      assert.deepEqual(settings.tunOptions.routeExcludeAddress, [])
      dialog = await openTun()
      await dialog.getByLabel('路由排除设置方式', { exact: true }).selectOption('inherit')
      await dialog.getByRole('button', { name: '保存 TUN 设置' }).click()
      await dialog.waitFor({ state: 'detached' })
      await page.getByRole('switch', { name: '轻量驻留', exact: true }).click()
      await page.waitForFunction(async () => (await import('/src/services/ipc.ts')).call('get_settings').then((settings) => settings.lightweightOnClose))
      settings = await page.evaluate(async () => (await import('/src/services/ipc.ts')).call('get_settings'))
      assert.equal(settings.tunOptions.routeExcludeAddress, null)
      assert.equal(settings.tun, false)
    })

    await check('protocol_confirmation_is_single_native_operation_and_no_url_in_dom', async () => {
      await visit()
      await page.evaluate(async () => {
        const { mockHandlers } = await import('/src/services/mock.ts')
        const fixture = window.__protocolFixture = { pending: [{ id: 1, host: 'fixture.example.invalid', name: 'fixture', importing: false }], imports: 0, dismisses: 0, fail: true }
        mockHandlers.pending_profile_imports = () => structuredClone(fixture.pending)
        mockHandlers.confirm_profile_import = () => {
          fixture.imports += 1
          if (fixture.fail) throw new Error('fixture-import-failed')
          fixture.pending = []
          return { id: 'fixture', name: 'fixture', kind: 'remote', current: false, updatedAt: 0 }
        }
        mockHandlers.dismiss_profile_import = () => { fixture.dismisses += 1; throw new Error('Must not dismiss after a confirmed import') }
        window.dispatchEvent(new Event('clashnova-profile-imports'))
      })
      const dialog = page.getByRole('dialog', { name: '确认导入订阅', exact: true })
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /fixture.example.invalid/)
      assert.ok(!/token=|https:\/\//.test(await dialog.innerText()))
      await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: 'fixture-import-failed' }).waitFor()
      await page.evaluate(() => { window.__protocolFixture.fail = false })
      await dialog.getByRole('button', { name: '确认导入', exact: true }).evaluate((button) => { button.click(); button.click() })
      await dialog.waitFor({ state: 'detached' })
      const fixture = await page.evaluate(() => window.__protocolFixture)
      assert.equal(fixture.imports, 2, 'one failed request plus one success, no double click duplicate')
      assert.equal(fixture.dismisses, 0)
      const notices = await page.evaluate(async () => (await import('/src/stores/notifications.ts')).useNotificationStore.getState().notifications.filter((item) => item.title === '订阅已导入'))
      assert.equal(notices.length, 1)
      assert.match(notices[0].message, /当前订阅保持不变/)
    })

    await check('protocol_refresh_failure_does_not_reimport_completed_id_but_new_request_can_import_same_url', async () => {
      await visit()
      await page.evaluate(async () => {
        const { mockHandlers } = await import('/src/services/mock.ts')
        const request = { host: 'fixture.example.invalid', name: 'fixture', importing: false }
        const fixture = window.__protocolRefreshFixture = {
          source: 'https://fixture.example.invalid/sub?token=fixture', request,
          pending: [{ ...request, id: 1 }], imports: [], confirmCalls: [], refreshFailures: 0,
        }
        mockHandlers.pending_profile_imports = () => {
          if (fixture.refreshFailures > 0) {
            fixture.refreshFailures -= 1
            throw new Error('fixture-refresh-failed')
          }
          return structuredClone(fixture.pending)
        }
        mockHandlers.confirm_profile_import = ({ id }) => {
          fixture.confirmCalls.push(id)
          if (!fixture.pending.some((item) => item.id === id)) throw new Error('fixture-request-already-processed')
          fixture.pending = fixture.pending.filter((item) => item.id !== id)
          fixture.imports.push(fixture.source)
          if (id === 1) fixture.refreshFailures = 2
          return { id: `fixture-${id}`, name: 'fixture', kind: 'remote', current: fixture.imports.length === 1, updatedAt: 0 }
        }
        mockHandlers.import_profile = () => { throw new Error('Non-atomic import must not be called') }
        mockHandlers.dismiss_profile_import = () => { throw new Error('Must not dismiss after a confirmed import') }
        window.dispatchEvent(new Event('clashnova-profile-imports'))
      })
      const dialog = page.getByRole('dialog', { name: '确认导入订阅', exact: true })
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /没有订阅时.*首个配置.*自动启用/)
      assert.ok(!/token=|https:\/\//.test(await dialog.innerText()))
      await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: 'fixture-refresh-failed' }).waitFor()
      await page.waitForFunction(() => window.__protocolRefreshFixture.refreshFailures === 0)
      await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      let fixture = await page.evaluate(() => window.__protocolRefreshFixture)
      assert.deepEqual(fixture.imports, [fixture.source], 'refresh failures and retry must not repeat the completed import')
      assert.deepEqual(fixture.confirmCalls, [1, 1], 'the stale id retry reaches native validation but cannot replay import')
      let notices = await page.evaluate(async () => (await import('/src/stores/notifications.ts')).useNotificationStore.getState().notifications.filter((item) => item.title === '订阅已导入'))
      assert.equal(notices.length, 1, 'a rejected stale id must not emit another success notification')
      assert.match(notices[0].message, /已自动设为当前配置并启用/)

      await page.evaluate(() => {
        const fixture = window.__protocolRefreshFixture
        fixture.pending = [{ ...fixture.request, id: 2 }]
        window.dispatchEvent(new Event('clashnova-profile-imports'))
      })
      await dialog.waitFor()
      await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      fixture = await page.evaluate(() => window.__protocolRefreshFixture)
      assert.deepEqual(fixture.imports, [fixture.source, fixture.source], 'a new event may deliberately import the same URL again')
      assert.deepEqual(fixture.confirmCalls, [1, 1, 2])
      notices = await page.evaluate(async () => (await import('/src/stores/notifications.ts')).useNotificationStore.getState().notifications.filter((item) => item.title === '订阅已导入'))
      assert.equal(notices.length, 2)
      assert.match(notices[0].message, /当前订阅保持不变/)
    })

    await check('native_inflight_protocol_request_cannot_be_dismissed_after_webview_reload', async () => {
      await visit()
      await page.evaluate(async () => {
        const { mockHandlers } = await import('/src/services/mock.ts')
        mockHandlers.pending_profile_imports = () => [{ id: 9, host: 'fixture.example.invalid', importing: true }]
        window.dispatchEvent(new Event('clashnova-profile-imports'))
      })
      const dialog = page.getByRole('dialog', { name: '确认导入订阅', exact: true })
      await dialog.waitFor()
      assert.equal(await dialog.getByRole('button', { name: '处理中…', exact: true }).isDisabled(), true)
      assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
      await page.keyboard.press('Escape')
      assert.equal(await dialog.count(), 1)
    })
    await check('windows_settings_page_errors', async () => assert.deepEqual(errors, []))
  } finally { await context.close() }
  return { passed, failed }
}
