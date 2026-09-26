// The embedding note: every state names its cause, each state with an in-app
// fix offers it, errors never outlive the state they belong to, and the install
// streams through to a ready store. Plus the shared poll (deduplicated, one
// listener per surface, "settled" only when indexing got somewhere) and the
// graph's refresh wiring, which offers a refresh instead of forcing one while
// the user is mid-interaction.

import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EmbeddingStatus, MemoryGraphNode, MemoryGraphPayload } from '@/lib/memoryClient'

import { server } from '../../../__vitest__/mswServer'
import {
  describeEmbeddingProvider,
  EmbeddingStatusNote,
  REMOTE_DISCLOSURE,
} from '../EmbeddingStatusNote'
import { useMemoryGraphStore } from '../graph/store'
import { useNewLinksRefresh } from '../graph/useNewLinksRefresh'
import {
  __resetEmbeddingUiForTests,
  isEmbeddingBusy,
  payloadPredatesIndex,
  refreshEmbeddingStatus,
  retryEmbeddingIndexing,
  useEmbeddingPoller,
  useEmbeddingUiStore,
} from '../useEmbeddingStatus'

const READY: EmbeddingStatus = {
  state: 'ready',
  provider: { id: 'ollama:nomic-embed-text', dimensions: 768 },
  remote: false,
  missingModel: null,
  remoteAvailable: false,
  pending: 0,
  factCount: 0,
  localFirst: false,
  vectorsWritten: 0,
  skipped: 0,
  indexing: false,
  installing: false,
  lastError: null,
}
const MISSING: EmbeddingStatus = {
  ...READY,
  state: 'ollama-model-missing',
  provider: null,
  missingModel: 'nomic-embed-text',
  pending: null,
}
const NONE: EmbeddingStatus = { ...MISSING, state: 'none', missingModel: null }
const DISABLED: EmbeddingStatus = { ...NONE, state: 'disabled' }
const UNREACHABLE: EmbeddingStatus = { ...NONE, state: 'ollama-unreachable' }
const OPENAI: EmbeddingStatus = {
  ...READY,
  provider: { id: 'openai:text-embedding-3-small', dimensions: 1536 },
  remote: true,
}

function seed(status: EmbeddingStatus) {
  act(() => useEmbeddingUiStore.getState().setStatus(status))
}

/** Serve GET /api/memory/provider from a variable the test can change. */
function serveStatus(initial: EmbeddingStatus) {
  const ref = { current: initial, calls: 0 }
  server.use(
    http.get('/api/memory/provider', () => {
      ref.calls += 1
      return HttpResponse.json({ provider: ref.current.provider, status: ref.current })
    }),
  )
  return ref
}

function sse(frames: object[]) {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')
  return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream' } })
}

/** Refresh past the dedupe window, as a later poll would. */
async function poll() {
  vi.setSystemTime(Date.now() + 1_100)
  await act(() => refreshEmbeddingStatus())
}

