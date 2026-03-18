/**
 * apps/web/src/lib/sseClient.ts
 *
 * Reusable SSE consumer utility for streaming API responses.
 * Uses fetch() + ReadableStream to parse `data: {...}\n\n` SSE lines
 * and route parsed events to typed handler callbacks.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SSEEvent {
  type: 'progress' | 'output' | 'complete' | 'error'
  step?: string
  message?: string
  percent?: number
  line?: string
  success?: boolean
  code?: string
  version?: string
  [key: string]: unknown
}

export interface SSEHandlers {
  onProgress?: (event: SSEEvent) => void
  onOutput?: (event: SSEEvent) => void
  onComplete?: (event: SSEEvent) => void
  onError?: (event: SSEEvent) => void
}

// ─── Consumer ────────────────────────────────────────────────────────────────

/**
 * Consume an SSE endpoint via fetch + ReadableStream.
 * Returns an AbortController the caller can use to cancel the stream.
 */
export function consumeSSE(
  url: string,
  options: RequestInit,
  handlers: SSEHandlers,
): AbortController {
  const controller = new AbortController()

  void (async () => {
    try {
      const res = await fetch(url, { ...options, signal: controller.signal })

      if (!res.ok) {
        handlers.onError?.({
          type: 'error',
          code: `HTTP_${res.status}`,
          message: `Server returned ${res.status}`,
        })
        return
      }

      const body = res.body
      if (!body) {
        handlers.onError?.({ type: 'error', message: 'No response body' })
        return
      }

      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Split on double-newline (SSE message boundary)
        const parts = buffer.split('\n\n')
        // Last part is incomplete — keep in buffer
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          const trimmed = part.trim()
          if (!trimmed) continue

          // Extract the `data: ` payload (skip other SSE fields like `event:`, `id:`)
          const dataLine = trimmed.split('\n').find((l) => l.startsWith('data: '))
          if (!dataLine) continue

          const json = dataLine.slice(6) // strip "data: "
          try {
            const event = JSON.parse(json) as SSEEvent
            switch (event.type) {
              case 'progress':
                handlers.onProgress?.(event)
                break
              case 'output':
                handlers.onOutput?.(event)
                break
              case 'complete':
                handlers.onComplete?.(event)
                break
              case 'error':
                handlers.onError?.(event)
                break
            }
          } catch {
            // Malformed JSON — skip
          }
        }
      }
    } catch (err) {
      // AbortError is expected when the caller cancels — suppress silently
      if (err instanceof DOMException && err.name === 'AbortError') return
      handlers.onError?.({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })()

  return controller
}
