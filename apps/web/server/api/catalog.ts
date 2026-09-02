// The marketplace catalog, served to the SPA as ENTRIES.
//
// The distribution and integrity unit is a PACK BUNDLE; the browse unit is an
// ENTRY. `lib/catalogIndex.ts` does the first-to-second conversion - fetch,
// verify, flatten - and these three routes are the thin surface over it. That
// split is why the browser needs no integrity logic, no second origin, and no
// knowledge that packs exist at all.
//
// All three are same-origin, so the existing origin guard covers them unchanged.
//
// THE INDEX IS NEVER EMPTY. `getCatalogSnapshot()` merges the compiled seed
// unconditionally and never throws, so an unreachable remote degrades the
// catalog rather than bricking first-run onboarding.

import type { Request, Response } from 'express'

import { getCatalogSnapshot } from '../lib/catalogIndex'

/** GET /api/catalog/index - the browse rows for every pack that resolved. */
export async function catalogIndexGET(_req: Request, res: Response): Promise<void> {
  const snapshot = await getCatalogSnapshot()
  res.json({
    schemaVersion: snapshot.schemaVersion,
    counts: snapshot.counts,
    agents: snapshot.agents,
    teams: snapshot.teams,
    packs: snapshot.packs,
  })
}

/** GET /api/catalog/agents/:id - one agent's document set. */
export async function catalogAgentGET(req: Request, res: Response): Promise<void> {
  const snapshot = await getCatalogSnapshot()
  const body = snapshot.agentBodies.get(String(req.params['id'] ?? ''))
  if (!body) {
    res.status(404).json({ error: 'Unknown catalog agent' })
    return
  }
  res.json(body)
}

/** GET /api/catalog/teams/:id - one team's workflow narrative and routing. */
export async function catalogTeamGET(req: Request, res: Response): Promise<void> {
  const snapshot = await getCatalogSnapshot()
  const body = snapshot.teamBodies.get(String(req.params['id'] ?? ''))
  if (!body) {
    res.status(404).json({ error: 'Unknown catalog team' })
    return
  }
  res.json(body)
}