beforeEach(() => {
  __resetEmbeddingUiForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// ─── Each state says what is true ────────────────────────────────────────────

describe('EmbeddingStatusNote (legend)', () => {
  it('says nothing until the server has answered: unknown is not "none"', () => {
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    expect(screen.queryByTestId('memory-embedding-note')).not.toBeInTheDocument()
  })

  it('no provider: keeps the pinned headline, and says where each option sends data', () => {
    seed(NONE)
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    expect(screen.getByText('Similarity links unavailable: no embedding provider')).toBeVisible()
    expect(screen.getByTestId('memory-embedding-note')).toHaveTextContent(
      'it stays on this machine',
    )
    expect(screen.getByTestId('memory-embedding-note')).toHaveTextContent(
      'fact text and memory searches are then sent to OpenAI',
    )
  })

  it('turned off: same headline, and says so instead of suggesting a fix', () => {
    seed(DISABLED)
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    expect(screen.getByText('Similarity links unavailable: no embedding provider')).toBeVisible()
    expect(screen.getByText('Embeddings are turned off on this server.')).toBeVisible()
  })

  it('model missing: names the model and offers the install', () => {
    seed(MISSING)
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    expect(
      screen.getByText('Similarity links unavailable: embedding model not installed'),
    ).toBeVisible()
    expect(screen.getByTestId('memory-embedding-note')).toHaveTextContent(
      'Ollama is running, but nomic-embed-text is not installed.',
    )
    expect(screen.getByTestId('memory-embedding-install')).toHaveTextContent('Install model')
  })

  it('does not claim links are unavailable when older vectors still link facts', () => {
    seed(MISSING)
    render(<EmbeddingStatusNote variant="legend" noSimilarity={false} />)
    expect(screen.getByText('New facts are not being indexed')).toBeVisible()
    expect(screen.queryByText(/Similarity links unavailable/)).not.toBeInTheDocument()
  })

  it('local store, Ollama away: no silent cloud fallback, and OpenAI is an explicit choice', async () => {
    let body: unknown = null
    server.use(
      http.post('/api/memory/embedding/reindex', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ status: OPENAI }, { status: 202 })
      }),
    )
    seed({ ...UNREACHABLE, remoteAvailable: true, factCount: 12 })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    expect(screen.getByText('Similarity links unavailable: Ollama is not reachable')).toBeVisible()
    // The scale of the switch is stated before the button is pressed.
    expect(screen.getByTestId('memory-embedding-note')).toHaveTextContent(
      'All 12 facts and memory searches are then sent to OpenAI to compute embeddings.',
    )
    await user.click(screen.getByTestId('memory-embedding-use-remote'))
    await waitFor(() => expect(body).toEqual({ allowRemote: true, reembedAll: true }))
  })

  it('local store, Ollama away, no key: only says how to resume', () => {
    seed(UNREACHABLE)
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    expect(screen.getByText('Start Ollama and indexing resumes on its own.')).toBeVisible()
    expect(screen.queryByTestId('memory-embedding-use-remote')).not.toBeInTheDocument()
  })

  it('indexing: counts what is left, and says links arrive when it finishes', () => {
    seed({ ...READY, pending: 3, indexing: true })
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    expect(screen.getByText('Indexing 3 facts')).toBeVisible()
    expect(screen.getByText('Similarity links appear when indexing finishes.')).toBeVisible()
  })

  it('indexing through OpenAI says where the text is going', () => {
    seed({ ...OPENAI, pending: 3, indexing: true })
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    expect(screen.getByTestId('memory-embedding-note')).toHaveTextContent(
      'Their text is sent to OpenAI.',
    )
  })

  it('indexing stopped: shows the reason and a retry', async () => {
    let reindexed = 0
    server.use(
      http.post('/api/memory/embedding/reindex', () => {
        reindexed += 1
        return HttpResponse.json(
          { status: { ...READY, pending: 2, indexing: true } },
          { status: 202 },
        )
      }),
    )
    seed({ ...READY, pending: 2, lastError: 'OpenAI embed failed: 429' })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    expect(screen.getByText('Indexing stopped')).toBeVisible()
    expect(screen.getByText('OpenAI embed failed: 429')).toBeVisible()
    await user.click(screen.getByTestId('memory-embedding-retry'))
    await waitFor(() => expect(reindexed).toBe(1))
  })

  it("the server's own retry keeps the stopped note, and the Retry button with focus on it", () => {
    const stopped = { ...READY, pending: 2, lastError: 'OpenAI embed failed: 429' }
    seed(stopped)
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    const retry = screen.getByTestId('memory-embedding-retry')
    retry.focus()

    seed({ ...stopped, indexing: true }) // the server retries on its own
    expect(screen.getByText('Indexing stopped')).toBeVisible()
    expect(screen.getByText('OpenAI embed failed: 429. Retrying.')).toBeVisible()
    expect(screen.getByTestId('memory-embedding-retry')).toBe(retry)
    seed(stopped)
    expect(screen.getByTestId('memory-embedding-retry')).toBe(retry)
    expect(document.activeElement).toBe(retry)
  })

  it('a provider that fails with nothing pending is still reported', () => {
    seed({ ...OPENAI, lastError: 'OpenAI embed failed: 401' })
    render(<EmbeddingStatusNote variant="legend" noSimilarity={false} />)
    expect(screen.getByText('Embedding calls are failing')).toBeVisible()
    expect(screen.getByTestId('memory-embedding-retry')).toBeVisible()
  })

  it('discloses OpenAI and offers the local install when that is one step away', () => {
    seed({ ...OPENAI, missingModel: 'nomic-embed-text' })
    render(<EmbeddingStatusNote variant="legend" noSimilarity={false} />)
    expect(screen.getByText('Similarity uses OpenAI')).toBeVisible()
    expect(screen.getByTestId('memory-embedding-note')).toHaveTextContent(REMOTE_DISCLOSURE)
    expect(screen.getByTestId('memory-embedding-install')).toBeVisible()
  })

  it('reports facts the provider turned down', () => {
    seed({ ...OPENAI, skipped: 2 })
    render(<EmbeddingStatusNote variant="legend" noSimilarity={false} />)
    expect(screen.getByText('2 facts could not be indexed')).toBeVisible()
  })

  it('indexed but too small to compare: says what it is waiting for', () => {
    seed(READY)
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    expect(screen.getByText('Similarity links appear once two facts are indexed.')).toBeVisible()
  })

  it('working and linked: says nothing at all', () => {
    seed(READY)
    render(<EmbeddingStatusNote variant="legend" noSimilarity={false} />)
    expect(screen.queryByTestId('memory-embedding-note')).not.toBeInTheDocument()
  })

  it('keeps one live region mounted, so a note appearing from nothing is announced', () => {
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    const region = screen.getByTestId('memory-embedding-region')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toBeEmptyDOMElement()
    seed(MISSING)
    expect(screen.getByTestId('memory-embedding-region')).toBe(region)
    expect(region).toHaveTextContent('Memory similarity is unavailable')
    // The visible note is outside the region, and its text is on the page once.
    expect(region).not.toContainElement(screen.getByTestId('memory-embedding-note'))
    expect(
      screen.getAllByText('Similarity links unavailable: embedding model not installed'),
    ).toHaveLength(1)
  })

  it('announces what the title says: not "unavailable" while older links remain', () => {
    seed(MISSING)
    render(<EmbeddingStatusNote variant="legend" noSimilarity={false} />)
    expect(screen.getByTestId('memory-embedding-region')).toHaveTextContent(
      'New memories are not being indexed',
    )
  })

  it('keeps keyboard focus at the note when Retry starts indexing', async () => {
    server.use(
      http.post('/api/memory/embedding/reindex', () =>
        HttpResponse.json(
          { status: { ...READY, pending: 2, indexing: true, lastError: null } },
          { status: 202 },
        ),
      ),
    )
    seed({ ...READY, pending: 2, lastError: 'OpenAI embed failed: 429' })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    screen.getByTestId('memory-embedding-retry').focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByText('Indexing 2 facts')).toBeVisible())
    expect(document.activeElement).toBe(screen.getByTestId('memory-embedding-focus'))
  })

  it('a double-click on Retry never lands on the button it turned into', async () => {
    const bodies: unknown[] = []
    server.use(
      http.post('/api/memory/embedding/reindex', async ({ request }) => {
        bodies.push(await request.json())
        // Ollama is down at that moment, so the note offers OpenAI instead.
        return HttpResponse.json(
          { status: { ...UNREACHABLE, remoteAvailable: true, factCount: 40 } },
          { status: 202 },
        )
      }),
    )
    seed({ ...READY, pending: 2, lastError: 'Ollama embed failed: 500' })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    const retry = screen.getByTestId('memory-embedding-retry')
    await user.click(retry)
    await waitFor(() => expect(screen.getByTestId('memory-embedding-use-remote')).toBe(retry))
    await user.click(retry) // the second click of the double-click
    expect(bodies).toEqual([{}])
    vi.setSystemTime(Date.now() + 1_000) // a deliberate press later is honoured
    await user.click(retry)
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toEqual({ allowRemote: true, reembedAll: true })
  })

  it('keeps keyboard focus in place when the whole note goes away', async () => {
    server.use(
      http.post('/api/memory/embedding/reindex', () =>
        HttpResponse.json({ status: { ...OPENAI, pending: 0 } }, { status: 202 }),
      ),
    )
    seed({ ...UNREACHABLE, remoteAvailable: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<EmbeddingStatusNote variant="search" />)
    screen.getByTestId('memory-embedding-use-remote').focus()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(screen.queryByTestId('memory-embedding-note')).not.toBeInTheDocument(),
    )
    expect(document.activeElement).toBe(screen.getByTestId('memory-embedding-focus'))
  })

  it('draws no stray focus ring while holding focus with nothing to show', () => {
    render(<EmbeddingStatusNote variant="legend" noSimilarity={false} />)
    expect(screen.getByTestId('memory-embedding-focus')).toHaveStyle({ outline: 'none' })
  })

  it('keeps the focus intent when the window, not the user, took focus away', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    server.use(
      http.post('/api/memory/embedding/reindex', async () => {
        await gate
        return HttpResponse.json(
          { status: { ...READY, pending: 2, indexing: true, lastError: null } },
          { status: 202 },
        )
      }),
    )
    seed({ ...READY, pending: 2, lastError: 'OpenAI embed failed: 429' })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    const retry = screen.getByTestId('memory-embedding-retry')
    retry.focus()
    await user.keyboard('{Enter}')
    // Switching windows blurs the button while it stays the active element.
    act(() => {
      retry.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await act(async () => {})
    release()
    await waitFor(() => expect(screen.getByText('Indexing 2 facts')).toBeVisible())
    expect(document.activeElement).toBe(screen.getByTestId('memory-embedding-focus'))
  })

  it('does not take focus back after the user moved away from the button', async () => {
    const stopped = { ...READY, pending: 2, lastError: 'OpenAI embed failed: 429' }
    seed(stopped)
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    const retry = screen.getByTestId('memory-embedding-retry')
    retry.focus()
    act(() => retry.blur()) // e.g. a click on the canvas
    await act(async () => {})
    seed({ ...READY, pending: 2, indexing: true }) // later, the server's own retry runs
    expect(document.activeElement).toBe(document.body)
  })

  it('says so while OpenAI stands in for Ollama, on both surfaces', () => {
    seed({ ...OPENAI, localFirst: true })
    const { unmount } = render(<EmbeddingStatusNote variant="legend" noSimilarity={false} />)
    expect(screen.getByText('Using OpenAI until Ollama is back')).toBeVisible()
    expect(screen.getByTestId('memory-embedding-note')).toHaveTextContent(REMOTE_DISCLOSURE)
    unmount()
    render(<EmbeddingStatusNote variant="search" />)
    expect(screen.getByText('Using OpenAI until Ollama is back')).toBeVisible()
  })

  it('offers the install instead when Ollama runs without the model', () => {
    seed({ ...OPENAI, localFirst: true, missingModel: 'nomic-embed-text' })
    render(<EmbeddingStatusNote variant="legend" noSimilarity={false} />)
    expect(screen.getByText('Similarity uses OpenAI')).toBeVisible()
    expect(screen.getByTestId('memory-embedding-install')).toBeVisible()
  })

  it('announces a kind of change once, not every count or retry that ticks over', () => {
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    const region = screen.getByTestId('memory-embedding-region')
    seed({ ...READY, pending: 100, indexing: true })
    const said = region.textContent
    expect(said).toBe('Memory is being indexed')
    seed({ ...READY, pending: 68, indexing: true })
    expect(region.textContent).toBe(said)

    const stopped = { ...READY, pending: 36, lastError: 'OpenAI embed failed: 401' }
    seed(stopped)
    const stoppedSaid = region.textContent
    seed({ ...stopped, indexing: true })
    expect(region.textContent).toBe(stoppedSaid)
  })
})

