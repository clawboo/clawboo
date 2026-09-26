// The honest line about embeddings, with the fix attached where there is one.
// Each state names its cause, and each state with an in-app fix offers it.
//
// Display-only: it reads the shared status store. The surface that owns the
// view (graph or list) runs the poll, via useEmbeddingPoller.

import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'

import { Button } from '@/features/shared/Button'
import type { EmbeddingStatus } from '@/lib/memoryClient'

import {
  cancelEmbeddingInstall,
  chooseRemoteEmbeddings,
  retryEmbeddingIndexing,
  startEmbeddingInstall,
  useEmbeddingUiStore,
  type InstallState,
} from './useEmbeddingStatus'

type Tone = 'neutral' | 'busy' | 'degraded' | 'error'
type Action = 'install' | 'reinstall' | 'cancel' | 'retry' | 'use-remote'

interface Note {
  tone: Tone
  title: ReactNode
  /** Plain text of the title, for the progress bar's accessible name. */
  label: string
  detail?: ReactNode
  action?: Action
  /** 0..1 while the model itself is downloading; otherwise no bar at all. */
  progress?: number
  /** What a screen reader hears when this note appears. One fixed phrase per
   *  kind of change, so counts and retries ticking over are not announced. */
  announce?: string
}

const ANNOUNCE = {
  installing: 'Downloading the embedding model',
  installFailed: 'The embedding model did not install',
  stopped: 'Memory indexing has stopped',
  failing: 'Memory embeddings are not working',
  indexing: 'Memory is being indexed',
  unavailable: 'Memory similarity is unavailable',
  notIndexing: 'New memories are not being indexed',
  usingRemote: 'Memory is using OpenAI',
} as const

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** A model name is one token: never break it across lines. */
const Model = ({ name }: { name: string }) => <span style={{ whiteSpace: 'nowrap' }}>{name}</span>

export const REMOTE_DISCLOSURE =
  'Fact text and memory searches, including the recall at the start of each agent run, are sent to OpenAI to compute embeddings.'

/** One sentence for the "Embedding provider" row of a spec table. */
export function describeEmbeddingProvider(status: EmbeddingStatus | null): string {
  if (!status) return 'Checking'
  switch (status.state) {
    case 'ready': {
      const p = status.provider!
      const base = `${p.id} · ${p.dimensions}d`
      const pending = status.pending ?? 0
      if (status.lastError && pending > 0 && !status.indexing) return `${base} · indexing stopped`
      if (status.lastError) return `${base} · failing`
      if (pending > 0) return `${base} · indexing ${plural(pending, 'fact')}`
      return base
    }
    case 'ollama-model-missing':
      // Terse on purpose: a spec-table value in a narrow column, and the note
      // beside the search box already names the model.
      return 'Ollama · model not installed'
    case 'ollama-unreachable':
      return 'Ollama · not reachable'
    case 'disabled':
      return 'Turned off on this server'
    case 'none':
      return 'None, keyword search only'
  }
}

/** True when a row, dot or note should read as a failure rather than a wait. */
export function embeddingFailing(status: EmbeddingStatus | null): boolean {
  return status?.state === 'ready' && status.lastError != null
}

/** OpenAI serving a store that has had local vectors: only reachable by a
 *  choice made while Ollama was away, and it holds until Ollama is back. (With
 *  Ollama running but missing the model, the install note says more.) */
function usingRemoteByChoice(status: EmbeddingStatus): boolean {
  return status.remote && status.localFirst && !status.missingModel
}

function usingRemoteNote(): Note {
  return {
    tone: 'neutral',
    title: 'Using OpenAI until Ollama is back',
    label: 'Using OpenAI until Ollama is back',
    detail: `${REMOTE_DISCLOSURE} Start Ollama and memory moves back to this machine on its own.`,
    announce: ANNOUNCE.usingRemote,
  }
}

/** What switching to OpenAI sends, with the scale stated. */
function remoteSwitchCost(status: EmbeddingStatus): string {
  const facts = status.factCount > 0 ? `All ${plural(status.factCount, 'fact')}` : 'Fact text'
  return `${facts} and memory searches are then sent to OpenAI to compute embeddings.`
}

