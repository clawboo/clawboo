// Every agent gets a browser.
//
// An agent that cannot open a page cannot show you what it is doing, and the
// browser view is the surface that makes a run legible. Waiting for someone to
// drag a tile onto each Boo means the panel reads as broken on a fresh install,
// which is a worse first impression than the feature is worth.
//
// ─── What this is NOT ────────────────────────────────────────────────────────
//
// This is deliberately not the thing that was removed. Attaching a connector
// used to mint a grant with `subjectKind: 'global'`, and a global grant answers
// for EVERY caller regardless of who asked, at `mode: 'admin'` with
// `toolAllow: ['*']`. That is a privilege escalation, `retireFleetWideGrants`
// now reaps rows of that shape at boot, and nothing here reintroduces it:
//
//   • PER AGENT. `subjectKind: 'agent'` with a real `subjectId`, never 'global'.
//     `retireFleetWideGrants` skips anything that is not global, so these
//     survive a restart rather than being reaped as the old ones are.
//   • BROWSER ONLY. The slugs come from the catalog's own `category: 'browser'`,
//     so the set cannot drift from what the catalog calls a browser, and no
//     other connector is ever touched.
//   • NOT ADMIN. `mode: 'write'`, which is the narrowest mode that actually
//     runs the tools: `browser_navigate` and `browser_click` are not annotated
//     read-only, so a `read` grant would deny the whole connector.
//
// ─── Why `operator` origin ───────────────────────────────────────────────────
//
// An `owner`-origin grant gates real calls but is invisible: it draws no edge on
// the graph and offers no Detach control, and the agent-scoped capabilities read
// never surfaces it, so the browser panel would still report "no browser
// granted" after being granted. `operator` is what makes the grant a thing a
// person can SEE and REVOKE, which matters more here than anywhere, because this
// grant is minted without anyone asking for it.
//
// ─── Insert-only, on purpose ─────────────────────────────────────────────────
//
// A row for this pair in ANY state means a human has already decided about it.
// `upsertGrant` would resurrect a revoked grant (its update set writes
// `state: 'active', revokedAt: null` unconditionally), so a boot sweep built on
// it would silently re-grant a browser the operator had deliberately taken away,
// on every restart. The existence check below is what makes a revoke stick.

import { connectorsByCategory } from '@clawboo/connector-catalog'
import { getConnector, listGrants, upsertGrant, type ClawbooDb } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'

import { connectorInstanceIdForSlug } from '../capabilitySource/connectorIdentity'

const log = createLogger('browser-grants')

/**
 * The connector ids a browser grant targets.
 *
 * Derived from the catalog rather than a literal list, so adding a browser
 * connector to the catalog is enough. `connectorInstanceIdForSlug` is the ONE
 * spelling of this string: a second spelling means the sweep mints a grant under
 * one id while the broker looks one up under another, and every call comes back
 * `grant:no-grant` on a connector the graph draws as healthy.
 */
export function browserConnectorIds(): readonly string[] {
  return connectorsByCategory('browser').map((def) => connectorInstanceIdForSlug(def.slug))
}

/**
 * Grant this agent every browser connector it does not already have a decision
 * about. Returns how many grants were minted.
 *
 * Never throws. A missing browser grant degrades one panel; a throw here would
 * fail the agent creation that called it.
 */
export function ensureBrowserGrantsForAgent(db: ClawbooDb, agentId: string): number {
  if (!agentId) return 0
  let minted = 0
  try {
    // Every state, revoked included. See the insert-only note above.
    const decided = new Set(
      listGrants(db, { subjectId: agentId })
        .filter((g) => g.capabilityKind === 'connector' && g.connectorId)
        .map((g) => g.connectorId as string),
    )
    for (const connectorId of browserConnectorIds()) {
      if (decided.has(connectorId)) continue
      // The connector need not be connected yet. There is no foreign key, and a
      // grant for an absent connector sits inert until it appears, which is the
      // case that matters: an agent created before the browser is connected
      // should not need a second pass afterwards.
      const row = getConnector(db, connectorId)
      upsertGrant(db, {
        subjectKind: 'agent',
        subjectId: agentId,
        capabilityKind: 'connector',
        connectorId,
        capabilityId: null,
        mode: 'write',
        toolAllow: ['*'],
        toolDeny: [],
        approvalPolicy: 'risk',
        origin: 'operator',
        // Pins arm drift detection, and can only be set once the connector has
        // actually been seen. Omitted rather than nulled when it has not.
        ...(row?.specHash ? { specHashPin: row.specHash } : {}),
        ...(row?.toolsHash ? { toolsHashPin: row.toolsHash } : {}),
      })
      minted += 1
    }
  } catch (err) {
    log.warn({ agentId, err: String(err) }, 'could not ensure browser grants for agent')
    return minted
  }
  return minted
}

/**
 * Backfill every agent that already exists.
 *
 * Idempotent by construction (the per-agent function is insert-only), so this is
 * safe to run on every boot and needs no "has this migration run" flag. That
 * also makes it the catch-all for the agent-creation paths that do not go
 * through the REST route: the onboarding seed, Boo Zero, and the rows the
 * OpenClaw sync mints for agents that already existed in someone's Gateway.
 */
export function ensureBrowserGrantsForAllAgents(
  db: ClawbooDb,
  agentIds: readonly string[],
): number {
  let minted = 0
  for (const id of agentIds) minted += ensureBrowserGrantsForAgent(db, id)
  if (minted > 0)
    log.info({ minted, agents: agentIds.length }, 'granted browser to existing agents')
  return minted
}
