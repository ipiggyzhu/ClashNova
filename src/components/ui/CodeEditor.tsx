/**
 * CodeMirror 6 代码编辑器(YAML / JavaScript / CSS),暗色 oneDark 主题,
 * 浅色主题跟随 [data-theme]。替代 M1 的纯 textarea。
 */
import { javascript } from '@codemirror/lang-javascript'
import { yaml } from '@codemirror/lang-yaml'
import { oneDark } from '@codemirror/theme-one-dark'
import CodeMirror from '@uiw/react-codemirror'
import { useAppStore } from '../../stores/app'

export type EditorLang = 'yaml' | 'javascript' | 'css'

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  lang: EditorLang
  readOnly?: boolean
}

export default function CodeEditor({ value, onChange, lang, readOnly }: CodeEditorProps) {
  const theme = useAppStore((s) => s.settings.theme)
  const dark =
    theme === 'system'
      ? !window.matchMedia('(prefers-color-scheme: light)').matches
      : theme === 'dark'

  const extensions =
    lang === 'yaml' ? [yaml()] : lang === 'javascript' ? [javascript()] : []

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={dark ? oneDark : 'light'}
      height="100%"
      style={{ flex: 1, minHeight: 0, overflow: 'hidden', fontSize: 12.5 }}
      editable={!readOnly}
      readOnly={readOnly}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: true,
        autocompletion: false,
      }}
    />
  )
}