function installNote(status: EmbeddingStatus, install: InstallState): Note | null {
  const model = status.missingModel ?? 'the embedding model'
  if (install.running) {
    const fraction = install.progress?.fraction ?? null
    return {
      tone: 'busy',
      title: (
        <>
          Installing <Model name={model} />
        </>
      ),
      label: `Installing ${model}`,
      detail: install.progress?.message || 'Preparing the download',
      action: 'cancel',
      announce: ANNOUNCE.installing,
      ...(fraction != null ? { progress: fraction } : {}),
    }
  }
  if (status.installing) {
    return {
      tone: 'busy',
      title: (
        <>
          Installing <Model name={model} />
        </>
      ),
      label: `Installing ${model}`,
      detail: 'Started in another window. This updates when it finishes.',
      announce: ANNOUNCE.installing,
    }
  }
  // An error only means something while installing is still the fix.
  if (install.error && status.missingModel) {
    return {
      tone: 'error',
      title: 'Install failed',
      label: 'Install failed',
      detail: install.error,
      action: 'reinstall',
      announce: ANNOUNCE.installFailed,
    }
  }
  return null
}

function readyNote(status: EmbeddingStatus, variant: 'legend' | 'search'): Note | null {
  const pending = status.pending ?? 0
  if (status.lastError && pending > 0) {
    return {
      tone: 'error',
      title: 'Indexing stopped',
      label: 'Indexing stopped',
      // A retry the server started keeps this note and its Retry button, so
      // the button a keyboard user is on does not vanish every minute.
      detail: status.indexing ? `${status.lastError}. Retrying.` : status.lastError,
      action: 'retry',
      announce: ANNOUNCE.stopped,
    }
  }
  if (status.lastError) {
    return {
      tone: 'error',
      title: 'Embedding calls are failing',
      label: 'Embedding calls are failing',
      detail: `${status.lastError}. Search matches on keywords until they work.`,
      action: 'retry',
      announce: ANNOUNCE.failing,
    }
  }
  if (variant === 'search') return usingRemoteByChoice(status) ? usingRemoteNote() : null
  if (status.indexing || pending > 0) {
    const title = pending > 0 ? `Indexing ${plural(pending, 'fact')}` : 'Indexing facts'
    return {
      tone: 'busy',
      title,
      label: title,
      detail: status.remote
        ? 'Similarity links appear when indexing finishes. Their text is sent to OpenAI.'
        : 'Similarity links appear when indexing finishes.',
      announce: ANNOUNCE.indexing,
    }
  }
  if (usingRemoteByChoice(status)) return usingRemoteNote()
  if (status.remote && status.missingModel) {
    return {
      tone: 'neutral',
      title: 'Similarity uses OpenAI',
      label: 'Similarity uses OpenAI',
      detail: (
        <>
          {REMOTE_DISCLOSURE} Install <Model name={status.missingModel} /> to keep it on this
          machine.
        </>
      ),
      action: 'install',
    }
  }
  if (status.skipped > 0) {
    const title = `${plural(status.skipped, 'fact')} could not be indexed`
    return {
      tone: 'neutral',
      title,
      label: title,
      detail: 'The provider turned them down; they still match by keyword.',
    }
  }
  return null
}

function legendNote(
  status: EmbeddingStatus,
  install: InstallState,
  noSimilarity: boolean,
): Note | null {
  const inFlight = installNote(status, install)
  if (inFlight) return inFlight
  const model = status.missingModel ?? 'the embedding model'

  // When older vectors still link some facts, "unavailable" would be false:
  // what is true is that new facts are not being indexed.
  const unavailable = (why: string) =>
    noSimilarity ? `Similarity links unavailable: ${why}` : 'New facts are not being indexed'
  const announceUnavailable = noSimilarity ? ANNOUNCE.unavailable : ANNOUNCE.notIndexing

  switch (status.state) {
    case 'disabled':
      return {
        tone: 'neutral',
        title: unavailable('no embedding provider'),
        label: unavailable('no embedding provider'),
        detail: 'Embeddings are turned off on this server.',
      }
    case 'none':
      return {
        tone: 'neutral',
        title: unavailable('no embedding provider'),
        label: unavailable('no embedding provider'),
        detail:
          'Run Ollama locally (it stays on this machine), or add an OpenAI key under Providers (fact text and memory searches are then sent to OpenAI).',
      }
    case 'ollama-model-missing':
      return {
        tone: 'degraded',
        title: unavailable('embedding model not installed'),
        label: unavailable('embedding model not installed'),
        announce: announceUnavailable,
        detail: (
          <>
            Ollama is running, but <Model name={model} /> is not installed.
          </>
        ),
        action: 'install',
      }
    case 'ollama-unreachable':
      return {
        tone: 'degraded',
        title: unavailable('Ollama is not reachable'),
        label: unavailable('Ollama is not reachable'),
        announce: announceUnavailable,
        detail: status.remoteAvailable
          ? `Start Ollama and indexing resumes on its own, or switch to OpenAI until it is back. ${remoteSwitchCost(status)}`
          : 'Start Ollama and indexing resumes on its own.',
        ...(status.remoteAvailable ? { action: 'use-remote' as const } : {}),
      }
    case 'ready': {
      const note = readyNote(status, 'legend')
      if (note) return note
      // Indexed and still nothing to compare: the store is simply too small.
      if (noSimilarity) {
        const title = 'Similarity links appear once two facts are indexed.'
        return { tone: 'neutral', title, label: title }
      }
      return null
    }
  }
}

