import assert from 'node:assert/strict'

export async function runBackupBrowser(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname
    return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  let passed = 0, failed = 0
  const check = async (name, test) => {
    try { await test(); passed += 1; console.log(`PASS ${name}`) }
    catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.message}`) }
  }
  const visit = async (options = {}) => {
    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' })
    await page.evaluate(async (options) => {
      const { mockHandlers } = await import('/src/services/mock.ts')
      const { useAppStore } = await import('/src/stores/app.ts')
      await useAppStore.getState().loadAll()
      const entry = { id: 'backup-1234567890123-0123456789abcdef', label: '本地测试备份',
        createdAt: 1234567890123, appVersion: '2.4.8', sizeBytes: 1024, source: 'local' }
      window.__backupFixture = {
        entries: [entry], remote: [{ ...entry, source: 'webdav', label: '远程测试备份' }], calls: [],
        dav: { url: 'https://dav.example.invalid/ClashNova/', username: 'fixture-user', passwordSaved: true },
        configBroken: Boolean(options.brokenDav),
      }
      const fixture = window.__backupFixture
      if (options.damaged) fixture.entries.push({ ...entry, id: 'backup-damaged', label: '损坏测试备份', error: 'fixture-damaged-backup' })
      const record = (name, handler) => (args) => { fixture.calls.push(name); return handler(args) }
      mockHandlers.backup_list = () => structuredClone(fixture.entries)
      mockHandlers.backup_webdav_get = () => {
        if (fixture.configBroken) throw new Error('fixture-damaged-dav')
        return { ...fixture.dav }
      }
      mockHandlers.backup_create = record('create', ({ label }) => {
        const created = { ...entry, id: `backup-created-${fixture.entries.length}`, label: label || '手动备份' }
        fixture.entries.unshift(created)
        return created
      })
      mockHandlers.backup_import = record('import', ({ content }) => {
        if (content === 'invalid') throw new Error('fixture-invalid-backup')
        const imported = { ...entry, id: 'backup-imported', label: '导入测试备份' }
        fixture.entries.push(imported)
        return imported
      })
      mockHandlers.backup_preview = record('preview', ({ id }) => ({
        entry: fixture.entries.find((entry) => entry.id === id), profileCount: 2, enhancerCount: 3, fileCount: 7,
        preservedSettings: ['sysProxy', 'tun', 'secret', 'mixedPort', 'hotkeys'],
        warnings: ['保留本机系统代理、TUN、自启、快捷键、控制器凭据和监听端口；不启动已停止的内核。'],
      }))
      mockHandlers.backup_restore = record('restore', () => ({ ...useAppStore.getState().settings }))
      mockHandlers.backup_delete = record('delete', ({ id }) => { fixture.entries = fixture.entries.filter((entry) => entry.id !== id) })
      mockHandlers.backup_export = record('export', ({ redacted }) => ({
        filename: redacted ? 'ClashNova-backup-redacted.json' : 'fixture.novabackup',
        content: JSON.stringify(redacted ? { redacted: true, restorable: false, profileCount: 2 } : { fixture: true }),
      }))
      mockHandlers.backup_webdav_save = record('dav-save', ({ config }) => {
        if ((config.url !== fixture.dav.url || config.username !== fixture.dav.username) && config.password === undefined) {
          throw new Error('fixture-reenter-password')
        }
        fixture.dav = { url: config.url, username: config.username, passwordSaved: true }
        fixture.configBroken = false
      })
      mockHandlers.backup_webdav_list = record('dav-list', () => structuredClone(fixture.remote))
      mockHandlers.backup_webdav_upload = record('dav-upload', () => undefined)
      mockHandlers.backup_webdav_download = record('dav-download', () => {
        const downloaded = { ...entry, id: 'backup-downloaded', label: '下载测试备份' }
        fixture.entries.push(downloaded)
        return downloaded
      })
      mockHandlers.backup_webdav_delete = record('dav-delete', ({ id }) => { fixture.remote = fixture.remote.filter((entry) => entry.id !== id) })
    }, options)
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '备份与恢复', exact: true })
    await dialog.getByText('本地测试备份', { exact: true }).waitFor()
    return dialog
  }
  const calls = (name) => page.evaluate((name) => window.__backupFixture.calls.filter((value) => value === name).length, name)

  try {
    await check('backup_create_import_preview_and_redacted_export_do_not_restore_implicitly', async () => {
      const dialog = await visit()
      await dialog.getByLabel('备份备注', { exact: true }).fill('备份界面测试')
      await dialog.getByRole('button', { name: '创建备份', exact: true }).click()
      await dialog.getByText('备份界面测试', { exact: true }).waitFor()
      assert.equal(await calls('create'), 1)
      const row = dialog.locator('.backup-list li').filter({ hasText: '本地测试备份' })
      await row.getByRole('button', { name: '预览恢复', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: '确认恢复备份', exact: true })
      await confirm.getByText(/不启动已停止的内核/).waitFor()
      assert.equal(await calls('restore'), 0)
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
      await dialog.getByLabel('选择备份文件', { exact: true }).setInputFiles({
        name: 'fixture.novabackup', mimeType: 'application/json', buffer: Buffer.from('{"fixture":true}'),
      })
      await dialog.getByText('导入测试备份', { exact: true }).waitFor()
      assert.equal(await calls('restore'), 0)
      const downloadPromise = page.waitForEvent('download')
      await row.getByRole('button', { name: '脱敏摘要', exact: true }).click()
      const download = await downloadPromise
      assert.equal(download.suggestedFilename(), 'ClashNova-backup-redacted.json')
      const stream = await download.createReadStream()
      let content = ''
      for await (const chunk of stream) content += chunk.toString()
      assert.equal(JSON.parse(content).restorable, false)
      assert.equal(await calls('restore'), 0)
      await row.getByRole('button', { name: '删除', exact: true }).click()
      const deletion = page.getByRole('dialog', { name: '确认删除备份', exact: true })
      assert.equal(await calls('delete'), 0)
      await deletion.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal(await row.count(), 1)
    })

    await check('backup_restore_requires_confirmation_serializes_and_retains_failed_dialog', async () => {
      const dialog = await visit()
      await page.evaluate(async () => {
        const { mockHandlers } = await import('/src/services/mock.ts')
        mockHandlers.backup_restore = () => {
          window.__backupFixture.calls.push('restore')
          return new Promise((_, reject) => { window.__rejectBackupRestore = () => reject(new Error('fixture-restore-failed')) })
        }
      })
      await dialog.getByRole('button', { name: '预览恢复', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: '确认恢复备份', exact: true })
      await confirm.getByRole('button', { name: '确认恢复备份', exact: true }).click()
      await page.waitForFunction(() => typeof window.__rejectBackupRestore === 'function')
      assert.equal(await calls('restore'), 1)
      assert.equal(await confirm.getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
      await page.keyboard.press('Escape')
      assert.equal(await confirm.count(), 1)
      await page.evaluate(() => window.__rejectBackupRestore())
      await confirm.getByRole('alert').filter({ hasText: 'fixture-restore-failed' }).waitFor()
      assert.equal(await calls('restore'), 1)
      assert.equal(await dialog.getByText('本地测试备份', { exact: true }).count(), 1)
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
    })

    await check('backup_webdav_password_is_not_echoed_and_unsaved_accounts_cannot_upload', async () => {
      const dialog = await visit()
      const password = dialog.getByLabel('WebDAV 密码', { exact: true })
      assert.equal(await password.inputValue(), '')
      await dialog.getByLabel('WebDAV 目录地址', { exact: true }).fill('https://other.example.invalid/ClashNova/')
      assert.equal(await dialog.getByRole('button', { name: '上传', exact: true }).isDisabled(), true)
      assert.equal(await dialog.getByRole('button', { name: '连接并刷新远程', exact: true }).isDisabled(), true)
      await dialog.getByRole('button', { name: '保存 WebDAV 设置', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: 'fixture-reenter-password' }).waitFor()
      await password.fill('FIXTURE_BROWSER_PASSWORD_ONLY')
      await dialog.getByRole('button', { name: '保存 WebDAV 设置', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.backup-panel input[type="password"]')?.value === '')
      assert.equal(await dialog.getByRole('button', { name: '保存 WebDAV 设置', exact: true }).isDisabled(), true)
      await dialog.getByRole('button', { name: '上传', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: '确认上传完整备份', exact: true })
      await confirm.getByText(/未经加密/).waitFor()
      assert.equal(await calls('dav-upload'), 0)
      await confirm.getByRole('button', { name: '确认上传完整备份', exact: true }).click()
      await dialog.getByText('远程测试备份', { exact: true }).waitFor()
      assert.equal(await calls('dav-upload'), 1)
      await dialog.getByRole('button', { name: '下载到本地', exact: true }).click()
      await dialog.getByText('下载测试备份', { exact: true }).waitFor()
      assert.equal(await calls('restore'), 0)
      assert.equal(await calls('dav-download'), 1)
    })

    await check('backup_damaged_history_and_webdav_configuration_remain_repairable', async () => {
      const dialog = await visit({ damaged: true, brokenDav: true })
      await dialog.getByRole('alert').filter({ hasText: 'fixture-damaged-dav' }).waitFor()
      const damaged = dialog.locator('.backup-list li').filter({ hasText: '损坏测试备份' })
      assert.equal(await damaged.getByRole('button', { name: '预览恢复', exact: true }).isDisabled(), true)
      assert.equal(await damaged.getByRole('button', { name: '导出完整备份', exact: true }).isDisabled(), true)
      assert.equal(await damaged.getByRole('button', { name: '删除', exact: true }).isDisabled(), false)
      await dialog.getByLabel('WebDAV 目录地址', { exact: true }).fill('https://dav.example.invalid/ClashNova/')
      await dialog.getByLabel('WebDAV 用户名', { exact: true }).fill('fixture-user')
      await dialog.getByLabel('WebDAV 密码', { exact: true }).fill('FIXTURE_REPAIR_PASSWORD_ONLY')
      await dialog.getByRole('button', { name: '保存 WebDAV 设置', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.backup-panel input[type="password"]')?.value === '')
      assert.equal(await dialog.getByText('本地测试备份', { exact: true }).count(), 1)
      await damaged.getByRole('button', { name: '删除', exact: true }).click()
      const deletion = page.getByRole('dialog', { name: '确认删除备份', exact: true })
      await deletion.getByRole('button', { name: '确认删除备份', exact: true }).click()
      await damaged.waitFor({ state: 'detached' })
      assert.equal(await dialog.getByText('本地测试备份', { exact: true }).count(), 1)
    })

    await check('backup_errors_keep_existing_history_and_glass_dialog_remains_accessible', async () => {
      const dialog = await visit()
      await dialog.getByLabel('选择备份文件', { exact: true }).setInputFiles({
        name: 'invalid.novabackup', mimeType: 'application/json', buffer: Buffer.from('invalid'),
      })
      await dialog.getByRole('alert').filter({ hasText: 'fixture-invalid-backup' }).waitFor()
      assert.equal(await dialog.getByText('本地测试备份', { exact: true }).count(), 1)
      for (const theme of ['light', 'dark']) {
        await page.evaluate(async (theme) => { await (await import('/src/stores/app.ts')).useAppStore.getState().setTheme(theme) }, theme)
        assert.ok(await dialog.evaluate((node) => parseFloat(getComputedStyle(node).borderTopLeftRadius) >= 18))
      }
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent === '备份与恢复' && document.activeElement === button), undefined, { timeout: 1000 })
      assert.deepEqual(errors, [])
    })
  } finally { await context.close() }
  return { passed, failed }
}