describe('EmbeddingStatusNote (search line)', () => {
  it('stays out of the way while search is semantic and healthy', () => {
    seed(READY)
    render(<EmbeddingStatusNote variant="search" />)
    expect(screen.queryByTestId('memory-embedding-note')).not.toBeInTheDocument()
  })

  it('explains keyword-only search with the actual cause', () => {
    seed(NONE)
    const { unmount } = render(<EmbeddingStatusNote variant="search" />)
    expect(
      screen.getByText('No embedding provider, so search matches on keywords only.'),
    ).toBeVisible()
    unmount()
    seed(MISSING)
    render(<EmbeddingStatusNote variant="search" />)
    expect(screen.getByTestId('memory-embedding-note')).toHaveTextContent(
      'nomic-embed-text is not installed in Ollama, so search matches on keywords only.',
    )
    expect(screen.getByTestId('memory-embedding-install')).toBeVisible()
  })

  it('shows an install started from the graph, even while OpenAI serves', () => {
    seed({ ...OPENAI, missingModel: 'nomic-embed-text' })
    act(() => useEmbeddingUiStore.getState().setInstall({ running: true, startedAt: Date.now() }))
    render(<EmbeddingStatusNote variant="search" />)
    expect(screen.getByTestId('memory-embedding-note')).toHaveTextContent(
      'Installing nomic-embed-text',
    )
    expect(screen.getByTestId('memory-embedding-cancel')).toBeVisible()
  })

  it('shows a stopped pass here too: in Settings the list is the only view', () => {
    seed({ ...OPENAI, pending: 5, lastError: 'OpenAI embed failed: 401' })
    render(<EmbeddingStatusNote variant="search" />)
    expect(screen.getByText('Indexing stopped')).toBeVisible()
    expect(screen.getByTestId('memory-embedding-retry')).toBeVisible()
  })
})

