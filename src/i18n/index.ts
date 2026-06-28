/**
 * 轻量 i18n:中文原文作键。zh 恒等返回;en 查字典,缺失回退中文。
 * 语言取自 settings.language,切换即时生效(无需刷新)。
 */
import { useAppStore } from '../stores/app'
import type { Language } from '../types/clash'
import { EN } from './en'

export function translate(lang: Language, text: string): string {
  if (lang === 'zh') return text
  return EN[text] ?? text
}

/** 组件内取翻译函数(随 settings.language 响应式更新) */
export function useT(): (text: string) => string {
  const lang = useAppStore((s) => s.settings.language)
  return (text: string) => translate(lang ?? 'zh', text)
}
