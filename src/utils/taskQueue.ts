/** 同一 key 共享正在执行/排队的任务；所有调用共用并发预算。 */
export function createTaskQueue<T>(limit: number) {
  let active = 0
  const waiting: (() => void)[] = []
  const pending = new Map<string, Promise<T>>()

  return (key: string, task: () => Promise<T>): Promise<T> => {
    const existing = pending.get(key)
    if (existing) return existing
    const promise = new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active += 1
        void Promise.resolve().then(task).then(resolve, reject).finally(() => {
          active -= 1
          waiting.shift()?.()
        })
      }
      if (active < limit) run()
      else waiting.push(run)
    })
    pending.set(key, promise)
    const clear = (): void => { pending.delete(key) }
    void promise.then(clear, clear)
    return promise
  }
}