describe('describeEmbeddingProvider', () => {
  it('reads each state as a spec-table value', () => {
    expect(describeEmbeddingProvider(null)).toBe('Checking')
    expect(describeEmbeddingProvider(READY)).toBe('ollama:nomic-embed-text · 768d')
    expect(describeEmbeddingProvider({ ...READY, pending: 1 })).toBe(
      'ollama:nomic-embed-text · 768d · indexing 1 fact',
    )
    expect(describeEmbeddingProvider({ ...READY, pending: 4, lastError: 'x' })).toBe(
      'ollama:nomic-embed-text · 768d · indexing stopped',
    )
    expect(describeEmbeddingProvider({ ...READY, lastError: 'x' })).toBe(
      'ollama:nomic-embed-text · 768d · failing',
    )
    expect(describeEmbeddingProvider(MISSING)).toBe('Ollama · model not installed')
    expect(describeEmbeddingProvider(UNREACHABLE)).toBe('Ollama · not reachable')
    expect(describeEmbeddingProvider(NONE)).toBe('None, keyword search only')
    expect(describeEmbeddingProvider(DISABLED)).toBe('Turned off on this server')
  })
})

// ─── The install ─────────────────────────────────────────────────────────────

describe('install flow', () => {
  it('streams the install, shows the model layer as a percentage, lands ready', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    server.use(
      http.post('/api/memory/embedding/install', () => {
        const enc = new TextEncoder()
        const stream = new ReadableStream({
          async start(controller) {
            const send = (f: object) =>
              controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
            send({ type: 'progress', message: 'Preparing the download' })
            send({ type: 'progress', message: 'Downloading', completed: 420, total: 1000 })
            await gate
            send({ type: 'complete', status: READY })
            controller.close()
          },
        })
        return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } })
      }),
    )
    serveStatus(READY)
    seed(MISSING)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<EmbeddingStatusNote variant="legend" noSimilarity={false} />)

    await user.click(screen.getByTestId('memory-embedding-install'))
    const bar = await screen.findByTestId('memory-embedding-progress')
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '42'))
    expect(screen.getByRole('progressbar', { name: 'Installing nomic-embed-text' })).toBeVisible()

    release()
    await waitFor(() =>
      expect(screen.queryByTestId('memory-embedding-note')).not.toBeInTheDocument(),
    )
    expect(useEmbeddingUiStore.getState().install.running).toBe(false)
  })

  it('keyboard focus stays on the button when Install becomes Cancel', async () => {
    server.use(
      http.post(
        '/api/memory/embedding/install',
        () =>
          new HttpResponse(new ReadableStream({ start() {} }), {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    )
    seed(MISSING)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    screen.getByTestId('memory-embedding-install').focus()
    await user.keyboard('{Enter}')
    const cancel = await screen.findByTestId('memory-embedding-cancel')
    expect(document.activeElement).toBe(cancel)
  })

  it('a double-click on Install does not cancel the install it started', async () => {
    let signal: AbortSignal | null = null
    server.use(
      http.post('/api/memory/embedding/install', ({ request }) => {
        signal = request.signal
        return new HttpResponse(new ReadableStream({ start() {} }), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }),
    )
    seed(MISSING)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    await user.dblClick(screen.getByTestId('memory-embedding-install'))
    await waitFor(() => expect(signal).not.toBeNull())
    expect(signal!.aborted).toBe(false)
    expect(useEmbeddingUiStore.getState().install.running).toBe(true)
  })

  it('a double-click on Cancel does not start the download again', async () => {
    let requests = 0
    server.use(
      http.post('/api/memory/embedding/install', () => {
        requests += 1
        return new HttpResponse(new ReadableStream({ start() {} }), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }),
    )
    serveStatus(MISSING)
    seed(MISSING)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    await user.click(screen.getByTestId('memory-embedding-install'))
    const cancel = await screen.findByTestId('memory-embedding-cancel')
    vi.setSystemTime(Date.now() + 5_000)
    await user.dblClick(cancel)
    await waitFor(() => expect(useEmbeddingUiStore.getState().install.running).toBe(false))
    expect(requests).toBe(1)
  })

  it('Cancel aborts the stream', async () => {
    let signal: AbortSignal | null = null
    server.use(
      http.post('/api/memory/embedding/install', ({ request }) => {
        signal = request.signal
        return new HttpResponse(new ReadableStream({ start() {} }), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }),
    )
    serveStatus(MISSING)
    seed(MISSING)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    await user.click(screen.getByTestId('memory-embedding-install'))
    const cancel = await screen.findByTestId('memory-embedding-cancel')
    vi.setSystemTime(Date.now() + 1_000) // a decision, not the tail of the first click
    await user.click(cancel)
    await waitFor(() => expect(signal?.aborted).toBe(true))
    expect(screen.getByTestId('memory-embedding-install')).toHaveTextContent('Install model')
  })

  it('a failed install says why and offers to try again', async () => {
    server.use(
      http.post('/api/memory/embedding/install', () =>
        sse([{ type: 'error', code: 'PULL_FAILED', message: 'no space left on device' }]),
      ),
    )
    serveStatus(MISSING)
    seed(MISSING)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    await user.click(screen.getByTestId('memory-embedding-install'))
    expect(await screen.findByText('Install failed')).toBeVisible()
    expect(screen.getByText('no space left on device')).toBeVisible()
    expect(screen.getByTestId('memory-embedding-install')).toHaveTextContent('Try again')
  })

  it('an install error clears once installing is no longer the fix', async () => {
    const ref = serveStatus(MISSING)
    seed(MISSING)
    act(() => useEmbeddingUiStore.getState().setInstall({ error: 'no space left on device' }))
    render(<EmbeddingStatusNote variant="legend" noSimilarity={false} />)
    expect(screen.getByText('Install failed')).toBeVisible()

    ref.current = READY // pulled in a terminal after freeing space
    await poll()
    expect(screen.queryByText('Install failed')).not.toBeInTheDocument()
    expect(useEmbeddingUiStore.getState().install.error).toBeNull()
  })

  it('there being nothing left to install is not a failure', async () => {
    server.use(
      http.post('/api/memory/embedding/install', () =>
        HttpResponse.json({ error: 'nothing to install' }, { status: 409 }),
      ),
    )
    serveStatus(READY)
    seed(MISSING)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<EmbeddingStatusNote variant="legend" noSimilarity={false} />)
    await user.click(screen.getByTestId('memory-embedding-install'))
    await waitFor(() => expect(useEmbeddingUiStore.getState().status?.state).toBe('ready'))
    expect(screen.queryByText('Install failed')).not.toBeInTheDocument()
  })

  it('an install already running elsewhere is shown as running, not offered again', async () => {
    seed({ ...MISSING, installing: true })
    render(<EmbeddingStatusNote variant="legend" noSimilarity />)
    expect(screen.getByTestId('memory-embedding-note')).toHaveTextContent(
      'Installing nomic-embed-text',
    )
    expect(
      screen.getByText('Started in another window. This updates when it finishes.'),
    ).toBeVisible()
    expect(screen.queryByTestId('memory-embedding-install')).not.toBeInTheDocument()
  })

  it('the server wins when it says no install is running', async () => {
    const ref = serveStatus({ ...MISSING, installing: false })
    seed(MISSING)
    act(() => useEmbeddingUiStore.getState().setInstall({ running: true, startedAt: Date.now() }))
    await poll() // inside the grace window: the request may not have landed yet
    expect(useEmbeddingUiStore.getState().install.running).toBe(true)
    vi.setSystemTime(Date.now() + 6_000)
    ref.current = { ...MISSING, installing: false }
    await poll()
    expect(useEmbeddingUiStore.getState().install.running).toBe(false)
  })
})

// ─── The shared poll ─────────────────────────────────────────────────────────

describe('useEmbeddingPoller', () => {
  function Probe({ onSettled }: { onSettled: () => void }) {
    useEmbeddingPoller(onSettled)
    return null
  }

  /** Drive the poller through a run of statuses. */
  async function play(ref: { current: EmbeddingStatus }, steps: EmbeddingStatus[]) {
    for (const next of steps) {
      ref.current = next
      await poll()
    }
  }

  async function mountProbe(initial: EmbeddingStatus) {
    const ref = serveStatus(initial)
    const onSettled = vi.fn()
    render(<Probe onSettled={onSettled} />)
    await waitFor(() => expect(useEmbeddingUiStore.getState().status).not.toBeNull())
    return { ref, onSettled }
  }

  it('signals when indexing that wrote vectors finishes', async () => {
    const { ref, onSettled } = await mountProbe({ ...READY, pending: 2, indexing: true })
    expect(onSettled).not.toHaveBeenCalled()
    await play(ref, [{ ...READY, vectorsWritten: 2 }])
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('waits for indexing to settle before signalling', async () => {
    const { ref, onSettled } = await mountProbe({ ...READY, pending: 4, indexing: true })
    await play(ref, [{ ...READY, pending: 2, indexing: true, vectorsWritten: 2 }])
    expect(onSettled).not.toHaveBeenCalled()
    await play(ref, [{ ...READY, vectorsWritten: 4 }])
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('does not signal when a failing pass wrote nothing', async () => {
    const { ref, onSettled } = await mountProbe({ ...READY, pending: 5, indexing: true })
    await play(ref, [{ ...READY, pending: 5, lastError: 'OpenAI embed failed: 401' }])
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('signals when a pass stops partway after writing some vectors', async () => {
    const { ref, onSettled } = await mountProbe({ ...READY, pending: 5, indexing: true })
    await play(ref, [
      { ...READY, pending: 3, lastError: 'OpenAI embed failed: 429', vectorsWritten: 2 },
    ])
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('signals even when Ollama stops before the pass could finish', async () => {
    const { ref, onSettled } = await mountProbe({ ...READY, pending: 40, indexing: true })
    await play(ref, [
      { ...READY, pending: 20, indexing: true, vectorsWritten: 20 },
      { ...UNREACHABLE, vectorsWritten: 20 },
    ])
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('signals when writes are masked by new facts arriving', async () => {
    const { ref, onSettled } = await mountProbe({ ...READY, pending: 3, indexing: true })
    // Three written, three new saves failed to embed meanwhile: pending is unchanged.
    await play(ref, [
      { ...READY, pending: 3, lastError: 'Ollama embed failed: 500', vectorsWritten: 3 },
    ])
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('an in-app install that indexes the store signals once', async () => {
    const { ref, onSettled } = await mountProbe(MISSING)
    await play(ref, [
      { ...MISSING, installing: true },
      { ...READY, pending: 40, indexing: true },
      { ...READY, pending: 0, skipped: 1, vectorsWritten: 39 },
    ])
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('does not signal for changes that write no vectors', async () => {
    const { ref, onSettled } = await mountProbe({ ...MISSING, installing: true })
    await play(ref, [MISSING, READY, NONE, { ...OPENAI, pending: 3, indexing: true }, OPENAI])
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('a server restart resets the count without a false signal', async () => {
    const { ref, onSettled } = await mountProbe({ ...READY, vectorsWritten: 50 })
    await play(ref, [
      { ...READY, vectorsWritten: 0 },
      { ...READY, vectorsWritten: 2 },
    ])
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('a pass started by Retry that wrote vectors signals when it stops', async () => {
    const stopped = { ...READY, pending: 100, lastError: 'OpenAI embed failed: 429' }
    const { ref, onSettled } = await mountProbe(stopped)
    server.use(
      http.post('/api/memory/embedding/reindex', () =>
        HttpResponse.json(
          { status: { ...READY, pending: 100, indexing: true, lastError: null } },
          { status: 202 },
        ),
      ),
    )
    await act(async () => {
      retryEmbeddingIndexing()
      await vi.waitFor(() => expect(useEmbeddingUiStore.getState().status?.indexing).toBe(true))
    })
    await play(ref, [{ ...stopped, pending: 36, vectorsWritten: 64 }])
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('a second Retry while one is out sends nothing', async () => {
    let posts = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    server.use(
      http.post('/api/memory/embedding/reindex', async () => {
        posts += 1
        await gate
        return HttpResponse.json({ status: READY }, { status: 202 })
      }),
    )
    retryEmbeddingIndexing()
    retryEmbeddingIndexing()
    release()
    await waitFor(() => expect(posts).toBe(1))
  })

  it('starts afresh after every surface closed: writes made meanwhile are not news', async () => {
    const ref = serveStatus({ ...READY, vectorsWritten: 10 })
    const first = vi.fn()
    const { unmount } = render(<Probe onSettled={first} />)
    await waitFor(() => expect(useEmbeddingUiStore.getState().status).not.toBeNull())
    unmount() // Memory closed; a background pass writes 50 more
    ref.current = { ...READY, vectorsWritten: 60 }
    const second = vi.fn()
    render(<Probe onSettled={second} />)
    vi.setSystemTime(Date.now() + 1_100)
    await waitFor(() => expect(useEmbeddingUiStore.getState().status?.vectorsWritten).toBe(60))
    expect(second).not.toHaveBeenCalled()
  })

  it('two surfaces mounting together share a request, and each keeps its own listener', async () => {
    const ref = serveStatus({ ...READY, pending: 2, indexing: true })
    const graph = vi.fn()
    const modal = vi.fn()
    render(<Probe onSettled={graph} />)
    const { unmount } = render(<Probe onSettled={modal} />)
    await waitFor(() => expect(useEmbeddingUiStore.getState().status).not.toBeNull())
    expect(ref.calls).toBe(1)

    unmount() // the Settings modal closes over the graph
    ref.current = { ...READY, vectorsWritten: 2 }
    await poll()
    expect(graph).toHaveBeenCalledTimes(1)
    expect(modal).not.toHaveBeenCalled()
  })

  it('keeps the last known state when a poll fails', async () => {
    seed(READY)
    server.use(http.get('/api/memory/provider', () => new HttpResponse(null, { status: 500 })))
    await poll()
    expect(useEmbeddingUiStore.getState().status).toEqual(READY)
  })

  it('reads an older server that reports only the provider', async () => {
    server.use(
      http.get('/api/memory/provider', () =>
        HttpResponse.json({ provider: { id: 'ollama:nomic-embed-text', dimensions: 768 } }),
      ),
    )
    await poll()
    expect(useEmbeddingUiStore.getState().status).toMatchObject({ state: 'ready', remote: false })
  })

  it('a stopped pass is not busy, so it polls slowly', () => {
    expect(isEmbeddingBusy({ ...READY, pending: 3, lastError: 'x' })).toBe(false)
    expect(isEmbeddingBusy({ ...READY, pending: 3 })).toBe(true)
    expect(isEmbeddingBusy({ ...READY, indexing: true })).toBe(true)
  })
})

// ─── The graph's refresh wiring ──────────────────────────────────────────────

function factNode(id: string, hasEmbedding: boolean): MemoryGraphNode {
  return { id, kind: 'fact', hasEmbedding } as unknown as MemoryGraphNode
}
function payloadOf(nodes: MemoryGraphNode[]): MemoryGraphPayload {
  return {
    nodes,
    edges: [],
    communities: [{ id: 0, label: 'untagged', size: nodes.length }],
    totalFacts: nodes.length,
    totalProcedures: 0,
    truncated: false,
    similarityAvailable: false,
  }
}

describe('useNewLinksRefresh', () => {
  beforeEach(() => useMemoryGraphStore.getState().reset())

  it('refreshes the graph when indexing finishes', async () => {
    const ref = serveStatus({ ...READY, pending: 2, indexing: true })
    useMemoryGraphStore.getState().setPayload(payloadOf([factNode('a', true)]), null)
    renderHook(() => useNewLinksRefresh())
    await waitFor(() => expect(useEmbeddingUiStore.getState().status?.pending).toBe(2))
    const before = useMemoryGraphStore.getState().refreshKey
    ref.current = { ...READY, vectorsWritten: 1 }
    await poll()
    expect(useMemoryGraphStore.getState().refreshKey).toBe(before + 1)
  })

  it('refreshes a payload fetched a moment before the index caught up', async () => {
    serveStatus(READY)
    useMemoryGraphStore.getState().setPayload(payloadOf([factNode('a', false)]), null)
    const before = useMemoryGraphStore.getState().refreshKey
    renderHook(() => useNewLinksRefresh())
    await waitFor(() => expect(useMemoryGraphStore.getState().refreshKey).toBe(before + 1))
  })

  it('asks for one refresh when indexing finishes on a payload that predates it', async () => {
    const ref = serveStatus({ ...READY, pending: 1, indexing: true })
    useMemoryGraphStore.getState().setPayload(payloadOf([factNode('a', false)]), null)
    renderHook(() => useNewLinksRefresh())
    await waitFor(() => expect(useEmbeddingUiStore.getState().status?.pending).toBe(1))
    const before = useMemoryGraphStore.getState().refreshKey
    ref.current = { ...READY, vectorsWritten: 1 }
    await poll()
    await act(async () => {})
    expect(useMemoryGraphStore.getState().refreshKey).toBe(before + 1)
  })

  it('a failed refresh does not block the next one', async () => {
    const ref = serveStatus({ ...READY, pending: 1, indexing: true })
    useMemoryGraphStore.getState().setPayload(payloadOf([factNode('a', true)]), null)
    renderHook(() => useNewLinksRefresh())
    await waitFor(() => expect(useEmbeddingUiStore.getState().status?.pending).toBe(1))
    const before = useMemoryGraphStore.getState().refreshKey

    ref.current = { ...READY, vectorsWritten: 1 }
    await poll()
    expect(useMemoryGraphStore.getState().refreshKey).toBe(before + 1)
    // That fetch fails: loading ends with no new payload.
    act(() => useMemoryGraphStore.getState().setLoading(true))
    act(() => {
      useMemoryGraphStore.getState().setLoading(false)
      useMemoryGraphStore.getState().setError('Could not load the memory graph.')
    })

    ref.current = { ...READY, pending: 1, indexing: true, vectorsWritten: 1 }
    await poll()
    ref.current = { ...READY, vectorsWritten: 2 }
    await poll()
    expect(useMemoryGraphStore.getState().refreshKey).toBe(before + 2)
  })

  it('tries a failed refresh once more, a few seconds later', async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    serveStatus(READY)
    useMemoryGraphStore.getState().setPayload(payloadOf([factNode('a', false)]), null)
    const before = useMemoryGraphStore.getState().refreshKey
    renderHook(() => useNewLinksRefresh())
    // The payload predates the index, so a refresh is asked for.
    await waitFor(() => expect(useMemoryGraphStore.getState().refreshKey).toBe(before + 1))
    act(() => useMemoryGraphStore.getState().setLoading(true))
    act(() => {
      useMemoryGraphStore.getState().setLoading(false)
      useMemoryGraphStore.getState().setError('Could not load the memory graph.')
    })
    await act(async () => {})
    act(() => vi.advanceTimersByTime(5_000))
    expect(useMemoryGraphStore.getState().refreshKey).toBe(before + 2)
    // It fails again: no endless retrying.
    act(() => useMemoryGraphStore.getState().setLoading(true))
    act(() => useMemoryGraphStore.getState().setLoading(false))
    await act(async () => {})
    act(() => vi.advanceTimersByTime(10_000))
    expect(useMemoryGraphStore.getState().refreshKey).toBe(before + 2)
  })

  it('drops the pending retry once a later refresh succeeds', async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    serveStatus(READY)
    useMemoryGraphStore.getState().setPayload(payloadOf([factNode('a', false)]), null)
    const before = useMemoryGraphStore.getState().refreshKey
    renderHook(() => useNewLinksRefresh())
    await waitFor(() => expect(useMemoryGraphStore.getState().refreshKey).toBe(before + 1))
    act(() => useMemoryGraphStore.getState().setLoading(true))
    act(() => {
      useMemoryGraphStore.getState().setLoading(false)
      useMemoryGraphStore.getState().setError('Could not load the memory graph.')
    })
    await act(async () => {})
    // The user presses Try again, and it works.
    act(() => useMemoryGraphStore.getState().setLoading(true))
    act(() => {
      useMemoryGraphStore.getState().setLoading(false)
      useMemoryGraphStore.getState().setPayload(payloadOf([factNode('a', true)]), null)
    })
    await act(async () => {})
    const after = useMemoryGraphStore.getState().refreshKey
    act(() => vi.advanceTimersByTime(10_000))
    expect(useMemoryGraphStore.getState().refreshKey).toBe(after)
  })

  it('offers the refresh instead of pulling the graph out from under a user', async () => {
    const ref = serveStatus({ ...READY, pending: 2, indexing: true })
    useMemoryGraphStore.getState().setPayload(payloadOf([factNode('a', true)]), null)
    useMemoryGraphStore.getState().select('a') // the inspector is open
    const { result } = renderHook(() => useNewLinksRefresh())
    await waitFor(() => expect(useEmbeddingUiStore.getState().status?.pending).toBe(2))
    const before = useMemoryGraphStore.getState().refreshKey

    ref.current = { ...READY, vectorsWritten: 1 }
    await poll()
    expect(useMemoryGraphStore.getState().refreshKey).toBe(before)
    expect(result.current.linksReady).toBe(true)

    act(() => result.current.refreshNow())
    expect(useMemoryGraphStore.getState().refreshKey).toBe(before + 1)
  })
})

describe('payloadPredatesIndex', () => {
  const payload = (nodes: MemoryGraphNode[]) => ({ nodes }) as unknown as MemoryGraphPayload
  const proc = { id: 'p', kind: 'procedure', hasEmbedding: false } as unknown as MemoryGraphNode

  it('is true only when the server reports nothing pending but the payload has unvectored facts', () => {
    expect(payloadPredatesIndex(READY, payload([factNode('a', true), factNode('b', false)]))).toBe(
      true,
    )
  })

  it('is false while indexing is still running', () => {
    expect(payloadPredatesIndex({ ...READY, pending: 1 }, payload([factNode('a', false)]))).toBe(
      false,
    )
  })

  it('is false once the payload has caught up', () => {
    expect(payloadPredatesIndex(READY, payload([factNode('a', true)]))).toBe(false)
  })

  it('is false when the unvectored fact is one the provider turned down', () => {
    const turnedDown = { ...factNode('a', false), embedSkipped: true }
    expect(payloadPredatesIndex({ ...READY, skipped: 1 }, payload([turnedDown]))).toBe(false)
  })

  it('is true for an unvectored fact the provider did not turn down, whatever else was', () => {
    const turnedDown = { ...factNode('a', false), embedSkipped: true }
    // The skip count is store-wide; the marks are per fact, so they decide.
    expect(
      payloadPredatesIndex({ ...READY, skipped: 5 }, payload([turnedDown, factNode('b', false)])),
    ).toBe(true)
  })

  it('ignores procedures, which are never embedded', () => {
    expect(payloadPredatesIndex(READY, payload([proc]))).toBe(false)
  })

  it('is false with no provider: there is nothing to have indexed', () => {
    expect(payloadPredatesIndex(NONE, payload([factNode('a', false)]))).toBe(false)
    expect(payloadPredatesIndex(null, payload([factNode('a', false)]))).toBe(false)
  })
})
