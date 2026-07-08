// GET /api/onboarding/state — the aggregated first-run signals in ONE call, so a
// thin client (desktop/mobile/npm) decides wizard-vs-dashboard without re-running
// the browser's multi-call dance (system status + teams + agents + runtimes) that
// feeds `decideOnboardingView`.
//
// Read-only aggregator. Each field REUSES the exact detection the individual
// routes use (no divergent re-implementation):
//   configured          — the OpenClaw check `systemStatusGET` runs (installed +
//                          config + env files present).
//   hasNative           — ≥1 clawboo-native agent row.
//   hasTeam             — ≥1 team row.
//   hasConnectedRuntime — ≥1 connectable runtime has a stored vault credential
//                          (the `hasVaultCredential` signal `runtimesListGET` exposes).

import fs from 'node:fs'
import path from 'node:path'

import { resolveStateDir } from '@clawboo/config'
import { agents, createDb, teams } from '@clawboo/db'
import type { Request, Response } from 'express'
import { eq, or } from 'drizzle-orm'

import { getDbPath } from '../lib/db'
import { detectOpenClaw } from '../lib/openclawDetect'
import { enabledRuntimeIds } from '../lib/runtimes'
import { getDescriptor } from '../lib/runtimes/descriptor'
import { getRuntimeSecret } from '../lib/secretsVault'

export async function onboardingStateGET(_req: Request, res: Response): Promise<void> {
  try {
    const oc = await detectOpenClaw()
    const stateDir = resolveStateDir()
    const configExists = fs.existsSync(path.join(stateDir, 'openclaw.json'))
    const envExists = fs.existsSync(path.join(stateDir, '.env'))
    const configured = oc.installed && configExists && envExists

    const db = createDb(getDbPath())
    const hasTeam = db.select({ id: teams.id }).from(teams).limit(1).all().length > 0
    const hasNative =
      db
        .select({ id: agents.id })
        .from(agents)
        .where(or(eq(agents.sourceId, 'clawboo-native'), eq(agents.runtime, 'clawboo-native')))
        .limit(1)
        .all().length > 0

    // Any connectable (non-OpenClaw) runtime with a stored key — mirrors the
    // `/api/runtimes` `hasVaultCredential` signal over the same descriptor env-vars.
    const hasConnectedRuntime = enabledRuntimeIds().some((id) => {
      const d = getDescriptor(id)
      return [d.envVar, ...(d.altEnvVars ?? [])]
        .filter((v): v is string => Boolean(v))
        .some((v) => Boolean(getRuntimeSecret(v)))
    })

    res.json({ configured, hasNative, hasTeam, hasConnectedRuntime })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}