function searchNote(status: EmbeddingStatus, install: InstallState): Note | null {
  // First, as in the legend: an install started from either surface shows on both.
  const inFlight = installNote(status, install)
  if (inFlight) return inFlight
  if (status.state === 'ready') return readyNote(status, 'search')
  const model = status.missingModel ?? 'the embedding model'
  const keywordsOnly = 'so search matches on keywords only.'
  switch (status.state) {
    case 'ollama-model-missing':
      return {
        tone: 'degraded',
        title: (
          <>
            <Model name={model} /> is not installed in Ollama, {keywordsOnly}
          </>
        ),
        label: `${model} is not installed in Ollama, ${keywordsOnly}`,
        action: 'install',
        announce: ANNOUNCE.unavailable,
      }
    case 'ollama-unreachable':
      return {
        tone: 'degraded',
        title: `Ollama is not reachable, ${keywordsOnly}`,
        label: `Ollama is not reachable, ${keywordsOnly}`,
        announce: ANNOUNCE.unavailable,
        ...(status.remoteAvailable
          ? {
              detail: `You can switch to OpenAI until it is back. ${remoteSwitchCost(status)}`,
              action: 'use-remote' as const,
            }
          : {}),
      }
    case 'disabled':
      return {
        tone: 'neutral',
        title: `Embeddings are turned off on this server, ${keywordsOnly}`,
        label: `Embeddings are turned off on this server, ${keywordsOnly}`,
      }
    case 'none':
      return {
        tone: 'neutral',
        title: `No embedding provider, ${keywordsOnly}`,
        label: `No embedding provider, ${keywordsOnly}`,
      }
  }
}

const DOT: Record<Tone, string> = {
  neutral: 'var(--amber)',
  degraded: 'var(--amber)',
  busy: 'var(--foreground)',
  error: 'var(--destructive)',
}

function Dot({ tone }: { tone: Tone }) {
  return (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        background: DOT[tone],
        flexShrink: 0,
        marginTop: 5,
        // Same keyframe StatusPill uses; the global reduced-motion rule stills it.
        animation: tone === 'busy' ? 'clawboo-status-pulse 1.6s ease-in-out infinite' : undefined,
      }}
    />
  )
}

const ACTIONS: Record<
  Action,
  { label: string; testId: string; variant: 'secondary' | 'ghost'; run: () => void }
> = {
  install: {
    label: 'Install model',
    testId: 'memory-embedding-install',
    variant: 'secondary',
    run: startEmbeddingInstall,
  },
  reinstall: {
    label: 'Try again',
    testId: 'memory-embedding-install',
    variant: 'secondary',
    run: startEmbeddingInstall,
  },
  cancel: {
    label: 'Cancel',
    testId: 'memory-embedding-cancel',
    variant: 'ghost',
    run: cancelEmbeddingInstall,
  },
  retry: {
    label: 'Retry',
    testId: 'memory-embedding-retry',
    variant: 'secondary',
    run: retryEmbeddingIndexing,
  },
  'use-remote': {
    label: 'Use OpenAI instead',
    testId: 'memory-embedding-use-remote',
    variant: 'secondary',
    run: chooseRemoteEmbeddings,
  },
}

/** A press this soon after the button changed what it does was aimed at what
 *  it did before (the second click of a double-click, a repeated Enter). */
const ACTION_SETTLE_MS = 500

function ActionButton({ kind, changedAt }: { kind: Action; changedAt: RefObject<number> }) {
  const a = ACTIONS[kind]
  return (
    <Button
      size="sm"
      variant={a.variant}
      data-testid={a.testId}
      onClick={() => {
        if (Date.now() - changedAt.current < ACTION_SETTLE_MS) return
        a.run()
      }}
    >
      {a.label}
    </Button>
  )
}

