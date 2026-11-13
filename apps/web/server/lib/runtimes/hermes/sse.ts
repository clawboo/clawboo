// A small server-sent-events reader for Hermes's API server streams.
//
// Fed text chunks as they arrive (any split, including inside a line or a
// CRLF pair), it calls back once per complete event. Follows the SSE format:
// `event:`, `data:` (several lines join with a newline), `id:`, comment lines
// starting with `:`, and a blank line ends the event. `retry:` is ignored.

export interface SseEvent {
  /** The `event:` field, or 'message' when the event named none. */
  event: string
  data: string
  /** The last `id:` seen on this stream, if any. */
  id: string | null
}

export interface SseReader {
  push(chunk: string): void
  /** End of stream: an event left without its blank line is dropped, as the
   *  format says. */
  end(): void
}

/** The longest an event may grow before the stream is treated as broken. */
export const MAX_SSE_EVENT_CHARS = 16 * 1024 * 1024

export function createSseReader(
  onEvent: (ev: SseEvent) => void,
  opts: { maxEventChars?: number; onOverflow?: () => void } = {},
): SseReader {
  const max = opts.maxEventChars ?? MAX_SSE_EVENT_CHARS
  let buf = ''
  let event = ''
  let data: string[] = []
  let dataChars = 0
  let lastId: string | null = null
  let broken = false

  const dispatch = (): void => {
    if (data.length > 0) {
      onEvent({ event: event || 'message', data: data.join('\n'), id: lastId })
    }
    event = ''
    data = []
    dataChars = 0
  }

  const line = (raw: string): void => {
    if (raw === '') {
      dispatch()
      return
    }
    if (raw.startsWith(':')) return
    const colon = raw.indexOf(':')
    const field = colon === -1 ? raw : raw.slice(0, colon)
    let value = colon === -1 ? '' : raw.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') {
      data.push(value)
      dataChars += value.length + 1
    } else if (field === 'id') {
      if (!value.includes('\0')) lastId = value
    }
  }

  return {
    push(chunk: string): void {
      if (broken) return
      buf += chunk
      for (;;) {
        // A lone CR at the very end may be the first half of a CRLF.
        let i = -1
        let len = 1
        for (let j = 0; j < buf.length; j++) {
          const c = buf.charCodeAt(j)
          if (c === 10) {
            i = j
            break
          }
          if (c === 13) {
            if (j === buf.length - 1) break
            i = j
            len = buf.charCodeAt(j + 1) === 10 ? 2 : 1
            break
          }
        }
        if (i === -1) break
        line(buf.slice(0, i))
        buf = buf.slice(i + len)
      }
      if (buf.length + dataChars > max) {
        broken = true
        buf = ''
        data = []
        opts.onOverflow?.()
      }
    },
    end(): void {
      buf = ''
      data = []
    },
  }
}
