import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSource } from '../helpers.mjs'

const { translate } = loadSource('src/i18n/index.ts', { '../stores/app': {} }).module

test('translations interpolate counts in both languages without dropping unknown placeholders', () => {
  assert.equal(translate('zh', '共{count}个节点', { count: 3 }), '共3个节点')
  assert.equal(translate('en', '共{count}个节点', { count: 3 }), 'Nodes: 3')
  assert.equal(translate('en', '{visible} / {total} 个连接', { visible: 2, total: 5 }), 'Connections: 2 / 5')
  assert.equal(translate('en', '第 {page} / {pages} 页 · {count} 条', { page: 2, pages: 3, count: '250' }), 'Page 2 / 3 · Rules: 250')
  assert.equal(translate('zh', '{known} {unknown}', { known: 0 }), '0 {unknown}')
  assert.equal(translate('en', 'missing {count}', { count: '{other}' }), 'missing {other}')
})

test('translation fallbacks accept only own dictionary and interpolation properties', () => {
  assert.equal(translate('en', '规则'), 'Rules')
  for (const key of ['toString', 'constructor', '__proto__', 'unlisted-label']) assert.equal(translate('en', key), key)
  assert.equal(translate('zh', '{count}', Object.create({ count: 12 })), '{count}')
})

test('relative times follow the selected language and retain Chinese as the default', () => {
  const now = Date.UTC(2026, 9, 16, 12)
  class Clock extends Date { static now() { return now } }
  const { fmtRelTime } = loadSource('src/utils/format.ts', {}, { Date: Clock }).module
  for (const [age, zh, en] of [
    [0, '刚刚', 'Just now'],
    [60_000, '1 分钟前', '1 min ago'],
    [120_000, '2 分钟前', '2 min ago'],
    [7_200_000, '2 小时前', '2 h ago'],
    [259_200_000, '3 天前', '3 d ago'],
  ]) {
    assert.equal(fmtRelTime(now - age), zh)
    assert.equal(fmtRelTime(now - age, 'zh'), zh)
    assert.equal(fmtRelTime(now - age, 'en'), en)
  }
  assert.equal(fmtRelTime(Date.UTC(2026, 0, 2, 12), 'en'), '1/2/2026')
})
