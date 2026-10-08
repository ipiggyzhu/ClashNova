/**
 * CodeMirror 6 代码编辑器(YAML / JavaScript / CSS),暗色 oneDark 主题,
 * 浅色主题跟随 [data-theme]。替代 M1 的纯 textarea。
 */
import { javascript } from '@codemirror/lang-javascript'
import { yaml } from '@codemirror/lang-yaml'
import { oneDark } from '@codemirror/theme-one-dark'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useAppStore } from '../../stores/app'
import './CodeEditor.css'

export type EditorLang = 'yaml' | 'javascript' | 'css' | 'text'

export interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  lang: EditorLang
  readOnly?: boolean
  label?: string
}

const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: true,
  autocompletion: true,
}

export default function CodeEditor({ value, onChange, lang, readOnly, label = '配置内容' }: CodeEditorProps) {
  const dark = useAppStore((s) => s.resolvedTheme === 'dark')
  const onChangeRef = useRef(onChange)
  useLayoutEffect(() => { onChangeRef.current = onChange }, [onChange])
  const handleChange = useCallback((next: string) => onChangeRef.current(next), [])

  const extensions = useMemo(
    () => [
      ...(lang === 'yaml' ? [yaml()] : lang === 'javascript' ? [javascript()] : []),
      EditorView.contentAttributes.of({ 'aria-label': label }),
    ],
    [lang, label],
  )

  return (
    <div className="code-editor-shell">
      <CodeMirror
        value={value}
        onChange={handleChange}
        extensions={extensions}
        theme={dark ? oneDark : 'light'}
        height="100%"
        className="code-editor"
        editable={!readOnly}
        readOnly={readOnly}
        indentWithTab={false}
        basicSetup={BASIC_SETUP}
      />
    </div>
  )
}
