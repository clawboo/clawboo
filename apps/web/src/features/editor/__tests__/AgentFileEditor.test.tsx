// The agent file editor — the full-height overlay that loads an agent's seven
// markdown files, merges the SQLite personality block into SOUL.md, and writes
// back through the per-agent mutation queue.
//
// Three things make this file unusual:
//   1. A REAL CodeMirror 6 EditorView mounts. The jsdom Range-measurement shims
//      in src/__vitest__/setup.ts are what keep its measure pass quiet.
//   2. `useTheme()` THROWS outside a provider, and both this component and its
//      AgentBooAvatar call it — hence the ThemeProvider wrapper.
//   3. The load effect is gated on a non-null Gateway client, so every test
//      seeds useConnectionStore first or nothing ever loads.
//
// msw runs with onUnhandledRequest:'error', so all three endpoints the mount
// touches are stubbed below. They stay LOCAL to this file rather than moving
// into mswServer.ts: a persistent default would silently satisfy any future
// test that mounts the editor by accident.

import type { ReactElement } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayClient } from '@clawboo/gateway-client'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useConnectionStore } from '@/stores/connection'
import { useEditorStore } from '@/stores/editor'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../__vitest__/mswServer'
import { AgentFileEditor } from '../AgentFileEditor'

// Unique per file: mutationQueue is a module-level singleton keyed by agentId.
const AGENT_ID = 'agent-editor-1'

// Single-line contents on purpose — CodeMirror renders each line as its own
// .cm-line and textContent concatenates WITHOUT newlines ('a\nb' reads 'ab').
const FILES: Record<string, string> = {
  'SOUL.md': 'Soul body copy',
  'IDENTITY.md': 'Identity body copy',
  'TOOLS.md': '',
  'AGENTS.md': '',
  'USER.md': '',
  'HEARTBEAT.md': '',
  'MEMORY.md': 'Memory body copy', // non-empty extra → must surface as a 5th tab
}

const saved: { name: string; content: string }[] = []

const renderEditor = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

/** The text CodeMirror is currently showing. */
const cmText = () => document.querySelector('.cm-content')?.textContent ?? ''

/**
 * Wait for a document to land in CodeMirror. Needs an explicit timeout well
 * above RTL's 1s default: the mount fans out SEVEN parallel file GETs plus the
 * personality read through msw, then mounts a real EditorView — on a loaded CI
 * runner that comfortably exceeds a second. Until the doc arrives, `.cm-content`
 * renders the tab's PLACEHOLDER, so a too-short wait fails with placeholder text
 * rather than a timeout, which reads as a content bug and is a trap worth
 * naming here.
 */
const waitForLoaded = (text: string) =>
  waitFor(() => expect(cmText()).toContain(text), { timeout: 10_000 })

beforeEach(() => {
  saved.length = 0
  useConnectionStore.setState({ status: 'connected', client: {} as unknown as GatewayClient })
  useEditorStore.setState({
    isOpen: true,
    agentId: AGENT_ID,
    agentName: 'Research Boo',
    soulRefreshKey: 0,
  })
  useToastStore.setState({ toasts: [] })
  server.use(
    http.get('/api/agents/:id/files/:name', ({ params }) =>
      HttpResponse.json({ name: String(params.name), content: FILES[String(params.name)] ?? '' }),
    ),
    // `values: null` short-circuits `if (data.values && isPersonalityValues(...))`,
    // so SOUL.md stays exactly what the file GET returned — no merge to reason about.
    http.get('/api/personality', () => HttpResponse.json({ values: null })),
    http.put('/api/agents/:id/files/:name', async ({ params, request }) => {
      const body = (await request.json()) as { content: string }
      saved.push({ name: String(params.name), content: body.content })
      return HttpResponse.json({ name: String(params.name), content: body.content })
    }),
  )
})
afterEach(() => cleanup())

