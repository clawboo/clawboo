// Shared presentation for the app-shell connection indicator, so the chat header,
// the agent-detail header and the group-chat dot cannot drift apart on what a
// given status looks like.
//
// Before this existed each site rendered the raw status token for anything that
// was not 'connected' ("disconnected", "error"), which read fine only because the
// callers uppercase it in CSS. Adding 'reconnecting' made the tone matter — a
// retrying socket is a WARNING, not the same dead grey as "never connected".

import type { ConnectionStatus } from '@/stores/connection'

/** Human label for the indicator. Callers uppercase it via CSS. */
export function connectionStatusLabel(status: ConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'reconnecting':
      return 'Reconnecting'
    case 'connecting':
      return 'Connecting'
    case 'error':
      return 'Error'
    case 'disconnected':
      return 'Disconnected'
  }
}

/**
 * Semantic tone for the status dot:
 *   'live'  — a healthy socket (mint)
 *   'warn'  — transiently down but recovering on its own (amber)
 *   'idle'  — not connected, and nothing is happening about it (muted)
 */
export function connectionStatusTone(status: ConnectionStatus): 'live' | 'warn' | 'idle' {
  if (status === 'connected') return 'live'
  if (status === 'reconnecting' || status === 'connecting') return 'warn'
  return 'idle'
}
