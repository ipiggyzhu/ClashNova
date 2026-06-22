/**
 * CodeMirror 6 代码编辑器(YAML / JavaScript / CSS),暗色 oneDark 主题,
 * 浅色主题跟随 [data-theme]。替代 M1 的纯 textarea。
 */
import { javascript } from '@codemirror/lang-javascript'
import { yaml } from '@codemirror/lang-yaml'
import { oneDark } from '@codemirror/theme-one-dark'
import CodeMirror from '@uiw/react-codemirror'
import { useAppStore } from '../../stores/app'
import './CodeEditor.css'

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
    <div className="code-editor-shell">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme={dark ? oneDark : 'light'}
        height="100%"
        className="code-editor"
        editable={!readOnly}
        readOnly={readOnly}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          autocompletion: true,
        }}
      />
    </div>
  )
}
