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
  /** Where the search for the next line break resumes in `buf`: the part
   *  before it is one unfinished line already looked at. */
  let scanFrom = 0
  let event = ''
  let data: string[] = []
  let dataChars = 0
  let lastId: string | null = null
  let broken = false

  /** The stream is treated as broken from here on; nothing more is delivered. */
  const overflow = (): void => {
    broken = true
    buf = ''
    scanFrom = 0
    data = []
    dataChars = 0
    opts.onOverflow?.()
  }

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
      // Counted before the event can be dispatched, so an oversized one never is.
      dataChars += value.length + 1
      if (dataChars > max) return overflow()
      data.push(value)
    } else if (field === 'id') {
      if (!value.includes('\0')) lastId = value
    }
  }

  return {
    push(chunk: string): void {
      if (broken) return
      buf += chunk
      // Each character is looked at once: the search resumes where the last
      // chunk left it, and lines are cut from `start` without copying the rest.
      let start = 0
      let j = scanFrom
      while (j < buf.length) {
        const c = buf.charCodeAt(j)
        if (c !== 10 && c !== 13) {
          j++
          continue
        }
        // A lone CR at the very end may be the first half of a CRLF: look at it
        // again with the next chunk.
        if (c === 13 && j === buf.length - 1) break
        const end = j
        j += c === 13 && buf.charCodeAt(j + 1) === 10 ? 2 : 1
        if (end - start > max) return overflow()
        line(buf.slice(start, end))
        if (broken) return
        start = j
      }
      buf = buf.slice(start)
      scanFrom = j - start
      if (buf.length + dataChars > max) overflow()
    },
    end(): void {
      buf = ''
      scanFrom = 0
      data = []
      dataChars = 0
    },
  }
}
