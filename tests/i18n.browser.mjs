import assert from 'node:assert/strict'

export async function runI18nBrowser(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let passed = 0, failed = 0
  const check = async (name, action) => {
    try { await action(); passed++; console.log('PASS ' + name) }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + (error.stack ?? error)) }
  }
  const language = async value => {
    await page.evaluate(async language => {
      await (await import('/src/stores/app.ts')).useAppStore.getState().patchSettings({ language })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }, value)
  }
  const visit = async route => {
    await page.goto(base + '/' + route, { waitUntil: 'networkidle' })
    await page.locator('.pg-' + route).waitFor()
    await language('zh')
  }
  const freezeStreams = () => page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  // Only replace the existing mock transport branches; render real pages, hooks and stores.
  const replaceApi = replacements => page.route('**/src/services/api.ts*', async route => {
    const response = await route.fetch()
    let source = await response.text()
    for (const [before, after] of replacements) {
      assert.ok(source.includes(before), 'Missing transport fixture boundary: ' + before)
      source = source.replace(before, after)
    }
    await route.fulfill({ response, body: source })
  })

  try {
    const routes = [
      ['dashboard', [
        ['.card-head h3', '运行状态', 'Runtime status'], ['.card-head h3', '网络状态', 'Network status'],
        ['.card-head h3', '7 天流量趋势', '7-day traffic trend'], ['.stat-label', '在线时长', 'Uptime'],
      ]],
      ['traffic', [
        ['.card-head h3', '多维统计', 'Traffic breakdown'], ['.card-head h3', '实时速率', 'Live rates'],
        ['.seg button', '按域名', 'By domain'],
      ]],
      ['connections', [
        ['.seg', '连接分类', 'Connection category', 'aria-label'],
        ['input', '搜索主机 / 进程 / 规则', 'Search hosts / processes / rules', 'placeholder'],
        ['select', '排序', 'Sort', 'aria-label'],
      ]],
      ['logs', [
        ['.console', '内核日志', 'Core logs', 'aria-label'], ['.seg button', '警告', 'Warning'],
        ['input', '过滤关键字…', 'Filter by keyword…', 'placeholder'],
      ]],
      ['topology', [
        ['.card-head h3', '连接拓扑', 'Connection topology'], ['.lg', '源 IP', 'Source IP'],
        ['svg.topo-svg', '连接拓扑桑基图', 'Connection topology Sankey diagram', 'aria-label'],
      ]],
      ['routemap', [
        ['.card-head h3', '路由地图', 'Route Map'], ['.lg-hint', '弧线宽度 ∝ 累计流量', 'Arc width ∝ cumulative traffic'],
        ['svg.flat-svg', '路由平面地图', 'Flat route map', 'aria-label'],
      ]],
      ['proxies', [
        ['input', '搜索节点 / 代理组', 'Search nodes / proxy groups', 'placeholder'],
        ['.seg', '节点排序', 'Node sorting', 'aria-label'], ['.toolbar button', '隐藏超时', 'Hide timeouts'],
      ]],
      ['rules', [
        ['.card-head h3', '规则列表', 'Rule list'], ['.fchips button', '全部', 'All'],
        ['input', '搜索规则 / 域名 / IP…', 'Search rules / domains / IPs…', 'placeholder'],
      ]],
      ['providers', [
        ['.sec-head', '规则提供者', 'Rule providers'], ['button', '全部更新', 'Update all'],
        ['th', '行为', 'Behavior'],
      ]],
    ]
    for (const [route, probes] of routes) {
      await check('i18n_' + route + '_switches_in_place', async () => {
        await visit(route)
        await page.evaluate(route => { window.__i18nPage = document.querySelector('.pg-' + route) }, route)
        for (const [lang, column] of [['en', 2], ['zh', 1]]) {
          await language(lang)
          for (const probe of probes) {
            const values = await page.locator('.pg-' + route).locator(probe[0]).evaluateAll(
              (nodes, attr) => nodes.map(node => (attr ? node.getAttribute(attr) : node.textContent)?.trim()), probe[3],
            )
            assert.ok(values.includes(probe[column]), route + ': expected ' + probe[column] + ', got ' + values.join(' | '))
          }
          assert.ok(await page.evaluate(route => window.__i18nPage === document.querySelector('.pg-' + route), route), 'Language change must not remount the page')
        }
      })
    }

    await check('i18n_connections_keep_search_and_user_data_and_translate_details', async () => {
      await visit('connections')
      await freezeStreams()
      await page.evaluate(async () => {
        const { useLiveStore } = await import('/src/stores/live.ts')
        const conn = (id, host) => ({
          id, metadata: { host, destinationIP: '192.0.2.1', destinationPort: '443', sourceIP: '127.0.0.1', sourcePort: '1234', network: 'tcp', process: '规则' },
          rule: 'DomainSuffix', rulePayload: '测试', chains: ['全部节点', '代理'], upload: 100, download: 200, start: new Date().toISOString(),
        })
        useLiveStore.getState().setConnections({ uploadTotal: 200, downloadTotal: 400, connections: [conn('one', '节点.测试'), conn('two', 'other.invalid')] })
      })
      const input = page.locator('.pg-connections input')
      await input.fill('节点.测试')
      await page.locator('.conn-row').first().waitFor()
      await input.evaluate(node => { window.__i18nInput = node })
      await language('en')
      assert.equal(await input.inputValue(), '节点.测试')
      assert.ok(await input.evaluate(node => node === window.__i18nInput))
      assert.equal(await page.locator('.conn-row').count(), 1)
      assert.equal(await page.locator('.pg-connections .toolbar > .chip').textContent(), 'Connections: 1 / 2')
      assert.ok((await page.locator('.conn-row').textContent()).includes('代理 → 全部节点'))
      await page.locator('.conn-row').click()
      const detail = page.getByRole('dialog', { name: 'Connection details', exact: true })
      await detail.waitFor()
      assert.ok(await detail.getByText('Source address', { exact: true }).isVisible())
      assert.ok(await detail.getByText('规则', { exact: true }).isVisible())
      assert.ok(await detail.getByText('代理 → 全部节点', { exact: true }).isVisible())
      await language('zh')
      assert.ok(await page.getByRole('dialog', { name: '连接详情', exact: true }).isVisible())
      assert.equal(await input.inputValue(), '节点.测试')
      await page.keyboard.press('Escape')
    })

    await check('i18n_logs_translate_buffer_and_transport_but_not_log_payloads', async () => {
      await visit('logs')
      await freezeStreams()
      await page.evaluate(async () => {
        const { useLiveStore } = await import('/src/stores/live.ts')
        useLiveStore.getState().clearLogs()
        useLiveStore.setState(state => ({
          status: { ...state.status, logs: 'paused' },
          logs: [
            { id: 9001, type: 'info', time: '12:00:00', payload: '规则 using 全部节点 match 代理' },
            { id: 9002, type: 'warning', time: '12:00:01', payload: '保留原始日志' },
          ],
        }))
      })
      await page.locator('.pg-logs input').fill('规则')
      await language('en')
      assert.equal(await page.locator('.console .line').count(), 1)
      assert.equal(await page.locator('.console .msg').textContent(), '规则 using 全部节点 match 代理')
      assert.match(await page.locator('.pg-logs .foot').textContent(), /Buffered lines: 2.*Window hidden; connection paused/)
      await language('zh')
      assert.match(await page.locator('.pg-logs .foot').textContent(), /已缓冲 2 行.*窗口隐藏，已暂停连接/)
    })

    await check('i18n_rules_keep_pagination_filter_and_user_names', async () => {
      await replaceApi([['return mockRules()', 'return Array.from({ length: 205 }, (_, i) => ({ type: "DomainSuffix", payload: "规则-" + i, proxy: "全部节点" }))']])
      try {
        await visit('rules')
        await page.getByRole('button', { name: '下一页', exact: true }).click()
        await page.getByText('规则-100', { exact: true }).waitFor()
        await language('en')
        assert.equal(await page.locator('.pagination > span').textContent(), 'Page 2 / 3 · Rules: 205')
        assert.ok(await page.getByText('规则-100', { exact: true }).isVisible())
        assert.equal(await page.locator('.rule-row .target').first().textContent(), '全部节点')
        await page.locator('.pg-rules input').fill('规则-200')
        await language('zh')
        assert.equal(await page.locator('.pg-rules input').inputValue(), '规则-200')
        assert.equal(await page.locator('.rule-row').count(), 1)
        assert.equal(await page.locator('.pagination > span').textContent(), '第 1 / 1 页 · 1 条')
      } finally { await page.unroute('**/src/services/api.ts*') }
    })

    await check('i18n_proxies_do_not_translate_or_disable_a_user_group_named_all_nodes', async () => {
      await replaceApi([
        ['return mockProxies()', 'return window.__i18nProxies'],
        ['mockSelectProxy(group, name)', 'window.__i18nSelections.push({ group, name }); window.__i18nProxies.proxies[group].now = name'],
      ])
      await page.addInitScript(() => {
        window.__i18nSelections = []
        window.__i18nProxies = { proxies: {
          '全部节点': { name: '全部节点', type: 'Selector', now: '直连', all: ['直连', '代理'], history: [] },
          '直连': { name: '直连', type: 'Shadowsocks', history: [] },
          '代理': { name: '代理', type: 'Shadowsocks', history: [] },
        } }
      })
      try {
        await visit('proxies')
        await language('en')
        const user = page.locator('.card').filter({ has: page.getByRole('heading', { name: '全部节点', exact: true }) })
        assert.equal(await user.count(), 1)
        assert.equal(await page.getByRole('heading', { name: 'All nodes', exact: true }).count(), 1)
        assert.equal(await page.locator('.pg-proxies .toolbar > .chip').textContent(), 'Nodes: 2')
        await user.locator('.node').filter({ hasText: '代理' }).click()
        await page.waitForFunction(() => window.__i18nSelections.length === 1)
        assert.deepEqual(await page.evaluate(() => window.__i18nSelections), [{ group: '全部节点', name: '代理' }])
        await page.locator('.pg-proxies input').fill('代理')
        await language('zh')
        assert.equal(await page.locator('.pg-proxies input').inputValue(), '代理')
        assert.equal(await user.count(), 2, 'Chinese UI may share the same visible title, but both cards remain separate')
      } finally { await page.unroute('**/src/services/api.ts*') }
    })

    await check('i18n_providers_translate_results_and_errors_without_restarting_queries', async () => {
      await replaceApi([
        ['return mockProxyProviders()', 'window.__providerQueries++; if (window.__providerFail) throw new Error("保留原始详情"); return [{ name: "规则", vehicleType: "HTTP", nodeCount: 2, updatedAt: Date.now() - 120000 }]'],
        ['return mockRuleProviders()', 'window.__providerQueries++; if (window.__providerFail) throw new Error("保留原始详情"); return [{ name: "代理", vehicleType: "HTTP", behavior: "classical", ruleCount: 3, updatedAt: Date.now() - 120000 }]'],
        ['mockUpdateProxyProvider(name)', 'window.__providerUpdates.push(name)'],
        ['mockUpdateRuleProvider(name)', 'window.__providerUpdates.push(name); throw new Error("保留原始详情")'],
      ])
      await page.addInitScript(() => { window.__providerQueries = 0; window.__providerUpdates = []; window.__providerFail = false })
      try {
        await visit('providers')
        await page.getByRole('heading', { name: '规则', exact: true }).waitFor()
        const before = await page.evaluate(() => window.__providerQueries)
        await language('en')
        assert.equal(await page.evaluate(() => window.__providerQueries), before, 'A language change must not restart provider requests')
        assert.equal(await page.locator('.pv-meta').textContent(), 'Updated 2 min ago')
        assert.equal(await page.locator('.pg-providers tbody .mono').textContent(), '代理')
        await page.getByRole('button', { name: 'Update all', exact: true }).click()
        await page.getByRole('status').waitFor()
        assert.equal(await page.getByRole('status').textContent(), 'Update complete: 1 succeeded, 1 failed')
        assert.deepEqual((await page.evaluate(() => window.__providerUpdates)).sort(), ['代理', '规则'])
        await language('zh')
        assert.equal(await page.getByRole('status').textContent(), '更新完成：1 项成功，1 项失败')
        await page.evaluate(() => { window.__providerFail = true; window.dispatchEvent(new CustomEvent('clashnova-api-config-changed')) })
        await page.getByRole('alert').filter({ hasText: '代理提供者加载失败' }).waitFor()
        const after = await page.evaluate(() => window.__providerQueries)
        await language('en')
        assert.ok(await page.getByRole('alert').filter({ hasText: /Could not load proxy providers:.*保留原始详情/ }).isVisible())
        assert.ok(await page.getByRole('alert').filter({ hasText: /Could not load rule providers:.*保留原始详情/ }).isVisible())
        assert.equal(await page.evaluate(() => window.__providerQueries), after)
      } finally { await page.unroute('**/src/services/api.ts*') }
    })

    await check('i18n_topology_separates_generated_labels_from_same_named_user_data', async () => {
      await visit('topology')
      await freezeStreams()
      await page.evaluate(async () => {
        const { useLiveStore } = await import('/src/stores/live.ts')
        const names = ['其他', '', '未知进程', ...Array.from({ length: 8 }, (_, i) => '进程-' + i)]
        useLiveStore.getState().setConnections({ uploadTotal: 0, downloadTotal: 0, connections: names.map((process, i) => ({
          id: 'topology-' + i, metadata: { host: 'example.invalid', destinationIP: '192.0.2.1', destinationPort: '443', sourceIP: '', sourcePort: '1234', network: 'tcp', process },
          rule: 'DomainSuffix', rulePayload: '规则', chains: ['代理'], upload: 0, download: i < 3 ? 10000 - i * 1000 : 100, start: new Date().toISOString(),
        })) })
      })
      await language('en')
      const labels = await page.locator('.topo-svg text:not(.sub)').allTextContents()
      for (const label of ['Local', 'Unknown process', 'Other', '其他', '未知进程', '代理']) assert.ok(labels.includes(label), 'Missing topology label: ' + label)
      await language('zh')
      const translated = await page.locator('.topo-svg text:not(.sub)').allTextContents()
      assert.equal(translated.filter(label => label === '未知进程').length, 2)
      assert.equal(translated.filter(label => label === '其他').length, 2)
    })

    await check('i18n_document_language_follows_main_window_and_tray', async () => {
      await visit('dashboard')
      await language('en')
      assert.equal(await page.locator('html').getAttribute('lang'), 'en')
      await language('zh')
      assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
      await page.goto(base + '/tray', { waitUntil: 'networkidle' })
      await page.locator('.tray-panel').waitFor()
      for (const [lang, tag] of [['en', 'en'], ['zh', 'zh-CN']]) {
        await language(lang)
        assert.equal(await page.locator('html').getAttribute('lang'), tag)
      }
    })

    await check('i18n_browser_has_no_page_errors', async () => assert.deepEqual(errors, []))
  } finally { await context.close() }
  return { passed, failed }
}
