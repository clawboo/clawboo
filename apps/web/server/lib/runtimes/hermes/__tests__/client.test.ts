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
