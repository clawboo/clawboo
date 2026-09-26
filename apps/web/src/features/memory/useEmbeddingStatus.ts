// Why similarity search and links work or do not, shared by the graph legend
// and the list panel. One store, so an install started on one surface keeps
// reporting on the other. Each mounted memory surface polls on its own clock,
// fast while the store is being indexed or the model is installing and slow
// otherwise; polls landing within a second of each other share one request.
//
// Components that only DISPLAY the status (the legend's note) read the store
// and call the actions below; they never start a poll of their own.

import { useEffect, useRef } from 'react'
import { create } from 'zustand'

import {
  getEmbeddingStatus,
  installEmbeddingModel,
  reindexEmbeddings,
  type EmbeddingStatus,
  type InstallProgress,
  type MemoryGraphPayload,
} from '@/lib/memoryClient'
import { useVisiblePolling } from '@/lib/useVisiblePolling'

const BUSY_POLL_MS = 2_000
const IDLE_POLL_MS = 30_000
/** Polls landing within a second of each other share one request. */
const MIN_REFRESH_GAP_MS = 1_000
/** How long a local "installing" may disagree with the server before the
 *  server wins (the first poll can land before the install request does). */
const INSTALL_SETTLE_GRACE_MS = 5_000

export interface InstallState {
  running: boolean
  progress: InstallProgress | null
  error: string | null
  startedAt: number
}

interface EmbeddingUiState {
  status: EmbeddingStatus | null
  install: InstallState
  setStatus: (s: EmbeddingStatus) => void
  setInstall: (patch: Partial<InstallState>) => void
  reset: () => void
}

const IDLE_INSTALL: InstallState = { running: false, progress: null, error: null, startedAt: 0 }

export const useEmbeddingUiStore = create<EmbeddingUiState>((set) => ({
  status: null,
  install: IDLE_INSTALL,
  setStatus: (status) => set({ status }),
  setInstall: (patch) => set((s) => ({ install: { ...s.install, ...patch } })),
  reset: () => set({ status: null, install: IDLE_INSTALL }),
}))

/**
 * A graph payload built before the store was indexed. The poller only reacts
 * to vectors written while it was watching, so a payload fetched a moment
 * before a fast backfill finished would otherwise keep showing facts without
 * vectors while the server already reports nothing pending. That combination
 * can only mean the payload is stale: a fact with no vector is pending, unless
 * the provider turned it down, which the graph marks.
 */
export function payloadPredatesIndex(
  status: EmbeddingStatus | null,
  payload: MemoryGraphPayload | null,
): boolean {
  if (status?.state !== 'ready' || status.pending !== 0 || payload == null) return false
  return payload.nodes.some((n) => n.kind === 'fact' && !n.hasEmbedding && !n.embedSkipped)
}

/** Something is moving: a pass running, an install, or facts queued for a
 *  provider that is not currently failing. A stopped pass is not busy: it
 *  waits for Retry or the server's own retry, and polls slowly meanwhile. */
export function isEmbeddingBusy(s: EmbeddingStatus | null): boolean {
  return s != null && (s.indexing || s.installing || ((s.pending ?? 0) > 0 && s.lastError == null))
}

// Every mounted surface's "similarity may now exist" callback.
const settledListeners = new Set<() => void>()
let installCtrl: AbortController | null = null
let inflightRefresh: Promise<void> | null = null
let lastRefreshAt = 0
/** The server's vectors-written count when the view last caught up. */
let seenWritten: number | null = null
let reindexInFlight = false

function notifySettled(): void {
  for (const fn of [...settledListeners]) fn()
}

/**
 * Every status write goes through here, whichever path produced it (a poll,
 * Retry, an install finishing), so the bookkeeping below sees every
 * transition.
 */
function applyStatus(next: EmbeddingStatus): void {
  const store = useEmbeddingUiStore.getState()
  store.setStatus(next)

  // An install error only means something while installing is still the fix.
  if (store.install.error && next.missingModel == null) store.setInstall({ error: null })
  // The server is the truth about whether an install runs.
  const { install } = useEmbeddingUiStore.getState()
  if (
    install.running &&
    !next.installing &&
    Date.now() - install.startedAt > INSTALL_SETTLE_GRACE_MS
  ) {
    installCtrl?.abort()
    installCtrl = null
    store.setInstall(IDLE_INSTALL)
  }

  // Links exist only where vectors were written, and the server counts every
  // one. Refresh the view once indexing has settled after writing some, in any
  // state it settled into; never for a pass, install or cancel that wrote none.
  const written = next.vectorsWritten
  if (seenWritten == null || written < seenWritten) {
    // First answer, or the server restarted: nothing to compare against.
    seenWritten = written
  } else if (written > seenWritten && !isEmbeddingBusy(next)) {
    seenWritten = written
    notifySettled()
  }
}

