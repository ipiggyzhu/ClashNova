import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { loadSource, root } from '../helpers.mjs'

test('native and mock cleanup preserve aggregation labels but still remove metadata nodes', () => {
  const native = readFileSync(root + '/src-tauri/src/profiles.rs', 'utf8').match(/const BUILTIN_PRUNE_SCRIPT: &str = r#"([\s\S]*?)"#;/)[1]
  const { mockHandlers } = loadSource('src/services/mock.ts').module
  const profile = mockHandlers.list_profiles().find((item) => item.current)
  const mock = mockHandlers.read_enhancer({ profileId: profile.id, enhancerId: 'builtin-prune-invalid-nodes' })
  const names = ['[当前订阅] 香港', 'subscription | Tokyo', '剩余流量 10GB', '订阅地址: example.invalid']
  for (const script of [native, mock]) {
    const input = { proxies: names.map((name) => ({ name })), 'proxy-groups': [{ name: 'select', proxies: names }], 'proxy-providers': { airport: { type: 'http' } } }
    const result = JSON.parse(vm.runInNewContext(`${script}\nJSON.stringify(main(${JSON.stringify(input)}))`, {}, { timeout: 1000 }))
    assert.deepEqual(result.proxies.map((node) => node.name), ['[当前订阅] 香港', 'subscription | Tokyo'])
    assert.deepEqual(result['proxy-groups'][0].proxies, ['[当前订阅] 香港', 'subscription | Tokyo'])
    const filter = new RegExp(result['proxy-providers'].airport['exclude-filter'].replace(/^\(\?i\)/, ''), 'i')
    assert.equal(filter.test('[当前订阅] 香港'), false)
    assert.equal(filter.test('剩余流量 10GB'), true)
  }
})

test('aggregation profile script preserves current-subscription labels while pruning metadata nodes', () => {
  const script = readFileSync(root + '/docs/examples/yunmeng-current-profile-script.js', 'utf8')
  const names = ['[当前订阅] 香港', 'subscription | Tokyo', '剩余流量 10GB', '订阅地址: example.invalid']
  const input = { proxies: names.map((name) => ({ name })) }
  const result = JSON.parse(vm.runInNewContext(
    `${script}\nJSON.stringify(main(${JSON.stringify(input)}, 'fixture'))`,
    {},
    { timeout: 1000 },
  ))
  const outputNames = result.proxies.map((node) => node.name)
  assert.ok(outputNames.includes('[当前订阅] 香港'))
  assert.ok(outputNames.includes('subscription | Tokyo'))
  assert.ok(!outputNames.includes('剩余流量 10GB'))
  assert.ok(!outputNames.includes('订阅地址: example.invalid'))
  assert.ok(result['proxy-groups'].some((group) => group.proxies.includes('[当前订阅] 香港')))
})
