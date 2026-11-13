// On a Mac the browser sends no key-up for a key pressed while Command is down,
// so such a key is pressed and released at once, never left held on the display.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  list: [] as { path: string; init?: RequestInit }[],
  push: null as ((text: string) => void) | null,
}))

vi.mock('@clawboo/control-client', () => ({
  apiUrl: (p: string) => p,
  apiFetch: async (path: string, init?: RequestInit) => {
    calls.list.push({ path, init })
    if (path.endsWith('/computer/live')) {
      const enc = new TextEncoder()
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            calls.push = (text) => c.enqueue(enc.encode(text))
          },
        }),
        { status: 200 },
      )
    }
    return new Response('{"ok":true}', { status: 200 })
  },
}))

Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })
const { ComputerScreen } = await import('../ComputerScreen')

const send = (event: string, data: unknown) =>
  act(() => calls.push!(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))

describe('ComputerScreen on a Mac', () => {
  it('presses and releases a key typed with Command at once', async () => {
    render(<ComputerScreen target={{ kind: 'dashboard', agentId: 'a1' }} />)
    await waitFor(() => expect(calls.push).not.toBeNull())
    send('hello', { viewerId: 'v-1' })
    send('source', { source: 'display', width: 4, height: 2 })
    send('control', { state: 'you', canControl: true })
    await screen.findByRole('button', { name: 'Hand back' })
    const held = screen.getByLabelText(/You have control/)
    fireEvent.keyDown(held, { key: 'Meta', code: 'MetaLeft', metaKey: true })
    fireEvent.keyDown(held, { key: 'v', code: 'KeyV', metaKey: true })
    fireEvent.keyUp(held, { key: 'Meta', code: 'MetaLeft' })
    await new Promise((r) => setTimeout(r, 120))
    const events = calls.list
      .filter((c) => c.path === '/api/agents/a1/computer/input')
      .flatMap((c) => (JSON.parse(String(c.init?.body)) as { events: unknown[] }).events)
    expect(events).toEqual([
      { t: 'k', s: 0xffe7, d: true },
      { t: 'k', s: 0x76, d: true },
      { t: 'k', s: 0x76, d: false },
      { t: 'k', s: 0xffe7, d: false },
    ])
  })
})
