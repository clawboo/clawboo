// A Server-Sent Events reader for a stream read with `fetch`.
//
// The live view reads its stream with `fetch` rather than `EventSource` because
// a link's page must send its token in a header (`EventSource` cannot set one,
// and a token in the URL would land in logs and history). This turns the bytes
// back into events: blocks separated by a blank line, `event:` and `data:`
// lines, `:` comments ignored.

export interface SseEvent {
  event: string
  data: string
}

export function createSseParser(onEvent: (e: SseEvent) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n?/g, '\n')
    let end = buffer.indexOf('\n\n')
    while (end >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (line === '' || line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      if (data.length > 0) onEvent({ event, data: data.join('\n') })
      end = buffer.indexOf('\n\n')
    }
  }
}
