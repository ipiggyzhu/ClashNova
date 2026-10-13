import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSource, plain } from '../helpers.mjs'

const { parseTunDraft } = loadSource('src/utils/tunOptions.ts', {}, { TextEncoder }).module
const { DEFAULT_TUN_OPTIONS } = loadSource('src/types/tun.ts').module
const draft = (patch = {}) => ({ options: { ...DEFAULT_TUN_OPTIONS }, mtu: '', device: '', interfaceName: '', dnsHijack: '', routeExcludeAddress: '', ...patch })

test('TUN defaults preserve legacy routing and distinguish inherited from cleared lists', () => {
  assert.deepEqual(plain(parseTunDraft(draft())), plain(DEFAULT_TUN_OPTIONS))
  assert.equal(parseTunDraft(draft({ dnsHijack: 'not applied' })).dnsHijack, null)
  assert.deepEqual(plain(parseTunDraft(draft({ options: { ...DEFAULT_TUN_OPTIONS, dnsHijack: [], routeExcludeAddress: [] } })).dnsHijack), [])
})

test('TUN accepts explicit interface, MTU, IPv4/IPv6 exclusions and DNS hijacking', () => {
  const result = parseTunDraft(draft({ options: { ...DEFAULT_TUN_OPTIONS, stack: 'mixed', dnsHijack: [], routeExcludeAddress: [] },
    mtu: '1500', device: 'ClashNova Test', interfaceName: 'Ethernet', dnsHijack: 'any:53\ntcp://[::1]:53', routeExcludeAddress: '10.0.0.0/8\nfd00::/8' }))
  assert.equal(result.mtu, 1500)
  assert.equal(result.device, 'ClashNova Test')
  assert.deepEqual(plain(result.dnsHijack), ['any:53', 'tcp://[::1]:53'])
})

test('TUN rejects malformed and out-of-range drafts without echoing input', () => {
  for (const mtu of ['575', '65536', '1e3', 'abc', '-1500', '0x600']) assert.throws(() => parseTunDraft(draft({ mtu })), /MTU/)
  for (const value of ['999.1.1.1/8', '10.0.0.0/33', 'fd00::/129', 'sensitive.invalid/8', '::/1/2']) {
    assert.throws(() => parseTunDraft(draft({ options: { ...DEFAULT_TUN_OPTIONS, routeExcludeAddress: [] }, routeExcludeAddress: value })), (error) => !error.message.includes(value))
  }
  for (const value of ['http://127.0.0.1:53', 'any:0', 'any:65536', 'host.invalid:53', '::1:53', 'tcp://::1:53', '[any]:53', '[127.0.0.1]:53']) {
    assert.throws(() => parseTunDraft(draft({ options: { ...DEFAULT_TUN_OPTIONS, dnsHijack: [] }, dnsHijack: value })), /DNS/)
  }
  assert.throws(() => parseTunDraft(draft({ device: 'x'.repeat(129) })), /名称/)
})
