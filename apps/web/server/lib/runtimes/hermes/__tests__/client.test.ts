// The Hermes API client: the key only ever rides the Authorization header, a
// start can carry an idempotency key, and each run event carries its sequence
// number even when only the frame's id names it.

import { describe, expect, it } from 'vitest'

import { createHermesClient, type HermesRunEvent } from '../client'

const sse = (frames: string): Response =>
  new Response(frames, { headers: { 'content-type': 'text/event-stream' } })

describe('createHermesClient', () => {
  it("reads a run event's sequence from the frame id when its JSON has none", async () => {
    const client = createHermesClient(
      { baseUrl: 'http://127.0.0.1:1', profile: 'cb-a', key: 'k'.repeat(64) },
      {
        fetch: (async () =>
          sse(
            ': open\n\n' +
              'id: 7\ndata: {"event":"message.delta","delta":"a"}\n\n' +
              'id: 8\ndata: {"event":"message.delta","delta":"b","seq":8}\n\n',
          )) as unknown as typeof fetch,
      },
    )
    const got: HermesRunEvent[] = []
    await client.streamEvents('run_1', (ev) => got.push(ev))
    expect(got.map((e) => e.seq)).toEqual([7, 8])
  })

  it('sends a start with its idempotency key, and the key only in Authorization', async () => {
    const seen: { url: string; headers: Headers; body: string }[] = []
    const client = createHermesClient(
      { baseUrl: 'http://127.0.0.1:1', profile: 'cb-a', key: 'secret-key-0123456789' },
      {
        fetch: (async (input: unknown, init?: RequestInit) => {
          seen.push({
            url: String(input),
            headers: new Headers(init?.headers),
            body: String(init?.body ?? ''),
          })
          return new Response(JSON.stringify({ run_id: 'run_9', status: 'started' }), {
            status: 202,
          })
        }) as unknown as typeof fetch,
      },
    )
    await expect(
      client.startRun({ input: 'hi', session_id: 's1' }, { idempotencyKey: 'key-1' }),
    ).resolves.toEqual({ runId: 'run_9' })
    expect(seen[0]!.url).toBe('http://127.0.0.1:1/p/cb-a/v1/runs')
    expect(seen[0]!.headers.get('idempotency-key')).toBe('key-1')
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer secret-key-0123456789')
    expect(seen[0]!.url + seen[0]!.body).not.toContain('secret-key')
  })
})

describe('a run event stream that goes quiet', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** A stream that sends `first`, then a keepalive comment every `keepaliveMs`
   *  for `keepaliveFor` ms, then `last` (if any) and closes; with no `last` it
   *  stays open. It errors when the request's signal aborts, as fetch does. */
  const streaming =
    (opts: { first: string; keepaliveMs?: number; keepaliveFor?: number; last?: string }) =>
    async (_input: unknown, init?: RequestInit): Promise<Response> => {
      const enc = new TextEncoder()
      let timer: ReturnType<typeof setInterval> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(opts.first))
          init?.signal?.addEventListener('abort', () => {
            clearInterval(timer)
            c.error(init.signal!.reason)
          })
          if (opts.keepaliveMs) {
            const until = Date.now() + (opts.keepaliveFor ?? 0)
            timer = setInterval(() => {
              if (Date.now() < until) return c.enqueue(enc.encode(': keepalive\n\n'))
              clearInterval(timer)
              if (opts.last !== undefined) {
                c.enqueue(enc.encode(opts.last))
                c.close()
              }
            }, opts.keepaliveMs)
          }
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }

  const clientWith = (f: ReturnType<typeof streaming>) =>
    createHermesClient(
      { baseUrl: 'http://127.0.0.1:1', profile: 'cb-a', key: 'k'.repeat(64) },
      { fetch: f as unknown as typeof fetch },
    )

  it('gives up on a stream that sends nothing for its idle time, so the run can be read again', async () => {
    const client = clientWith(
      streaming({ first: 'id: 1\ndata: {"event":"message.delta","delta":"a"}\n\n' }),
    )
    const got: HermesRunEvent[] = []
    const ended = client
      .streamEvents('run_1', (ev) => got.push(ev), { idleMs: 60 })
      .then(
        () => 'ended',
        () => 'ended',
      )
    await expect(Promise.race([ended, sleep(2_000).then(() => 'still open')])).resolves.toBe(
      'ended',
    )
    expect(got.map((e) => e.seq)).toEqual([1])
  })

  it('keeps a stream whose run is quiet but whose keepalives keep coming', async () => {
    const client = clientWith(
      streaming({
        first: ': open\n\n',
        keepaliveMs: 20,
        keepaliveFor: 300,
        last: 'id: 2\ndata: {"event":"run.completed","output":"ok"}\n\n',
      }),
    )
    const got: HermesRunEvent[] = []
    await client.streamEvents('run_1', (ev) => got.push(ev), { idleMs: 100 })
    expect(got.map((e) => e.event)).toEqual(['run.completed'])
  })

  it("still ends at once when the caller's own signal aborts", async () => {
    const client = clientWith(streaming({ first: ': open\n\n' }))
    const stop = new AbortController()
    const p = client.streamEvents('run_1', () => undefined, { signal: stop.signal, idleMs: 5_000 })
    setTimeout(() => stop.abort(), 20)
    await expect(Promise.race([p, sleep(1_000).then(() => 'still open')])).rejects.toBeTruthy()
  })
})