export function refreshEmbeddingStatus(): Promise<void> {
  if (inflightRefresh) return inflightRefresh
  if (Date.now() - lastRefreshAt < MIN_REFRESH_GAP_MS) return Promise.resolve()
  inflightRefresh = (async () => {
    const next = await getEmbeddingStatus()
    lastRefreshAt = Date.now()
    // A failed poll is not a state change: keep the last thing we knew.
    if (next) applyStatus(next)
  })().finally(() => {
    inflightRefresh = null
  })
  return inflightRefresh
}

export function startEmbeddingInstall(): void {
  if (installCtrl) return
  const store = useEmbeddingUiStore.getState()
  store.setInstall({ running: true, progress: null, error: null, startedAt: Date.now() })
  installCtrl = installEmbeddingModel({
    onProgress: (progress) => useEmbeddingUiStore.getState().setInstall({ progress }),
    onDone: (next) => {
      installCtrl = null
      useEmbeddingUiStore.getState().setInstall(IDLE_INSTALL)
      if (next) applyStatus(next)
      lastRefreshAt = 0
      void refreshEmbeddingStatus()
    },
    // Another window is installing: say so and let the poll report the end.
    onBusy: () => {
      installCtrl = null
      useEmbeddingUiStore.getState().setInstall(IDLE_INSTALL)
      lastRefreshAt = 0
      void refreshEmbeddingStatus()
    },
    onError: (message) => {
      installCtrl = null
      useEmbeddingUiStore.getState().setInstall({ running: false, progress: null, error: message })
      lastRefreshAt = 0
      void refreshEmbeddingStatus()
    },
  })
}

export function cancelEmbeddingInstall(): void {
  installCtrl?.abort()
  installCtrl = null
  useEmbeddingUiStore.getState().setInstall(IDLE_INSTALL)
  lastRefreshAt = 0
  void refreshEmbeddingStatus()
}

/** One request at a time: a second press while one is out changes nothing. */
function applyReindex(opts: { allowRemote?: boolean; reembedAll?: boolean }): void {
  if (reindexInFlight) return
  reindexInFlight = true
  void reindexEmbeddings(opts)
    .then((next) => {
      if (next) applyStatus(next)
    })
    .finally(() => {
      reindexInFlight = false
    })
}

/** Try indexing again with the current provider. */
export function retryEmbeddingIndexing(): void {
  applyReindex({})
}

/** The user chose OpenAI over a local Ollama that is not answering. */
export function chooseRemoteEmbeddings(): void {
  applyReindex({ allowRemote: true, reembedAll: true })
}

/**
 * Poll the status while this surface is mounted and visible.
 *
 * @param onSettled called when indexing has settled after writing vectors: the
 *   moment similarity edges come into existence, so a view built from an
 *   earlier payload is out of date.
 */
export function useEmbeddingPoller(onSettled?: () => void): EmbeddingStatus | null {
  const status = useEmbeddingUiStore((s) => s.status)
  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onSettledRef.current = onSettled
  })

  useEffect(() => {
    const listener = () => onSettledRef.current?.()
    settledListeners.add(listener)
    lastRefreshAt = 0
    void refreshEmbeddingStatus()
    return () => {
      settledListeners.delete(listener)
      // With no surface watching, the next one starts from what it first sees.
      if (settledListeners.size === 0) seenWritten = null
    }
  }, [])

  useVisiblePolling(
    () => void refreshEmbeddingStatus(),
    isEmbeddingBusy(status) ? BUSY_POLL_MS : IDLE_POLL_MS,
  )
  return status
}

/** Test seam: forget module state between cases. */
export function __resetEmbeddingUiForTests(): void {
  installCtrl?.abort()
  installCtrl = null
  settledListeners.clear()
  inflightRefresh = null
  lastRefreshAt = 0
  seenWritten = null
  reindexInFlight = false
  useEmbeddingUiStore.getState().reset()
}
