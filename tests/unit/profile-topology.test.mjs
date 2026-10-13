import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSource, plain } from '../helpers.mjs'

const { module: topology } = loadSource('src/components/profileTopology.ts')
const fixture = () => topology.createTopologyDraft({
  content: 'fixture-source',
  proxies: [{ name: 'node', type: 'socks5', server: 'proxy.example.invalid', port: 1080, udp: true, 'ws-opts': { path: '/fixture' } }],
  groups: [{ name: 'group', type: 'select', proxies: ['node', 'DIRECT'], use: ['airport'] }],
})

test('topology form retains fields it does not edit', () => {
  const draft = fixture()
  const edit = topology.editTopologyEntry(draft, 'proxies', 0)
  edit.value.server = 'changed.example.invalid'
  const next = topology.applyTopologyEdit(draft, edit)
  const payload = topology.topologyPayload(next)
  assert.equal(payload.originalContent, 'fixture-source')
  assert.equal(payload.proxies[0].server, 'changed.example.invalid')
  assert.equal(payload.proxies[0].udp, true)
  assert.deepEqual(plain(payload.proxies[0]['ws-opts']), { path: '/fixture' })
  assert.equal(draft.proxies[0].value.server, 'proxy.example.invalid')
})

test('topology renames are flattened and update member references', () => {
  let draft = fixture()
  let edit = topology.editTopologyEntry(draft, 'proxies', 0)
  edit.value.name = 'node-next'
  draft = topology.applyTopologyEdit(draft, edit)
  edit = topology.editTopologyEntry(draft, 'proxies', 0)
  edit.value.name = 'node-final'
  draft = topology.applyTopologyEdit(draft, edit)
  const payload = topology.topologyPayload(draft)
  assert.deepEqual(plain(payload.renames), { node: 'node-final' })
  assert.deepEqual(plain(payload.groups[0].proxies), ['node-final', 'DIRECT'])
})

test('topology groups preserve member ordering and editable newline drafts', () => {
  const draft = fixture()
  const edit = topology.editTopologyEntry(draft, 'groups', 0)
  edit.members = 'DIRECT\nnode\n'
  edit.providers = 'airport\nother\n'
  assert.equal(edit.members.endsWith('\n'), true)
  const payload = topology.topologyPayload(topology.applyTopologyEdit(draft, edit))
  assert.deepEqual(plain(payload.groups[0].proxies), ['DIRECT', 'node'])
  assert.deepEqual(plain(payload.groups[0].use), ['airport', 'other'])
})

test('topology advanced JSON cannot overwrite primary fields or silently discard errors', () => {
  const draft = fixture()
  for (const advanced of ['{', '[]', 'null', '{"name":"bypass"}']) {
    const edit = topology.editTopologyEntry(draft, 'proxies', 0)
    edit.advanced = advanced
    assert.throws(() => topology.applyTopologyEdit(draft, edit), /JSON|表单/)
    assert.equal(draft.proxies[0].value.name, 'node')
  }
})

test('topology rejects ambiguous and duplicate names before IPC', () => {
  const draft = fixture()
  for (const name of ['', ' group ', 'node,other', 'group']) {
    const edit = topology.editTopologyEntry(draft, 'proxies', 0)
    edit.value.name = name
    assert.throws(() => topology.applyTopologyEdit(draft, edit))
  }
})
