import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CapabilityRecord } from '@clawboo/capability-registry'

import { server } from '../../../__vitest__/mswServer'
import { useToastStore } from '@/stores/toast'
import { CapabilitiesPanel } from '../CapabilitiesPanel'

afterEach(() => cleanup())

function rec(over: Partial<CapabilityRecord> & { id: string }): CapabilityRecord {
  return {
    sourceKey: 'k',
    kind: 'tool',
    runtime: 'clawboo-native',
    scope: 'global',
    agentId: null,
    source: 'brokered-mcp',
    manageability: 'managed',
    name: 'cap',
    description: '',
    availability: null,
    available: true,
    diagnostics: [],
    provenance: null,
    status: 'ready',
    tenantId: null,
    syncedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

const FIXTURE: CapabilityRecord[] = [
  rec({
    id: 'native:t1',
    runtime: 'clawboo-native',
    kind: 'tool',
    source: 'brokered-mcp',
    manageability: 'managed',
    name: 'echo',
    status: 'ready',
  }),
  rec({
    id: 'claude-code:builtins',
    runtime: 'claude-code',
    kind: 'tool',
    source: 'runtime-builtin',
    manageability: 'observe-only',
    name: 'Built-in tools',
  }),
  // The pending-auth hint now rides the record (no per-runtime literal in the panel).
  rec({
    id: 'codex:mcp:clawboo-tasks',
    runtime: 'codex',
    kind: 'connector',
    source: 'mcp-connector',
    manageability: 'external-write',
    name: 'clawboo-tasks',
    status: 'manageable-but-pending-auth',
    hint: 'pending auth — run `codex login`',
  }),
]

beforeEach(() => {
  // Every endpoint the panel touches on mount (onUnhandledRequest:'error').
  server.use(
    http.get('/api/capabilities', () => HttpResponse.json({ records: FIXTURE, sources: [] })),
    http.get('/api/tools/approvals', () => HttpResponse.json({ ok: true, approvals: [] })),
  )
})

describe('CapabilitiesPanel', () => {
  it('renders per-runtime groups + a manageability-derived action set', async () => {
    render(<CapabilitiesPanel />)
    expect(await screen.findByTestId('capabilities-panel')).toBeInTheDocument()

    // Grouped by runtime.
    expect(await screen.findByTestId('capability-group-clawboo-native')).toBeInTheDocument()
    expect(screen.getByTestId('capability-group-claude-code')).toBeInTheDocument()
    expect(screen.getByTestId('capability-group-codex')).toBeInTheDocument()

    // managed row → an enabled action button.
    const echoRow = screen
      .getByText('echo')
      .closest('[data-testid="capability-row"]') as HTMLElement
    const echoBtn = within(echoRow).getByTestId('capability-action')
    expect(echoBtn).toBeEnabled()
  })

  it('observe-only renders "built-in, managed by …" with NO action button', async () => {
    render(<CapabilitiesPanel />)
    const builtinRow = (await screen.findByText('Built-in tools')).closest(
      '[data-testid="capability-row"]',
    ) as HTMLElement
    expect(within(builtinRow).getByText(/built-in, managed by/i)).toBeInTheDocument()
    expect(within(builtinRow).queryByTestId('capability-action')).toBeNull()
  })

  it('Codex manageable-but-pending-auth renders a DISABLED action + the auth hint', async () => {
    render(<CapabilitiesPanel />)
    const codexRow = (await screen.findByText('clawboo-tasks')).closest(
      '[data-testid="capability-row"]',
    ) as HTMLElement
    const btn = within(codexRow).getByTestId('capability-action')
    expect(btn).toBeDisabled()
    // The auth hint is unique to the disabled action button.
    expect(within(codexRow).getByText(/run .?codex login/i)).toBeInTheDocument()
  })

  it('a runtime-of-record connector the source CANNOT write (writable:false) renders NO action button', async () => {
    server.use(
      http.get('/api/capabilities', () =>
        HttpResponse.json({
          records: [
            rec({
              id: 'openclaw:mcp:vendor',
              runtime: 'openclaw',
              kind: 'connector',
              source: 'openclaw-extension',
              manageability: 'runtime-of-record',
              name: 'Vendor MCP',
              status: 'ready',
              writable: false,
            }),
          ],
          sources: [],
        }),
      ),
    )
    render(<CapabilitiesPanel />)
    const row = (await screen.findByText('Vendor MCP')).closest(
      '[data-testid="capability-row"]',
    ) as HTMLElement
    // No dead Enable/Disable button — the action is gated on writability.
    expect(within(row).queryByTestId('capability-action')).toBeNull()
  })

  it('a pending-auth row renders the RECORD-supplied hint, not a hardcoded one', async () => {
    server.use(
      http.get('/api/capabilities', () =>
        HttpResponse.json({
          records: [
            rec({
              id: 'native:pending',
              runtime: 'clawboo-native',
              kind: 'connector',
              source: 'mcp-connector',
              manageability: 'external-write',
              name: 'Pending Thing',
              status: 'manageable-but-pending-auth',
              hint: 'pending auth — run `acme connect`',
            }),
          ],
          sources: [],
        }),
      ),
    )
    render(<CapabilitiesPanel />)
    const row = (await screen.findByText('Pending Thing')).closest(
      '[data-testid="capability-row"]',
    ) as HTMLElement
    expect(within(row).getByText(/acme connect/i)).toBeInTheDocument()
    expect(within(row).queryByText(/codex login/i)).toBeNull()
  })

  it('runtime-filter pills narrow the inventory to one runtime', async () => {
    const user = userEvent.setup()
    render(<CapabilitiesPanel />)
    // All three runtime groups present initially.
    expect(await screen.findByTestId('capability-group-clawboo-native')).toBeInTheDocument()
    expect(screen.getByTestId('capability-group-codex')).toBeInTheDocument()
    // Filter to codex → only the codex group remains.
    await user.click(screen.getByTestId('capability-filter-codex'))
    expect(screen.getByTestId('capability-group-codex')).toBeInTheDocument()
    expect(screen.queryByTestId('capability-group-clawboo-native')).toBeNull()
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(<CapabilitiesPanel />)
    await screen.findByTestId('capabilities-panel')
    await screen.findByTestId('capability-group-clawboo-native')
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })

  it('clicking a managed action POSTs /api/capabilities/:action', async () => {
    const posted = vi.fn()
    server.use(
      http.post('/api/capabilities/:action', ({ params }) => {
        posted(params['action'])
        return HttpResponse.json({ ok: true, record: null })
      }),
    )
    const user = userEvent.setup()
    render(<CapabilitiesPanel />)
    const echoRow = (await screen.findByText('echo')).closest(
      '[data-testid="capability-row"]',
    ) as HTMLElement
    await user.click(within(echoRow).getByTestId('capability-action'))
    expect(posted).toHaveBeenCalledWith('disable') // a 'ready' managed row offers Disable
  })

  it('a total /api/capabilities failure shows an error banner, not the empty state', async () => {
    server.use(
      http.get('/api/capabilities', () => new HttpResponse(null, { status: 500 })),
      http.get('/api/tools/approvals', () => HttpResponse.json({ ok: true, approvals: [] })),
    )
    render(<CapabilitiesPanel />)
    // The fetch FAILED → a distinct error/retry surface, never "No capabilities
    // found" (which would masquerade a server error as a genuinely empty inventory).
    expect(await screen.findByTestId('capabilities-fetch-error')).toBeInTheDocument()
    expect(screen.queryByText('No capabilities found')).toBeNull()
  })

  it('an UNAVAILABLE (greyed) managed capability renders NO action button', async () => {
    server.use(
      http.get('/api/capabilities', () =>
        HttpResponse.json({
          records: [
            rec({
              id: 'native:gated',
              runtime: 'clawboo-native',
              kind: 'tool',
              source: 'brokered-mcp',
              manageability: 'managed',
              name: 'Gated tool',
              status: 'ready',
              available: false, // unmet availability requirement → greyed, no live action
            }),
          ],
          sources: [],
        }),
      ),
    )
    render(<CapabilitiesPanel />)
    const row = (await screen.findByText('Gated tool')).closest(
      '[data-testid="capability-row"]',
    ) as HTMLElement
    expect(within(row).queryByTestId('capability-action')).toBeNull()
  })

  it('a failed action surfaces the typed error and does NOT refresh', async () => {
    let getCalls = 0
    server.use(
      http.get('/api/capabilities', () => {
        getCalls += 1
        return HttpResponse.json({ records: FIXTURE, sources: [] })
      }),
      // 403 observe-only / tier-forbidden — a typed rejection, not a no-op.
      http.post('/api/capabilities/:action', () =>
        HttpResponse.json(
          { error: 'observe-only capability', manageability: 'observe-only' },
          { status: 403 },
        ),
      ),
    )
    const user = userEvent.setup()
    render(<CapabilitiesPanel />)
    const echoRow = (await screen.findByText('echo')).closest(
      '[data-testid="capability-row"]',
    ) as HTMLElement
    await waitFor(() => expect(getCalls).toBe(1)) // initial mount fetch only

    await user.click(within(echoRow).getByTestId('capability-action'))

    await waitFor(() =>
      expect(
        useToastStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /observe-only capability/.test(t.message)),
      ).toBe(true),
    )
    // Nothing changed → no re-fetch.
    expect(getCalls).toBe(1)
  })
})
