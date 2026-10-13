import type { ProfileTopology } from '../types/profileFeatures'

export type TopologyKind = 'proxies' | 'groups'
export interface TopologyEntry { originalName: string | null; value: Record<string, unknown> }
export interface TopologyDraft { content: string; proxies: TopologyEntry[]; groups: TopologyEntry[] }
export interface TopologyEdit { kind: TopologyKind; index: number; value: Record<string, unknown>; advanced: string; members: string; providers: string }

export const NODE_FIELDS = ['name', 'type', 'server', 'port', 'password', 'uuid', 'cipher', 'username', 'udp', 'tls']
export const GROUP_FIELDS = ['name', 'type', 'proxies', 'use', 'url', 'interval']
export const fieldNames = (kind: TopologyKind): string[] => kind === 'proxies' ? NODE_FIELDS : GROUP_FIELDS
export const entryName = (entry: Record<string, unknown>): string => String(entry.name ?? '')

export function createTopologyDraft(topology: ProfileTopology): TopologyDraft {
  const entries = (values: Record<string, unknown>[]): TopologyEntry[] => values.map((value) => ({ originalName: entryName(value), value }))
  return { content: topology.content, proxies: entries(topology.proxies), groups: entries(topology.groups) }
}

export function editTopologyEntry(draft: TopologyDraft, kind: TopologyKind, index: number): TopologyEdit {
  const value = { ...draft[kind][index].value }
  const advanced = Object.fromEntries(Object.entries(value).filter(([key]) => !fieldNames(kind).includes(key)))
  const lines = (value: unknown): string => Array.isArray(value) ? value.join('\n') : ''
  return { kind, index, value, advanced: JSON.stringify(advanced, null, 2), members: lines(value.proxies), providers: lines(value.use) }
}

export function applyTopologyEdit(draft: TopologyDraft, edit: TopologyEdit | null): TopologyDraft {
  if (!edit) return draft
  let advanced: unknown
  try { advanced = JSON.parse(edit.advanced) } catch { throw new Error('高级字段需要是有效的 JSON 对象') }
  if (!advanced || typeof advanced !== 'object' || Array.isArray(advanced)) throw new Error('高级字段需要是 JSON 对象')
  if (Object.keys(advanced).some((key) => fieldNames(edit.kind).includes(key))) throw new Error('高级字段不能重复定义上方表单字段')
  const primary = Object.fromEntries(Object.entries(edit.value).filter(([key]) => fieldNames(edit.kind).includes(key)))
  if (edit.kind === 'groups') {
    primary.proxies = edit.members.split('\n').map((line) => line.trim()).filter(Boolean)
    if (edit.providers.trim()) primary.use = edit.providers.split('\n').map((line) => line.trim()).filter(Boolean)
    else delete primary.use
  }
  const value = { ...advanced, ...primary }
  const name = entryName(value)
  if (!name.trim() || name !== name.trim() || /[,\r\n]/.test(name)) throw new Error('名称不能为空，或包含逗号、换行及首尾空白')
  for (const kind of ['proxies', 'groups'] as const) {
    if (draft[kind].some((entry, index) => !(kind === edit.kind && index === edit.index) && entryName(entry.value) === name)) {
      throw new Error('节点和策略组名称不能重复')
    }
  }
  const original = draft[edit.kind][edit.index]
  if (draft.proxies.concat(draft.groups).some((entry) => entry !== original && entry.originalName === name)) {
    throw new Error('这个名称属于本次编辑中的其他条目，请先保存后再重命名')
  }
  const oldName = entryName(original.value)
  const replace = (entry: TopologyEntry): TopologyEntry => {
    const next = { ...entry.value }
    if (Array.isArray(next.proxies)) next.proxies = next.proxies.map((member) => member === oldName ? name : member)
    if (next['dialer-proxy'] === oldName) next['dialer-proxy'] = name
    return { ...entry, value: next }
  }
  const next = { ...draft, proxies: draft.proxies.map(replace), groups: draft.groups.map(replace) }
  next[edit.kind][edit.index] = { ...original, value }
  return next
}

export function topologyPayload(draft: TopologyDraft) {
  const renames = Object.fromEntries(draft.proxies.concat(draft.groups)
    .filter((entry) => entry.originalName && entry.originalName !== entryName(entry.value))
    .map((entry) => [entry.originalName!, entryName(entry.value)]))
  return { originalContent: draft.content, proxies: draft.proxies.map((entry) => entry.value), groups: draft.groups.map((entry) => entry.value), renames }
}
