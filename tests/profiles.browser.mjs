import assert from 'node:assert/strict'

export async function runProfilesBrowser(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname
    return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  let passed = 0, failed = 0
  const check = async (name, action) => {
    try { await action(); passed += 1; console.log(`PASS ${name}`) }
    catch (error) { failed += 1; console.log(`FAIL ${name}: ${error.message}`) }
  }

  async function visit() {
    await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      const { mockHandlers } = await import('/src/services/mock.ts')
      const fixture = window.__profileFeatureFixture = { calls: [], global: [], contents: {}, fail: '', sequence: 0 }
      mockHandlers.list_global_enhancers = () => structuredClone(fixture.global)
      mockHandlers.read_profile_topology = () => ({
        content: 'ORIGINAL_PROFILE_CONTENT',
        proxies: [{ name: 'fixture-node', type: 'socks5', server: 'proxy.example.invalid', port: 1080, udp: true, 'ws-opts': { path: '/fixture' } }],
        groups: [{ name: 'fixture-group', type: 'select', proxies: ['fixture-node', 'DIRECT'], use: ['airport'] }],
      })
      for (const command of ['import_profile', 'update_profile_meta', 'save_profile_topology', 'save_enhancer', 'read_enhancer', 'toggle_enhancer', 'delete_enhancer', 'reorder_enhancers']) {
        const original = mockHandlers[command]
        mockHandlers[command] = (args) => {
          fixture.calls.push({ command, args: structuredClone(args) })
          if (fixture.fail === command) throw new Error('fixture-operation-failed')
          if (command === 'save_profile_topology') return
          if (args.profileId !== '__global__') return original?.(args)
          if (command === 'save_enhancer') {
            let meta = fixture.global.find((item) => item.id === args.enhancerId)
            if (!meta) { meta = { id: `global-${++fixture.sequence}`, kind: args.kind, name: args.name, enabled: true }; fixture.global.push(meta) }
            meta.name = args.name
            fixture.contents[meta.id] = args.content
            return { ...meta }
          }
          if (command === 'read_enhancer') return fixture.contents[args.enhancerId]
          if (command === 'toggle_enhancer') fixture.global.find((item) => item.id === args.enhancerId).enabled = args.enabled
          if (command === 'delete_enhancer') fixture.global = fixture.global.filter((item) => item.id !== args.enhancerId)
          if (command === 'reorder_enhancers') fixture.global = args.enhancerIds.map((id) => fixture.global.find((item) => item.id === id))
        }
      }
    })
    await page.locator('a[href="/profiles"]').click()
    await page.locator('.pg-profiles .pcard').first().waitFor()
  }
  async function openTopology() {
    await page.locator('.pcard').first().getByRole('button', { name: /的订阅操作/ }).click()
    await page.getByRole('menuitem', { name: '编辑节点与策略组', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: /^节点与策略组：/ })
    await dialog.getByLabel('服务器', { exact: true }).waitFor()
    return dialog
  }
  const calls = (command) => page.evaluate((command) => window.__profileFeatureFixture.calls.filter((item) => item.command === command), command)

  try {
    await check('profiles_import_passes_protocol_and_download_options', async () => {
      await visit()
      await page.getByRole('button', { name: '下载选项', exact: true }).click()
      await page.getByLabel('User-Agent', { exact: true }).fill('ClashNova-Fixture/1.0')
      await page.getByLabel('下载超时（秒）', { exact: true }).fill('67')
      await page.getByLabel('下载代理', { exact: true }).selectOption('core')
      await page.getByLabel('采用订阅响应头的更新间隔（关闭自动更新时不生效）', { exact: true }).uncheck()
      const url = 'clash://install-config?url=https%3A%2F%2Fsubscription.example.invalid%2Fsub%3Ftoken%3Da%252Bb&name=fixture'
      await page.getByLabel('订阅链接', { exact: true }).fill(url)
      await page.getByRole('button', { name: '导入', exact: true }).click()
      await page.waitForFunction(() => window.__profileFeatureFixture.calls.some((item) => item.command === 'import_profile'))
      const [request] = await calls('import_profile')
      assert.equal(request.args.url, url)
      assert.deepEqual(request.args.options, { userAgent: 'ClashNova-Fixture/1.0', timeoutSec: 67, proxy: 'core', updateIntervalFromHeader: false })
    })

    await check('profiles_meta_failure_retains_advanced_download_draft', async () => {
      await visit()
      await page.locator('.pcard').first().getByRole('button', { name: /的订阅操作/ }).click()
      await page.getByRole('menuitem', { name: '编辑订阅信息', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '编辑订阅信息', exact: true })
      await dialog.getByLabel('User-Agent', { exact: true }).fill('draft-agent')
      await dialog.getByLabel('下载代理', { exact: true }).selectOption('direct')
      await page.evaluate(() => { window.__profileFeatureFixture.fail = 'update_profile_meta' })
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: 'fixture-operation-failed' }).waitFor()
      assert.equal(await dialog.getByLabel('User-Agent', { exact: true }).inputValue(), 'draft-agent')
      assert.equal(await dialog.getByLabel('下载代理', { exact: true }).inputValue(), 'direct')
      assert.equal((await calls('update_profile_meta'))[0].args.downloadOptions.userAgent, 'draft-agent')
    })

    await check('profiles_topology_preserves_extensions_and_emits_rename_map', async () => {
      await visit()
      const dialog = await openTopology()
      await dialog.getByLabel('名称', { exact: true }).fill('renamed-node')
      await dialog.getByLabel('服务器', { exact: true }).fill('changed.example.invalid')
      await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      const [request] = await calls('save_profile_topology')
      assert.equal(request.args.originalContent, 'ORIGINAL_PROFILE_CONTENT')
      assert.equal(request.args.proxies[0].server, 'changed.example.invalid')
      assert.equal(request.args.proxies[0].udp, true)
      assert.deepEqual(request.args.proxies[0]['ws-opts'], { path: '/fixture' })
      assert.deepEqual(request.args.groups[0].proxies, ['renamed-node', 'DIRECT'])
      assert.deepEqual(request.args.renames, { 'fixture-node': 'renamed-node' })
    })

    await check('profiles_topology_save_failure_keeps_editor_and_values', async () => {
      await visit()
      const dialog = await openTopology()
      await dialog.getByLabel('服务器', { exact: true }).fill('retry.example.invalid')
      await page.evaluate(() => { window.__profileFeatureFixture.fail = 'save_profile_topology' })
      await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: 'fixture-operation-failed' }).waitFor()
      assert.equal(await dialog.getByLabel('服务器', { exact: true }).inputValue(), 'retry.example.invalid')
      assert.ok(await dialog.isVisible())
      await page.evaluate(() => { window.__profileFeatureFixture.fail = '' })
      await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      assert.equal((await calls('save_profile_topology')).length, 2)
    })

    await check('profiles_topology_group_multiline_and_invalid_json_validation', async () => {
      await visit()
      const dialog = await openTopology()
      const advanced = dialog.getByLabel('高级字段（JSON，保留传输、TLS 等扩展参数）', { exact: true })
      await advanced.fill('{')
      await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: '有效的 JSON' }).waitFor()
      assert.equal((await calls('save_profile_topology')).length, 0)
      await advanced.fill('{"ws-opts":{"path":"/fixture"}}')
      await dialog.getByRole('button', { name: 'fixture-group', exact: true }).click()
      const members = dialog.getByLabel('节点或策略组（每行一个，按顺序）', { exact: true })
      await members.fill('DIRECT\nfixture-node')
      await members.press('End')
      await members.press('Enter')
      assert.equal(await members.inputValue(), 'DIRECT\nfixture-node\n')
      await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      assert.deepEqual((await calls('save_profile_topology'))[0].args.groups[0].proxies, ['DIRECT', 'fixture-node'])
    })

    await check('profiles_global_enhancers_create_reorder_toggle_and_delete', async () => {
      await visit()
      await page.getByRole('button', { name: '全局增强', exact: true }).click()
      for (const name of ['Shared A', 'Shared B']) {
        await page.getByRole('button', { name: '新建 Merge', exact: true }).click()
        const editor = page.getByRole('dialog', { name: '编辑增强项', exact: true })
        await editor.getByLabel('增强项名称', { exact: true }).fill(name)
        await editor.locator('.cm-content[contenteditable="true"]').fill('append-rules:\n  - MATCH,DIRECT\n')
        await editor.getByRole('button', { name: '保存', exact: true }).click()
        await editor.waitFor({ state: 'detached' })
      }
      assert.equal(await page.locator('.enh-row').count(), 2)
      await page.getByRole('button', { name: '上移增强项：Shared B', exact: true }).click()
      await page.waitForFunction(() => window.__profileFeatureFixture.global[0]?.name === 'Shared B')
      await page.getByRole('switch', { name: '启用增强项：Shared B', exact: true }).click()
      await page.waitForFunction(() => window.__profileFeatureFixture.global[0]?.enabled === false)
      await page.getByRole('button', { name: '删除增强项：Shared A', exact: true }).click()
      await page.locator('.enh-row').filter({ hasText: 'Shared A' }).getByRole('button', { name: '确认', exact: true }).click()
      await page.waitForFunction(() => window.__profileFeatureFixture.global.length === 1)
      for (const command of ['save_enhancer', 'reorder_enhancers', 'toggle_enhancer', 'delete_enhancer']) {
        assert.ok((await calls(command)).every((request) => request.args.profileId === '__global__'))
      }
    })

    assert.deepEqual(errors, [])
    console.log(`PROFILES BROWSER SUMMARY ${passed} passed, ${failed} failed, pageErrors=${errors.length}`)
    return { passed, failed, errors }
  } finally { await context.close() }
}
