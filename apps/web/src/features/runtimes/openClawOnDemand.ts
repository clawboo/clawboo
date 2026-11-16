// Opening OpenClaw while nothing uses its Gateway.
//
// The server connects to the Gateway on demand, and a page that loaded while
// nothing used it entered the dashboard with no Gateway client of its own (see
// GatewayBootstrap). Opening OpenClaw's row is a need: the server connects, and
// once it has, this page brings up its own client too, since OpenClaw's 1:1 chat
// and live events ride one.
//
// A Gateway that a service manager starts on its first connection can take
// longer to start than the server's answer waits, so the page keeps reading the
// server's health for a while. That watch lives here rather than in the panel:
// leaving Runtimes or closing Settings unmounts the panel, and the client would
// then never come up until a reload.
//
// Something else can connect the server while a page is open with no client of
// its own: a routine falling due, or another page opening OpenClaw. The connected
// row then offers Connect this page, which brings up the client through the same
// shared dial (connectThisPage). A thin client never gets one (see thinClient).

import {
  connectOpenClawGateway,
  fetchRegistryHealth,
  type RegistryHealth,
} from '@clawboo/control-client'

import { enterGatewayMode } from '@/features/connection/GatewayBootstrap'
import { connectGatewayFromSettings } from '@/lib/gatewayConnect'
import { isThinClient } from '@/lib/thinClient'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'

/** How often the watch reads the server's health. */
export const OPENCLAW_WATCH_POLL_MS = 2_000
/** How long the watch waits for the server's connection before giving up. */
export const OPENCLAW_WATCH_MS = 90_000

let current: { cancelled: boolean } | null = null

/** Stop the watch, if one is running. */
export function cancelOpenClawWatch(): void {
  if (current) current.cancelled = true
  current = null
}

/**
 * Ask the server to connect to the Gateway, and give this page its own client
 * once the server is connected, now or within OPENCLAW_WATCH_MS. Answers with
 * the server's first health; the watch goes on after that. A newer call replaces
 * an older watch.
 */
export async function openOpenClaw(): Promise<RegistryHealth> {
  cancelOpenClawWatch()
  const watch = { cancelled: false }
  current = watch
  const first = await connectOpenClawGateway()
  void watchForServer(watch, first)
  return first
}

async function watchForServer(watch: { cancelled: boolean }, first: RegistryHealth): Promise<void> {
  const deadline = Date.now() + OPENCLAW_WATCH_MS
  let health = first
  while (health.connection !== 'connected') {
    if (watch.cancelled || Date.now() >= deadline) return
    await new Promise((resolve) => setTimeout(resolve, OPENCLAW_WATCH_POLL_MS))
    if (watch.cancelled) return
    health = await fetchRegistryHealth()
  }
  // Replaced, or a person connected this page directly (connectThisPage).
  if (watch.cancelled) return
  if (current === watch) current = null
  // Already has one (the setup flow, or a reconnect banner, got there first).
  if (useConnectionStore.getState().client !== null) return
  // A thin client has no page connection to bring up.
  if (isThinClient()) return
  await attachPageClient()
}

/**
 * Give this page its own Gateway client now, for a server already connected to
 * the Gateway: the connected row's Connect this page. Shares a dial already in
 * flight, so a double click dials once. Ends a watch from an earlier open, which
 * would otherwise dial again after this one. A failure says so in a toast.
 */
export async function connectThisPage(): Promise<void> {
  if (isThinClient()) return
  if (useConnectionStore.getState().client !== null) return
  cancelOpenClawWatch()
  await attachPageClient()
}

// The page's dial in flight, shared: a second open while it runs waits for it
// rather than dialing too, since whichever enterGatewayMode came last would
// disconnect the other's client.
let attaching: Promise<void> | null = null

// Who to tell when a page dial starts or ends: the connected row shows Connect
// this page as busy while one runs, whichever path started it.
const attachListeners = new Set<() => void>()

/** Hear when a page dial starts or ends (for useSyncExternalStore). */
export function subscribePageAttach(listener: () => void): () => void {
  attachListeners.add(listener)
  return () => {
    attachListeners.delete(listener)
  }
}

/** True while this page is dialing its own Gateway connection. */
export function isPageAttaching(): boolean {
  return attaching !== null
}

function setAttaching(next: Promise<void> | null): void {
  attaching = next
  for (const listener of attachListeners) listener()
}

function attachPageClient(): Promise<void> {
  if (attaching) return attaching
  const dial = (async () => {
    try {
      const { client, gatewayUrl } = await connectGatewayFromSettings()
      // Another path gave the page a client while this dial ran (the offline
      // banner's Reconnect, the setup flow). Keep that one: entering this one
      // would disconnect it and load the fleet twice.
      if (useConnectionStore.getState().client !== null) {
        client.disconnect()
        return
      }
      await enterGatewayMode(client, gatewayUrl)
    } catch {
      // A device to approve, say. The server's connection stands either way,
      // and the connected row offers Connect this page while the page has no
      // client, so the toast points there.
      useToastStore.getState().addToast({ message: PAGE_CLIENT_FAILED, type: 'error' })
    }
  })().finally(() => setAttaching(null))
  setAttaching(dial)
  return dial
}

/** What a person is told when this page could not open its own connection. */
export const PAGE_CLIENT_FAILED =
  "OpenClaw is connected, but this page could not connect to it. To chat with OpenClaw agents here, choose Connect this page on OpenClaw's row in Settings > Runtimes."
