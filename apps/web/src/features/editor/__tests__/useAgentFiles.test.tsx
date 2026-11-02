// useAgentFiles, the hook behind the agent page's inline file tabs: it loads the
// agent's files and rebuilds SOUL.md's personality block from what the
// Personality panel stored.
//
// The case pinned here: an agent on custom personality instructions. The stored
// row keeps the slider values AND the custom text, and the hook used to rebuild
// SOUL.md from the sliders alone, so saving any edit to SOUL.md wrote the slider
// block over the user's own instructions.

import { act, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_PERSONALITY, mergeSoulWithCustomPersonality } from '@/lib/soulPersonality'
import { useEditorStore } from '@/stores/editor'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../__vitest__/mswServer'
import { useAgentFiles } from '../useAgentFiles'

// Unique per file: mutationQueue is a module-level singleton keyed by agentId.
const AGENT_ID = 'agent-use-files-1'
const CUSTOM = 'Answer like a ship captain reading the logbook aloud.'
const SOUL = mergeSoulWithCustomPersonality('# SOUL\n\nYou review pull requests.', CUSTOM)

const saved: { name: string; content: string }[] = []
let personalityReads = 0

beforeEach(() => {
  saved.length = 0
  personalityReads = 0
  useEditorStore.setState({ soulRefreshKey: 0 })
  useToastStore.setState({ toasts: [] })
  server.use(
    http.get('/api/agents/:id/files/:name', ({ params }) =>
      HttpResponse.json({
        name: String(params.name),
        content: params.name === 'SOUL.md' ? SOUL : '',
      }),
    ),
    http.get('/api/personality', () => {
      personalityReads += 1
      return HttpResponse.json({ values: DEFAULT_PERSONALITY, customText: CUSTOM })
    }),
    http.put('/api/agents/:id/files/:name', async ({ params, request }) => {
      const body = (await request.json()) as { content: string }
      saved.push({ name: String(params.name), content: body.content })
      return HttpResponse.json({ name: String(params.name), content: body.content })
    }),
  )
})

describe('useAgentFiles with custom personality instructions', () => {
  it('loads SOUL.md with the custom instructions, not the slider block', async () => {
    const { result } = renderHook(() => useAgentFiles(AGENT_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const soul = result.current.files['SOUL.md']?.content ?? ''
    expect(soul).toContain(CUSTOM)
    expect(soul).not.toContain('## Limits')
    expect(result.current.isDirty('SOUL.md')).toBe(false)
  })

  it('saving an edit to SOUL.md keeps the custom instructions', async () => {
    const { result } = renderHook(() => useAgentFiles(AGENT_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const loaded = result.current.files['SOUL.md']?.content ?? ''
    act(() => {
      result.current.updateFileContent(
        'SOUL.md',
        loaded.replace('You review pull requests.', 'You review pull requests and docs.'),
      )
    })
    await act(() => result.current.handleSave('SOUL.md'))

    expect(saved).toHaveLength(1)
    expect(saved[0]?.content).toContain('You review pull requests and docs.')
    expect(saved[0]?.content).toContain(CUSTOM)
    expect(saved[0]?.content).not.toContain('## Limits')
  })

  it('a Personality panel save refreshes SOUL.md without dropping the custom instructions', async () => {
    const { result } = renderHook(() => useAgentFiles(AGENT_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => useEditorStore.getState().triggerSoulRefresh())
    // Wait for the refresh's own read, then let its merge settle.
    await waitFor(() => expect(personalityReads).toBe(2))
    await act(() => new Promise((r) => setTimeout(r, 50)))

    const soul = result.current.files['SOUL.md']?.content ?? ''
    expect(soul).toContain(CUSTOM)
    expect(soul).not.toContain('## Limits')
  })
})
