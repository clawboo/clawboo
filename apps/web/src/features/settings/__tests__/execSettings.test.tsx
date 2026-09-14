// A permissions switch that reports what actually happened.
//
// The defect chain this closes has now been broken in three places, and each
// break was invisible from the one below it. The Gateway write lived in the
// browser behind `if (client)` inside a `catch {}`; that moved to the server,
// which returns 502 when the Gateway refuses. But `apiFetch` is a thin wrapper
// over `fetch`, so a 502 RESOLVES: the surrounding `catch` never ran, the
// refusal was discarded, and the success toast fired anyway. The server was
// telling the truth into a void.
//
// So the property here is not "does it save". It is "when it did not save, does
// the screen say so, and does the control stop claiming otherwise".

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { ExecSettings } from '../ExecSettings'
import { useToastStore } from '@/stores/toast'
import { useFleetStore } from '@/stores/fleet'

const AGENT = 'browser-test-boo'

/** Every POST body the component sent, so a silent extra writer would show up. */
let posts: unknown[] = []

const serveGet = (execAsk: string | null) =>
  server.use(
    http.get('/api/exec-settings', () =>
      HttpResponse.json({ values: execAsk ? { execAsk } : null }),
    ),
    // The standing-grant panel below the dropdown does its own read. These tests
    // are about the posture control, so it is served empty.
    http.get('/api/exec-allowlist', () => HttpResponse.json({ state: 'absent' })),
  )

const servePost = (status: number, body: unknown) =>
  server.use(
    http.post('/api/exec-settings', async ({ request }) => {
      posts.push(await request.json())
      return HttpResponse.json(body, { status })
    }),
  )

const toasts = () => useToastStore.getState().toasts

beforeEach(() => {
  posts = []
  useToastStore.setState({ toasts: [] })
  useFleetStore.setState({ agents: [] })
})
afterEach(() => {
  cleanup()
  server.resetHandlers()
})

// The picker is clawboo's own dropdown, not a native <select>: a trigger with
// aria-haspopup="listbox" and a portalled listbox of role="option" rows.
// The posture picker is clawboo's own dropdown: a trigger carrying
// aria-haspopup="listbox" and a portalled listbox of role="option" rows. Matched
// on haspopup rather than on being the only button, because the grants panel
// below contributes buttons of its own.
const trigger = async () => await screen.findByTestId('exec-ask-select')

async function choose(label: string) {
  const user = userEvent.setup()
  await user.click(await trigger())
  await user.click(await screen.findByRole('option', { name: label }))
}

const triggerLabel = async () => (await trigger()).textContent

describe('ExecSettings', () => {
  it('reports the change when the server applied it', async () => {
    serveGet('off')
    servePost(200, { ok: true, gateway: 'applied' })
    render(<ExecSettings agentId={AGENT} />)

    await choose('Ask for Unknown')
    await waitFor(() => expect(toasts().some((t) => t.type === 'success')).toBe(true))
    expect(posts).toEqual([{ agentId: AGENT, values: { execAsk: 'on-miss' } }])
  })

  it('does NOT claim success when the Gateway refused', async () => {
    // The whole point. A 502 resolves, so nothing throws, and the old code
    // toasted "Execution permissions updated" over a gate that was never applied.
    serveGet('off')
    servePost(502, {
      ok: false,
      savedLocally: true,
      error: 'saved in clawboo, but the Gateway did not accept it: gateway is down',
    })
    render(<ExecSettings agentId={AGENT} />)

    await choose('Ask for Unknown')
    await waitFor(() => expect(toasts().length).toBeGreaterThan(0))
    expect(toasts().every((t) => t.type !== 'success')).toBe(true)
    expect(toasts()[0]?.message).toMatch(/not applied/i)
  })

  it("repeats the server's own reason rather than a generic apology", async () => {
    serveGet('off')
    servePost(502, { error: 'the Gateway did not accept it: gateway is down' })
    render(<ExecSettings agentId={AGENT} />)

    await choose('Always Ask')
    await waitFor(() => expect(toasts().length).toBeGreaterThan(0))
    expect(toasts()[0]?.message).toMatch(/gateway is down/i)
  })

  it('puts the control back where it was when the change did not take', async () => {
    // A switch resting in the position you moved it to is itself a claim that the
    // change applied, and this control is read later as the state of the gate.
    serveGet('off')
    servePost(502, { error: 'nope' })
    render(<ExecSettings agentId={AGENT} />)

    await choose('Always Ask')
    await waitFor(() => expect(toasts().length).toBeGreaterThan(0))
    expect(await triggerLabel()).toContain('Run Freely')
    expect(useFleetStore.getState().agents).toEqual([])
  })

  it('treats an unreachable server as a failure, not a save', async () => {
    serveGet('off')
    server.use(http.post('/api/exec-settings', () => HttpResponse.error()))
    render(<ExecSettings agentId={AGENT} />)

    await choose('Ask for Unknown')
    await waitFor(() => expect(toasts().length).toBeGreaterThan(0))
    expect(toasts().every((t) => t.type !== 'success')).toBe(true)
  })

  it('writes the policy exactly once, through the server', async () => {
    // There were two browser-side writers of the Gateway's hash-guarded document
    // alongside the server's. The route is the only path now.
    serveGet('off')
    servePost(200, { ok: true, gateway: 'applied' })
    render(<ExecSettings agentId={AGENT} />)

    await choose('Ask for Unknown')
    await waitFor(() => expect(toasts().length).toBeGreaterThan(0))
    expect(posts).toHaveLength(1)
  })
})
