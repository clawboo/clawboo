// The one decision point for mirroring the LIVE Gateway socket's status into the
// app's connection store. Pure + total so the policy is unit-testable and lives
// in exactly one place (the same shape as `reconnectError.ts` /
// `lib/onboardingProgress.ts`).
//
// Only TWO of the client's four transitions cross over:
//
//   'reconnecting' — the whole point of the mirror. It is the ONLY status the SPA
//                    cannot learn any other way: the client emits it from
//                    `ws.onclose` when the close was NOT a manual disconnect
//                    (gateway-client `client.ts:251`), then retries on its own
//                    backoff (800ms x 1.7, capped 15s).
//   'connected'    — its counterpart. Without it a recovered socket would leave
//                    the store stuck on 'reconnecting' forever.
//
// 'disconnected' and 'connecting' are deliberately NOT mirrored:
//
//   * They carry no new information. The client emits 'connecting' only inside
//     `connect()` (before the client is ever in the store) and 'disconnected'
//     only downstream of an app-initiated `disconnect()`. An UNEXPECTED close
//     always routes to 'reconnecting', never to 'disconnected'. So every one of
//     those emissions is already owned by the code that caused it, which sets the
//     store status itself at the right moment.
//   * Mirroring 'disconnected' would be actively wrong. Every browser call site
//     disconnects the OLD client while it is STILL `store.client` and only then
//     calls `setClient(next)` — so the stale-client guard in `useGatewayEvents`
//     cannot filter it. In `handleConnected` the write would land AFTER
//     `GatewayConnectScreen` already set 'connected', and nothing sets it back:
//     the store would stick on 'disconnected' over a healthy connection and the
//     connect modal would sit on top of a working dashboard.
//     (The SERVER-side mirror in `server/lib/agentSource/openClawAgentSource.ts`
//     does handle 'disconnected' — it can, because its `teardownClient` unsubs
//     BEFORE disconnecting. The browser ordering is the opposite.)
//
// Please don't "complete" the union here without fixing that ordering first.

import type { ConnectionStatus as SocketStatus } from '@clawboo/gateway-client'

import type { ConnectionStatus } from '@/stores/connection'

/**
 * The store status a live socket transition should produce, or `null` for
 * "leave the store alone".
 *
 * @param socketStatus what the live GatewayClient just reported
 * @param current      the app's current connection-store status
 */
export function nextMirroredStatus(
  socketStatus: SocketStatus,
  current: ConnectionStatus,
): ConnectionStatus | null {
  // Owned by the explicit connect/disconnect flows — see the header.
  if (socketStatus !== 'reconnecting' && socketStatus !== 'connected') return null

  // 'error' is a terminal APP-level state (a failed native hydrate, a rejected
  // connect) whose recovery UI the manual flows own. A dropped socket must never
  // downgrade it to a transient 'reconnecting' — that would swap the retry
  // affordance for a banner that just spins. A socket that comes back UP is a
  // genuine recovery, though, so 'connected' is allowed to clear it.
  if (socketStatus === 'reconnecting' && current === 'error') return null

  // `updateStatus` in the client does not dedupe, and it re-emits 'reconnecting'
  // on every failed retry, so drop the no-op writes here.
  if (socketStatus === current) return null

  return socketStatus
}
