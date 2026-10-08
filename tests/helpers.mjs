import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
export const root = path.resolve(import.meta.dirname, '..')
export const plain = (value) => JSON.parse(JSON.stringify(value))
export const tick = () => new Promise((resolve) => setImmediate(resolve))

export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** 使用项目锁定的 TypeScript 编译器，无新测试运行时或根目录构建产物。 */
export function loadSource(relative, imports = {}, globals = {}) {
  const media = Object.assign(new EventTarget(), { matches: false })
  const window = Object.assign(new EventTarget(), { matchMedia: () => media })
  const document = Object.assign(new EventTarget(), { hidden: false, documentElement: { dataset: {} } })
  const environment = {
    window, document, navigator: { userAgent: 'Windows' },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, URL, URLSearchParams, AbortController, AbortSignal, DOMException, CustomEvent, Event,
    ...globals,
  }
  const cache = new Map()
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports
    const source = readFileSync(filename, 'utf8')
    const compiled = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText
    const module = { exports: {} }
    cache.set(filename, module)
    vm.runInNewContext(compiled, {
      ...environment, module, exports: module.exports,
      require: (name) => {
        if (Object.hasOwn(imports, name)) return imports[name]
        if (name.startsWith('.')) {
          const base = path.resolve(path.dirname(filename), name)
          const target = ['', '.ts', '.tsx', '.json'].map((ext) => base + ext).find(existsSync)
          if (target?.endsWith('.json')) return require(target)
          if (target) return load(target)
        }
        return require(name)
      },
    }, { filename })
    return module.exports
  }
  return { module: load(path.join(root, relative)), environment, media }
}