export function EmbeddingStatusNote({
  variant,
  noSimilarity = false,
}: {
  variant: 'legend' | 'search'
  /** Legend only: the current graph has no similarity links at all. */
  noSimilarity?: boolean
}) {
  const status = useEmbeddingUiStore((s) => s.status)
  const install = useEmbeddingUiStore((s) => s.install)
  // Unknown is not "none": say nothing until the server has answered.
  const note = !status
    ? null
    : variant === 'legend'
      ? legendNote(status, install, noSimilarity)
      : searchNote(status, install)

  const legend = variant === 'legend'
  const pct = note?.progress != null ? Math.round(note.progress * 100) : null

  // The action button is one element whatever it does, so keyboard focus
  // stays on it as Install becomes Cancel. Two things follow from that. A
  // press right after it changed is ignored (see ACTION_SETTLE_MS), so a
  // double-click on Retry can never land on "Use OpenAI instead". And when the
  // button the keyboard was on goes away (Retry started indexing, which has
  // nothing to press, or the note itself went), focus stays here, on a
  // container that is always mounted, rather than dropping to the page start.
  const focusRef = useRef<HTMLDivElement>(null)
  const actionFocused = useRef(false)
  const lastAction = useRef<Action | undefined | null>(null) // null: not rendered yet
  const actionChangedAt = useRef(0)
  const action = note?.action
  useLayoutEffect(() => {
    const previous = lastAction.current
    lastAction.current = action
    if (previous !== null && previous !== action && action) actionChangedAt.current = Date.now()
    if (action || !actionFocused.current) return
    actionFocused.current = false
    const active = document.activeElement
    if (active == null || active === document.body) focusRef.current?.focus({ preventScroll: true })
  }, [action])

  return (
    // Always mounted: the focus target when the action goes away. Empty, it is
    // taken out of the flow so it adds no gap to the column it sits in.
    <div
      ref={focusRef}
      tabIndex={-1}
      data-testid="memory-embedding-focus"
      style={
        note
          ? undefined
          : // Holding focus while empty draws no ring: there is nothing here to point at.
            { position: 'absolute', width: 0, height: 0, overflow: 'hidden', outline: 'none' }
      }
    >
      {/* Always mounted, so a note appearing from nothing is announced. It
          carries one fixed phrase per kind of note rather than the note
          itself: counts, percentages and retry cycles change the visible text
          without being read out. */}
      <span aria-live="polite" className="sr-only" data-testid="memory-embedding-region">
        {note?.announce ?? ''}
      </span>
      {note && (
        <div
          data-testid="memory-embedding-note"
          data-state={install.running ? 'installing' : status!.state}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: legend ? 6 : 8,
            paddingTop: legend ? 2 : 0,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Dot tone={note.tone} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span
                style={{
                  fontSize: legend ? 10.5 : 11.5,
                  lineHeight: 1.45,
                  fontWeight: legend && note.detail ? 500 : 400,
                  color: 'var(--muted-foreground)',
                }}
              >
                {note.title}
                {pct != null && (
                  <span aria-hidden className="font-data">
                    {` · ${pct}%`}
                  </span>
                )}
              </span>
              {note.detail && (
                <span
                  style={{
                    fontSize: legend ? 10.5 : 11.5,
                    lineHeight: 1.45,
                    color: 'var(--muted-foreground)',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {note.detail}
                </span>
              )}
            </div>
          </div>

          {pct != null && (
            <div
              role="progressbar"
              aria-label={note.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              data-testid="memory-embedding-progress"
              style={{
                height: 3,
                borderRadius: 999,
                background: 'rgb(var(--foreground-rgb) / 0.1)',
                overflow: 'hidden',
                marginLeft: 14,
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${pct}%`,
                  background: 'var(--foreground)',
                  borderRadius: 999,
                  transition: 'width var(--motion-base)',
                }}
              />
            </div>
          )}

          {note.action && (
            <div
              style={{ marginLeft: 14 }}
              onFocus={() => {
                actionFocused.current = true
              }}
              onBlur={(e) => {
                // A button that was removed blurs too, and so does one whose
                // window lost focus. Only focus now outside a wrapper still on
                // the page means the user moved away themselves.
                const wrapper = e.currentTarget
                queueMicrotask(() => {
                  if (wrapper.isConnected && !wrapper.contains(document.activeElement)) {
                    actionFocused.current = false
                  }
                })
              }}
            >
              <ActionButton kind={note.action} changedAt={actionChangedAt} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
