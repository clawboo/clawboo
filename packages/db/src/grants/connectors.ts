// The `connectors` table: configured connector INSTANCES.
//
// THE CONNECTOR SUPERVISOR NOW WRITES ROWS HERE, on connect and on a child's
// exit, so `getConnector` returns real hashes and health.
//
// DRIFT IS STILL NOT LIVE, and the distinction matters. `decideGrant` compares a
// grant's `tools_hash_pin` against the connector's current `tools_hash`, and
// nothing writes that PIN: no code path sets `specHashPin` or `toolsHashPin` on
// a grant. So the comparison is always against null and the `spec-drift` branch
// cannot fire. Arming it needs two things this module does not have: a consent
// step that pins the hash a human actually saw, and a reconnect that rewrites
// the row's hash while leaving that pin alone.

import { eq } from 'drizzle-orm'

import { immediateWrite } from '../board/contention'
import type { ClawbooDb } from '../db'
import { connectors, type DbConnector } from '../schema'

export function getConnector(db: ClawbooDb, id: string): DbConnector | null {
  return (
    (db.select().from(connectors).where(eq(connectors.id, id)).get() as DbConnector | undefined) ??
    null
  )
}

export function listConnectors(db: ClawbooDb): DbConnector[] {
  return db.select().from(connectors).all() as DbConnector[]
}

export type UpsertConnectorInput = Omit<DbConnector, 'createdAt' | 'updatedAt' | 'tenantId'> &
  Partial<Pick<DbConnector, 'tenantId'>>

/** Insert or update one instance by id. The mutable set is explicit so a new
 *  column is a conscious add rather than a silent clobber. */
export function upsertConnector(db: ClawbooDb, input: UpsertConnectorInput): DbConnector {
  const now = Date.now()
  const row: DbConnector = {
    ...input,
    tenantId: input.tenantId ?? null,
    createdAt: now,
    updatedAt: now,
  }
  immediateWrite(db, (tx) => {
    tx.insert(connectors)
      .values(row)
      .onConflictDoUpdate({
        target: connectors.id,
        set: {
          slug: row.slug,
          catalogId: row.catalogId,
          displayName: row.displayName,
          transport: row.transport,
          spec: row.spec,
          specHash: row.specHash,
          toolsHash: row.toolsHash,
          egressAllow: row.egressAllow,
          trifecta: row.trifecta,
          health: row.health,
          // Carried deliberately: without it a disconnect writes the intent and
          // the very next upsert clobbers it back, so a connector the operator
          // switched off would resurrect itself on the following boot.
          desiredState: row.desiredState,
          healthDetail: row.healthDetail,
          failures: row.failures,
          updatedAt: now,
        },
      })
      .run()
  })
  return row
}
