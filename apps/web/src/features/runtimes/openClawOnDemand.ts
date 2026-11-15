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

import {
  connectOpenClawGateway,
  fetchRegistryHealth,
  type RegistryHealth,
} from '@clawboo/control-client'

import { enterGatewayMode } from '@/features/connection/GatewayBootstrap'
import { connectGatewayFromSettings } from '@/lib/gatewayConnect'
import { useConnectionStore } from '@/stores/connection'

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
  if (current === watch) current = null
  // Already has one (the setup flow, or a reconnect banner, got there first).
  if (useConnectionStore.getState().client !== null) return
  try {
    const { client, gatewayUrl } = await connectGatewayFromSettings()
    await enterGatewayMode(client, gatewayUrl)
  } catch {
    // A device to approve, say. The server's connection stands either way, and
    // the row's own Reconnect flow is there for the page's.
  }
}
