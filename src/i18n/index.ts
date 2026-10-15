/**
 * 轻量 i18n:中文原文作键。zh 使用原文;en 查字典,缺失回退中文。
 * 语言取自 settings.language,切换即时生效(无需刷新)。
 */
import { useCallback } from 'react'
import { useAppStore } from '../stores/app'
import type { Language } from '../types/clash'
import { EN } from './en'

type TranslationValues = Record<string, string | number>

export function translate(lang: Language, text: string, values?: TranslationValues): string {
  const translated = lang === 'en' && Object.prototype.hasOwnProperty.call(EN, text) ? EN[text] ?? text : text
  if (!values) return translated
  return translated.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : placeholder,
  )
}

/** 组件内取翻译函数(随 settings.language 响应式更新) */
export function useT(): (text: string, values?: TranslationValues) => string {
  const lang = useAppStore((s) => s.settings.language)
  return useCallback((text: string, values?: TranslationValues) => translate(lang ?? 'zh', text, values), [lang])
}
