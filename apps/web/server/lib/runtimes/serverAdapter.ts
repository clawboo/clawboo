// Shared OpenClaw operator-adapter construction for the two server-side team paths
// — the board engine's `serverDeliver` AND the peer-chat `runTeamExchange` — so the
// connected-substrate arm can't drift between them. An OpenClaw participant runs over
// the server-held paired operator client (a connected-substrate runtime executes on
// its LIVE Gateway session; the one-shot runner refuses it by construction). A null
// client (Gateway down) yields null so the caller degrades gracefully: `serverDeliver`
// `failStart`s → the engine reflects "could not deliver" to the delegator;
// `runTeamExchange` drops the participant from the exchange.

import { OpenClawAdapter, type OpenClawGatewayClient } from '@clawboo/adapter-openclaw'
import type { RuntimeAdapter } from '@clawboo/executor'

import { getRegistry } from '../agentSource'

/** Build the OpenClaw operator adapter for a server-side connected-substrate run.
 *  Returns null when the paired operator client is unavailable (Gateway down). */
export function buildOpenClawServerAdapter(
  getOperatorClient: () => OpenClawGatewayClient | null = () => getRegistry().source.operatorClient(),
): RuntimeAdapter | null {
  const client = getOperatorClient()
  return client ? new OpenClawAdapter(client) : null
}
