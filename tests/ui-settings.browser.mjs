import assert from 'node:assert/strict'


export async function runSettingsBrowser(browser, base) {
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' })
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url())
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') await route.continue()
  else await route.abort()
})
const page = await context.newPage()
page.setDefaultTimeout(15000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error.message}`)
  }
}
async function visit(route) {
  await page.goto(`${base}/${route}`, { waitUntil: 'networkidle' })
  await page.locator(`.pg-${route}`).waitFor()
  await page.evaluate(async () => {
    window.__notifications = (await import('/src/stores/notifications.ts')).useNotificationStore
  })
}
async function failHandler(command) {
  await page.evaluate(async (command) => {
    const { mockHandlers } = await import('/src/services/mock.ts')
    window.__originalHandler = mockHandlers[command]
    window.__fixtureCalls = 0
    mockHandlers[command] = () => {
      window.__fixtureCalls += 1
      throw new Error('fixture-save-failed')
    }
  }, command)
}
async function restoreHandler(command) {
  await page.evaluate(async (command) => {
    const { mockHandlers } = await import('/src/services/mock.ts')
    mockHandlers[command] = window.__originalHandler
  }, command)
}

try {
  await test('editor_lazy_until_open', async () => {
    const editorRequests = []
    const observe = (request) => {
      if (request.url().includes('/ui/CodeEditor.tsx')) editorRequests.push(request.url())
    }
    page.on('request', observe)
    await visit('settings')
    assert.equal(editorRequests.length, 0)
    await visit('profiles')
    assert.equal(editorRequests.length, 0)
    await page.getByRole('button', { name: '新建', exact: true }).click()
    await page.locator('.cm-content').waitFor()
    assert.ok(editorRequests.length > 0)
    page.off('request', observe)
  })

  await test('dns_typing_keeps_focus_and_node', async () => {
    await visit('settings')
    await page.getByRole('button', { name: '高级', exact: true }).click()
    const input = page.getByLabel('域名服务器', { exact: true })
    await input.fill('')
    const initial = await input.elementHandle()
    await input.pressSequentially('dns-focus-test', { delay: 15 })
    assert.equal(await input.inputValue(), 'dns-focus-test')
    assert.ok(await page.evaluate((node) => node.isConnected && document.activeElement === node, initial))
  })

  await test('dns_save_failure_retains_draft_and_dialog', async () => {
    await visit('settings')
    await page.getByRole('button', { name: '高级', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'DNS 覆写', exact: true })
    const field = dialog.getByLabel('域名服务器', { exact: true })
    await field.fill('https://dns.fixture.invalid/dns-query')
    await failHandler('patch_settings')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: 'fixture-save-failed' }).waitFor()
    assert.equal(await field.inputValue(), 'https://dns.fixture.invalid/dns-query')
    assert.ok(await dialog.isVisible())
    await restoreHandler('patch_settings')
  })

  await test('settings_drawer_failure_and_focus_loop', async () => {
    await visit('settings')
    const trigger = page.locator('.set-row').filter({ hasText: '自定义 CSS' }).getByRole('button', { name: '编辑', exact: true })
    const triggerElement = await trigger.elementHandle()
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '自定义 CSS 编辑(留空关闭)', exact: true })
    const editor = dialog.locator('.cm-content[contenteditable="true"]')
    await editor.fill(':root { --fixture: 1; }')
    await failHandler('patch_settings')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: 'fixture-save-failed' }).waitFor()
    assert.equal(await editor.textContent(), ':root { --fixture: 1; }')
    await dialog.getByRole('button', { name: '保存', exact: true }).focus()
    await page.keyboard.press('Tab')
    assert.ok(await dialog.getByRole('button', { name: '关闭', exact: true }).evaluate((node) => node === document.activeElement))
    await page.keyboard.press('Shift+Tab')
    assert.ok(await dialog.getByRole('button', { name: '保存', exact: true }).evaluate((node) => node === document.activeElement))
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.ok(await page.evaluate((node) => node === document.activeElement, triggerElement))
    await restoreHandler('patch_settings')
  })

  await test('settings_failed_input_save_keeps_draft', async () => {
    await visit('settings')
    await failHandler('patch_settings')
    const input = page.getByLabel('混合端口', { exact: true })
    await input.fill('9999')
    await input.blur()
    await page.waitForFunction(() => window.__fixtureCalls === 1 && window.__notifications.getState().notifications
      .some((item) => item.message.includes('fixture-save-failed')))
    assert.equal(await input.inputValue(), '9999')
    assert.equal(await page.evaluate(() => window.__fixtureCalls), 1)
    await restoreHandler('patch_settings')
  })

  await test('unrelated_theme_intent_survives_failed_input_draft', async () => {
    await visit('settings')
    await page.evaluate(async () => {
      const { mockHandlers } = await import('/src/services/mock.ts')
      const original = mockHandlers.patch_settings
      mockHandlers.patch_settings = (args) => {
        if ('mixedPort' in args.patch) throw new Error('fixture-draft-failed')
        return original(args)
      }
    })
    const input = page.getByLabel('混合端口', { exact: true })
    await input.fill('9999')
    await input.blur()
    await page.waitForFunction(() => window.__notifications.getState().notifications.some((item) => item.message.includes('fixture-draft-failed')))
    await page.getByRole('group', { name: '主题', exact: true }).getByRole('button', { name: '浅色', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    assert.equal(await input.inputValue(), '9999')
  })

  await test('profiles_create_failure_keeps_draft_and_dedupes_clicks', async () => {
    await visit('profiles')
    await failHandler('import_profile_file')
    await page.getByRole('button', { name: '新建', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '新建本地配置', exact: true })
    await dialog.getByLabel('本地配置名称').fill('fixture.yaml')
    await dialog.locator('.cm-content[contenteditable="true"]').fill('proxies: []')
    await dialog.getByRole('button', { name: '创建', exact: true }).evaluate((button) => { button.click(); button.click() })
    await dialog.getByRole('alert').filter({ hasText: 'fixture-save-failed' }).waitFor()
    assert.equal(await page.evaluate(() => window.__fixtureCalls), 1)
    assert.equal(await dialog.getByLabel('本地配置名称').inputValue(), 'fixture.yaml')
    assert.equal(await dialog.locator('.cm-content').textContent(), 'proxies: []')
    assert.ok(await dialog.isVisible())
    await restoreHandler('import_profile_file')
  })

  await test('profiles_editor_save_failure_is_visible', async () => {
    await visit('profiles')
    await failHandler('save_profile_content')
    await page.locator('.pcard').first().getByRole('button', { name: '编辑', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('.cm-content[contenteditable="true"]').fill('rules: []')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: 'fixture-save-failed' }).waitFor()
    assert.ok(await dialog.isVisible())
    assert.equal(await dialog.locator('.cm-content').textContent(), 'rules: []')
    await restoreHandler('save_profile_content')
  })

  await test('runtime_late_response_does_not_reopen', async () => {
    await visit('profiles')
    await page.evaluate(async () => {
      const { mockHandlers } = await import('/src/services/mock.ts')
      mockHandlers.get_runtime_config = () => {
        window.__runtimeStarted = true
        return new Promise((resolve) => setTimeout(() => {
          window.__runtimeDone = true
          resolve('rules: []')
        }, 400))
      }
    })
    await page.getByRole('button', { name: '查看运行配置', exact: true }).click()
    await page.waitForFunction(() => window.__runtimeStarted)
    await page.getByRole('dialog', { name: '当前运行配置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
    await page.waitForFunction(() => window.__runtimeDone)
    assert.equal(await page.getByRole('dialog').count(), 0)
  })

  await test('profile_menu_keyboard_and_focus_restore', async () => {
    await visit('profiles')
    const trigger = page.locator('.pcard').first().getByRole('button', { name: /的订阅操作$/ })
    const element = await trigger.elementHandle()
    await trigger.click()
    const menu = page.getByRole('menu')
    assert.ok(await menu.evaluate((node) => node.contains(document.activeElement)))
    await page.keyboard.press('End')
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '删除')
    await page.keyboard.press('Home')
    assert.ok(await menu.evaluate((node) => node.contains(document.activeElement)))
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    assert.ok(await page.evaluate((node) => node === document.activeElement, element))
  })

  await test('notification_cap_and_unread_are_consistent', async () => {
    await visit('settings')
    const result = await page.evaluate(async () => {
      const { useNotificationStore, MAX_NOTIFICATIONS } = await import('/src/stores/notifications.ts')
      const store = useNotificationStore
      store.getState().clearAll()
      for (let i = 0; i < MAX_NOTIFICATIONS + 50; i++) store.getState().add('info', `fixture-${i}`, 'body')
      const first = [store.getState().notifications.length, store.getState().unreadCount]
      store.getState().markAllAsRead()
      for (let i = 0; i < 25; i++) store.getState().add('info', `new-${i}`, 'body')
      store.getState().remove(store.getState().notifications[0].id)
      store.getState().markAsRead(store.getState().notifications[0].id)
      return { maximum: MAX_NOTIFICATIONS, first, count: store.getState().notifications.length, unread: store.getState().unreadCount }
    })
    assert.deepEqual(result.first, [result.maximum, result.maximum])
    assert.equal(result.count, result.maximum - 1)
    assert.equal(result.unread, 23)
  })

  await test('notification_keyboard_delete_and_close', async () => {
    await visit('settings')
    await page.evaluate(async () => {
      const { useNotificationStore } = await import('/src/stores/notifications.ts')
      const store = useNotificationStore.getState()
      store.clearAll()
      store.add('info', 'first-item', 'body')
      store.add('warning', 'second-item', 'body')
    })
    const trigger = page.getByRole('button', { name: '通知', exact: true })
    await trigger.click()
    const panel = page.getByRole('dialog', { name: '通知', exact: true })
    await panel.getByRole('button', { name: 'second-item · 未读', exact: true }).focus()
    await page.keyboard.press('Enter')
    assert.ok(await panel.getByRole('button', { name: 'second-item · 已读', exact: true }).isVisible())
    await panel.getByRole('button', { name: '删除通知：second-item', exact: true }).focus()
    await page.keyboard.press('Enter')
    assert.ok(await panel.getByRole('button', { name: 'first-item · 未读', exact: true }).evaluate((node) => node === document.activeElement))
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached' })
    assert.ok(await trigger.evaluate((node) => node === document.activeElement))
    await trigger.click()
    await trigger.click()
    assert.equal(await page.getByRole('dialog', { name: '通知', exact: true }).count(), 0)
  })

  await test('topbar_failure_notifies_and_controls_are_named', async () => {
    await visit('settings')
    await failHandler('patch_settings')
    await page.getByRole('button', { name: '切换主题', exact: true }).click()
    await page.waitForFunction(() => window.__notifications.getState().notifications
      .some((item) => item.title === '切换主题失败'))
    assert.equal(await page.getByRole('switch', { name: '系统代理', exact: true }).count(), 1)
    assert.equal(await page.getByRole('group', { name: '出站模式', exact: true }).locator('[aria-pressed="true"]').count(), 1)
    await restoreHandler('patch_settings')
  })

  assert.equal(errors.length, 0, `Unhandled page errors: ${errors.join('; ')}`)
  console.log(`SUMMARY ${passed} passed, ${failed} failed, pageErrors=${errors.length}`)
  return { passed, failed, errors }
} finally {
  await context.close()

}

}
