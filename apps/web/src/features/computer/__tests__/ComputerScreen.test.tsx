// The live view on the dashboard: who has control, Take over and Hand back, and
// the person's keys going to the agent's display only while they hold it.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          calls.push = (text) => controller.enqueue(enc.encode(text))
        },
      })
      return new Response(body, { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  },
}))

const { ComputerScreen } = await import('../ComputerScreen')

function send(event: string, data: unknown): void {
  act(() => calls.push!(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
}

beforeEach(() => {
  calls.list = []
  calls.push = null
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = vi.fn(async () => ({
    width: 4,
    height: 2,
    close() {},
  }))
})
afterEach(() => vi.useRealTimers())

async function openOnDisplay(): Promise<void> {
  render(<ComputerScreen target={{ kind: 'dashboard', agentId: 'a1' }} />)
  await waitFor(() => expect(calls.push).not.toBeNull())
  send('hello', { viewerId: 'v-1' })
  send('source', { source: 'display', width: 4, height: 2 })
  send('control', { state: 'agent', canControl: true })
  send('rects', { width: 4, height: 2, rects: [{ x: 0, y: 0, w: 4, h: 2, png: 'AA==' }] })
}

describe('ComputerScreen', () => {
  it('offers Take over on an agent display, and sends it with this view’s id', async () => {
    await openOnDisplay()
    expect(await screen.findByText('Agent in control')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Take over' }))
    await waitFor(() =>
      expect(calls.list.some((c) => c.path === '/api/agents/a1/computer/control')).toBe(true),
    )
    const take = calls.list.find((c) => c.path === '/api/agents/a1/computer/control')!
    expect(JSON.parse(String(take.init?.body))).toEqual({ viewerId: 'v-1', action: 'take' })
  })

  it('sends keys only once this view has control, and offers Hand back', async () => {
    await openOnDisplay()
    const canvas = await screen.findByLabelText("The agent's screen")
    fireEvent.keyDown(canvas, { key: 'a' })
    await new Promise((r) => setTimeout(r, 80))
    expect(calls.list.some((c) => c.path.endsWith('/computer/input'))).toBe(false)

    send('control', { state: 'you', canControl: true })
    expect(await screen.findByRole('button', { name: 'Hand back' })).toBeTruthy()
    expect(screen.getByTestId('computer-control-warning').textContent).toMatch(/see what you type/)
    const held = screen.getByLabelText(/You have control/)
    fireEvent.keyDown(held, { key: 'a' })
    fireEvent.keyUp(held, { key: 'a' })
    await waitFor(() =>
      expect(calls.list.some((c) => c.path === '/api/agents/a1/computer/input')).toBe(true),
    )
    const input = calls.list.find((c) => c.path === '/api/agents/a1/computer/input')!
    expect(JSON.parse(String(input.init?.body))).toEqual({
      viewerId: 'v-1',
      events: [
        { t: 'k', s: 0x61, d: true },
        { t: 'k', s: 0x61, d: false },
      ],
    })
  })

  async function inControl() {
    await openOnDisplay()
    send('control', { state: 'you', canControl: true })
    await screen.findByRole('button', { name: 'Hand back' })
    return screen.getByLabelText(/You have control/)
  }

  async function inputEvents(): Promise<unknown[]> {
    await new Promise((r) => setTimeout(r, 120))
    return calls.list
      .filter((c) => c.path === '/api/agents/a1/computer/input')
      .flatMap((c) => (JSON.parse(String(c.init?.body)) as { events: unknown[] }).events)
  }

  it('releases a key with the keysym it was pressed with', async () => {
    const held = await inControl()
    fireEvent.keyDown(held, { key: 'Shift', code: 'ShiftLeft' })
    fireEvent.keyDown(held, { key: 'A', code: 'KeyA' })
    fireEvent.keyUp(held, { key: 'Shift', code: 'ShiftLeft' })
    fireEvent.keyUp(held, { key: 'a', code: 'KeyA' })
    expect(await inputEvents()).toEqual([
      { t: 'k', s: 0xffe1, d: true },
      { t: 'k', s: 0x41, d: true },
      { t: 'k', s: 0xffe1, d: false },
      { t: 'k', s: 0x41, d: false },
    ])
  })

  it('lets go of every held key when the window loses focus', async () => {
    const held = await inControl()
    fireEvent.keyDown(held, { key: 'Meta', code: 'MetaLeft' })
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(await inputEvents()).toEqual([
      { t: 'k', s: 0xffe7, d: true },
      { t: 'k', s: 0xffe7, d: false },
    ])
  })

  it('never moves a press to where a drag went next', async () => {
    const held = await inControl()
    const rect = vi
      .spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, top: 0, width: 300, height: 150 } as DOMRect)
    fireEvent.mouseMove(held, { clientX: 10, clientY: 10, buttons: 0 })
    fireEvent.mouseDown(held, { clientX: 10, clientY: 10, buttons: 1 })
    fireEvent.mouseMove(held, { clientX: 40, clientY: 10, buttons: 1 })
    fireEvent.mouseMove(held, { clientX: 60, clientY: 10, buttons: 1 })
    const events = (await inputEvents()) as { x: number; b: number }[]
    rect.mockRestore()
    expect(events.map((e) => [e.x, e.b])).toEqual([
      [10, 0],
      [10, 1],
      [60, 1],
    ])
  })

  it('never sends more than 200 events in one request, whatever piles up', async () => {
    const held = await inControl()
    for (let i = 0; i < 160; i++) {
      fireEvent.keyDown(held, { key: 'a', code: 'KeyA' })
      fireEvent.keyUp(held, { key: 'a', code: 'KeyA' })
    }
    await new Promise((r) => setTimeout(r, 150))
    const batches = calls.list
      .filter((c) => c.path === '/api/agents/a1/computer/input')
      .map((c) => (JSON.parse(String(c.init?.body)) as { events: unknown[] }).events.length)
    expect(Math.max(...batches)).toBeLessThanOrEqual(200)
    expect(batches.reduce((a, b) => a + b, 0)).toBe(320)
  })

  it('hands an agent back when the view moves to another agent while in control', async () => {
    const { rerender } = render(<ComputerScreen target={{ kind: 'dashboard', agentId: 'a1' }} />)
    await waitFor(() => expect(calls.push).not.toBeNull())
    send('hello', { viewerId: 'v-1' })
    send('source', { source: 'display', width: 4, height: 2 })
    send('control', { state: 'you', canControl: true })
    await screen.findByRole('button', { name: 'Hand back' })
    rerender(<ComputerScreen target={{ kind: 'dashboard', agentId: 'a2' }} />)
    await waitFor(() =>
      expect(calls.list.some((c) => c.path === '/api/agents/a1/computer/control')).toBe(true),
    )
    const release = calls.list.find((c) => c.path === '/api/agents/a1/computer/control')!
    expect(JSON.parse(String(release.init?.body))).toEqual({ viewerId: 'v-1', action: 'release' })
  })

  it('offers no Take over where the agent has only its browser', async () => {
    render(<ComputerScreen target={{ kind: 'dashboard', agentId: 'mac' }} />)
    await waitFor(() => expect(calls.push).not.toBeNull())
    send('hello', { viewerId: 'v-2' })
    send('source', { source: 'browser', width: null, height: null })
    send('control', { state: 'agent', canControl: false })
    send('image', { mimeType: 'image/jpeg', data: 'AA==', ts: 1 })
    expect(await screen.findByText('Browser')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull()
  })

  it('says when a person elsewhere holds the screen', async () => {
    await openOnDisplay()
    send('control', { state: 'other', canControl: true })
    expect(await screen.findByText('A person has control')).toBeTruthy()
  })

  it('covers the screen while a person elsewhere holds it, and shows it again when they hand back', async () => {
    await openOnDisplay()
    const canvas = await screen.findByLabelText("The agent's screen")
    await waitFor(() => expect(canvas.className).not.toMatch(/invisible/))
    expect(screen.queryByTestId('computer-screen-hidden')).toBeNull()

    send('control', { state: 'other', canControl: true })
    expect((await screen.findByTestId('computer-screen-hidden')).textContent).toMatch(
      /taken over this screen/,
    )
    expect(canvas.className).toMatch(/invisible/)

    send('control', { state: 'agent', canControl: true })
    await waitFor(() => expect(screen.queryByTestId('computer-screen-hidden')).toBeNull())
    expect(canvas.className).not.toMatch(/invisible/)
  })

  it('covers the screen in a view opened while a person elsewhere holds it', async () => {
    render(<ComputerScreen target={{ kind: 'dashboard', agentId: 'a1' }} />)
    await waitFor(() => expect(calls.push).not.toBeNull())
    send('hello', { viewerId: 'v-3' })
    send('source', { source: 'display', width: 4, height: 2 })
    send('control', { state: 'other', canControl: true })
    expect(await screen.findByTestId('computer-screen-hidden')).toBeTruthy()
    expect(screen.queryByText('Connecting to the agent’s screen…')).toBeNull()
  })
})
