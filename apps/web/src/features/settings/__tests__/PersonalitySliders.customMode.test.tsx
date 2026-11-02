// The Personality panel in custom-instructions mode. The sliders and presets
// were only dimmed with `pointerEvents: none`, so the keyboard still reached
// them, and a key press saved the slider personality with `customText: null`
// and rewrote SOUL.md: the custom instructions were gone.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { DEFAULT_PERSONALITY, mergeSoulWithCustomPersonality } from '@/lib/soulPersonality'

import { PersonalitySliders } from '../PersonalitySliders'

// Unique per file: mutationQueue is a module-level singleton keyed by agentId.
const AGENT_ID = 'agent-personality-custom-1'
const CUSTOM = 'Answer like a ship captain reading the logbook aloud.'

let posts: Record<string, unknown>[] = []
let soulWrites: string[] = []

beforeEach(() => {
  posts = []
  soulWrites = []
  server.use(
    http.get('/api/personality', () =>
      HttpResponse.json({ values: DEFAULT_PERSONALITY, customText: CUSTOM }),
    ),
    http.get('/api/agents/:id/files/:name', () =>
      HttpResponse.json({
        name: 'SOUL.md',
        content: mergeSoulWithCustomPersonality('# SOUL\n\nRole.', CUSTOM),
      }),
    ),
    http.post('/api/personality', async ({ request }) => {
      posts.push((await request.json()) as Record<string, unknown>)
      return HttpResponse.json({ ok: true })
    }),
    http.put('/api/agents/:id/files/:name', async ({ request }) => {
      soulWrites.push(((await request.json()) as { content: string }).content)
      return HttpResponse.json({ ok: true })
    }),
  )
})
afterEach(() => cleanup())

async function renderInCustomMode() {
  const view = render(<PersonalitySliders agentId={AGENT_ID} />)
  await waitFor(() => expect(screen.getByDisplayValue(CUSTOM)).toBeInTheDocument())
  return view
}

describe('PersonalitySliders in custom mode', () => {
  it('makes the sliders and presets inert', async () => {
    await renderInCustomMode()
    expect(screen.getByTestId('personality-slider-block')).toHaveAttribute('inert')
  })

  it('saves nothing when a slider or preset is reached anyway', async () => {
    const view = await renderInCustomMode()

    const slider = screen.getAllByRole('slider')[0]!
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.click(screen.getByRole('button', { name: 'Feral' }))
    // Switching away saves a dirty slider value; there must be none.
    view.unmount()
    await new Promise((r) => setTimeout(r, 50))

    expect(posts).toEqual([])
    expect(soulWrites).toEqual([])
  })
})
