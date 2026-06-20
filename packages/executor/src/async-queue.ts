// A minimal single-consumer push/pull async queue. Adapters bridge a callback
// event source (e.g. a WebSocket `onEvent`) into an `AsyncIterable` by pushing
// into the queue from the callback and letting the consumer pull via
// `for await`. Backpressure is drop-OLDEST at `max` — orchestration cares about
// tool-calls / done, not every text delta, so dropping the stalest buffered
// item is safer than unbounded memory growth if a consumer falls behind.

export interface AsyncQueue<T> extends AsyncIterable<T> {
  /** Enqueue a value (no-op once closed). */
  push(value: T): void
  /** End the stream; a pending/next `next()` resolves `{ done: true }`. */
  close(): void
  readonly closed: boolean
}

export function createAsyncQueue<T>(opts?: { max?: number }): AsyncQueue<T> {
  const max = opts?.max ?? 1000
  const buffer: T[] = []
  let resolveNext: ((r: IteratorResult<T>) => void) | null = null
  let closed = false

  const push = (value: T): void => {
    if (closed) return
    if (resolveNext) {
      const resolve = resolveNext
      resolveNext = null
      resolve({ value, done: false })
      return
    }
    if (buffer.length >= max) buffer.shift()
    buffer.push(value)
  }

  const close = (): void => {
    if (closed) return
    closed = true
    if (resolveNext) {
      const resolve = resolveNext
      resolveNext = null
      resolve({ value: undefined as never, done: true })
    }
  }

  return {
    push,
    close,
    get closed() {
      return closed
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift() as T, done: false })
          }
          if (closed) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise<IteratorResult<T>>((resolve) => {
            resolveNext = resolve
          })
        },
        return(): Promise<IteratorResult<T>> {
          close()
          return Promise.resolve({ value: undefined as never, done: true })
        },
      }
    },
  }
}
