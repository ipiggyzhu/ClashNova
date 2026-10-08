import { lazy, Suspense } from 'react'
import type { CodeEditorProps } from './CodeEditor'

const CodeEditor = lazy(() => import('./CodeEditor'))

export default function LazyCodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<div role="status" style={{ flex: 1, padding: 16 }}>正在加载编辑器…</div>}>
      <CodeEditor {...props} />
    </Suspense>
  )
}
