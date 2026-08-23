// The `connectors` table — configured connector INSTANCES.
//
// NOTHING IN THIS RELEASE WRITES A ROW. `getConnector` returns null everywhere,
// so drift detection is INERT: both the gate and the graph pass the stored hash,
// but there is no stored hash to pass. That is stated rather than hidden because
// a drift badge nobody can trigger is worse than an absent one.
//
// The table, this repository and the digest helper ship now so the seam exists
// and is tested against seeded rows, and so an outbound MCP client is the only
// thing left to add.

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
          healthDetail: row.healthDetail,
          failures: row.failures,
          updatedAt: now,
        },
      })
      .run()
  })
  return row
}