describe('AgentFileEditor', () => {
  it('renders the header and the four core tabs, and loads SOUL.md into the editor', async () => {
    renderEditor(<AgentFileEditor agentId={AGENT_ID} agentName="Research Boo" onClose={vi.fn()} />)

    expect(await screen.findByText('Research Boo')).toBeInTheDocument()
    expect(screen.getByText('Edit Files')).toBeInTheDocument()

    for (const tab of ['SOUL', 'IDENTITY', 'TOOLS', 'AGENTS']) {
      expect(screen.getByRole('button', { name: tab })).toBeInTheDocument()
    }

    await waitForLoaded('Soul body copy')
    // The spinner overlay clears once all seven reads settle.
    expect(screen.queryByText('Loading files…')).not.toBeInTheDocument()
  })

  it('surfaces a non-core tab only when that file is non-empty', async () => {
    renderEditor(<AgentFileEditor agentId={AGENT_ID} agentName="Research Boo" onClose={vi.fn()} />)
    await waitForLoaded('Soul body copy')

    // MEMORY.md has content → it earns a tab. USER.md / HEARTBEAT.md are empty
    // → they stay hidden. This is the `visibleTabs` memo, the one piece of real
    // derived logic in the component.
    expect(screen.getByRole('button', { name: 'MEMORY' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'USER' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'HEARTBEAT' })).not.toBeInTheDocument()
  })

  it('switching tabs swaps the CodeMirror document and the footer hint', async () => {
    renderEditor(<AgentFileEditor agentId={AGENT_ID} agentName="Research Boo" onClose={vi.fn()} />)
    await waitForLoaded('Soul body copy')
    // The footer renders AGENT_FILE_META[activeTab].hint — a stale hint after a
    // tab switch is exactly the kind of drift this test is named for.
    expect(screen.getByText('Persona, tone, and boundaries.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'IDENTITY' }))

    await waitForLoaded('Identity body copy')
    expect(cmText()).not.toContain('Soul body copy')
    expect(screen.getByText('Name, vibe, and emoji.')).toBeInTheDocument()
    expect(screen.queryByText('Persona, tone, and boundaries.')).not.toBeInTheDocument()
  })

  it('closing while clean calls onClose and writes nothing', async () => {
    const onClose = vi.fn()
    renderEditor(<AgentFileEditor agentId={AGENT_ID} agentName="Research Boo" onClose={onClose} />)
    await waitForLoaded('Soul body copy')

    // Nothing edited yet → Save is disabled and saveAllDirty is a no-op.
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Close editor' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    // No spurious PUTs — a clean close must not rewrite all seven files.
    expect(saved).toHaveLength(0)
  })

  it('marks the tab dirty and PUTs only that file when Save is clicked', async () => {
    renderEditor(<AgentFileEditor agentId={AGENT_ID} agentName="Research Boo" onClose={vi.fn()} />)
    await waitForLoaded('Soul body copy')

    // Type through CodeMirror itself so the updateListener → setFiles path runs,
    // which is what actually flips the dirty flag.
    await userEvent.click(document.querySelector('.cm-content') as HTMLElement)
    await userEvent.keyboard('!')

    const save = await screen.findByRole('button', { name: /save/i })
    await waitFor(() => expect(save).toBeEnabled())
    await userEvent.click(save)

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]?.name).toBe('SOUL.md')
    // The EDITED document, not the clean one. Asserting only that the original
    // text survives would pass even if the save wrote the pre-edit content —
    // i.e. if the updateListener → setFiles path silently stopped working.
    expect(saved[0]?.content).toContain('!')
    expect(saved[0]?.content).not.toBe(FILES['SOUL.md'])
    // A successful write is announced, not silent.
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message === 'Saved SOUL.md')).toBe(true),
    )
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = renderEditor(
      <AgentFileEditor agentId={AGENT_ID} agentName="Research Boo" onClose={vi.fn()} />,
    )
    await waitForLoaded('Soul body copy')

    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
