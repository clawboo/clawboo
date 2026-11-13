// The server's one Hermes gateway, and the driver every Hermes run uses.

import type { HermesDriver } from '@clawboo/adapter-hermes'
import type { StartOpts } from '@clawboo/executor'
import { createLogger } from '@clawboo/logger'
import { agents } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { getDb } from '../../db'
import { markInstallInUse, ownedRuntimeProblem } from '../../runtimeFolder'
import type { RuntimeRunContext } from '../types'
import { expireOrphanedHermesApprovals } from './approvals'
import { HermesGatewaySupervisor } from './gateway'
import { createHermesGatewayDriver } from './gatewayDriver'
import { managedHermesCommand } from './install'
import type { HermesJobsBackend } from '../../scheduleSource/hermesGatewayJobsScheduleSource'
import { runtimeIdentityHomePath } from '../identityHome'
import { runtimeKeyEnv } from '../runKeyEnv'
import {
  hermesGatewayHome,
  hermesProfileName,
  listClawbooProfiles,
  refreshProfileProviderKeys,
  tidyProfiles,
} from './profiles'

const log = createLogger('hermes')

let supervisor: HermesGatewaySupervisor | null = null
/** Throwaway profiles are removed at this server's first gateway start, before
 *  any run of this server can have made one. */
let throwawaysTidied = false

/** The profile of every Clawboo Hermes agent, or null when the registry
 *  cannot be read. */
function currentAgentProfiles(): Set<string> | null {
  try {
    return new Set(hermesAgentProfiles().map((a) => a.profile))
  } catch {
    return null
  }
}

/** Before each gateway start: profiles of agents Clawboo no longer has are set
 *  aside, and every profile gets the keys Clawboo holds now. */
async function beforeGatewayStart(home: string): Promise<void> {
  try {
    const tidied = await tidyProfiles(home, {
      keep: currentAgentProfiles(),
      removeThrowaways: !throwawaysTidied,
    })
    throwawaysTidied = true
    if (tidied.removed.length + tidied.setAside.length > 0)
      log.info(tidied, 'tidied Hermes profiles')
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'could not tidy Hermes profiles',
    )
  }
  await refreshProfileProviderKeys(home, runtimeKeyEnv('hermes'))
}

/** The server's Hermes gateway supervisor. */
export function hermesGateway(): HermesGatewaySupervisor {
  if (!supervisor) {
    supervisor = new HermesGatewaySupervisor({
      resolveCommand: () => managedHermesCommand(),
      installProblem: () => ownedRuntimeProblem('hermes'),
      // An update installs beside this one; the folder is kept while it runs.
      onStarted: (pid) => markInstallInUse('hermes', pid),
      // Hermes's own jobs run between Clawboo's runs, on the keys in each profile.
      beforeStart: beforeGatewayStart,
    })
  }
  return supervisor
}

/** Tests only: use this supervisor instead. */
export function setHermesGatewayForTests(s: HermesGatewaySupervisor | null): void {
  supervisor = s
}

/** The driver for one Hermes run. */
export function createHermesRunDriver(opts: StartOpts, ctx: RuntimeRunContext): HermesDriver {
  return createHermesGatewayDriver(opts, ctx, { supervisor: hermesGateway() })
}

/**
 * At server start: retire approval cards a previous run of the server left open,
 * and start the gateway when Hermes is installed and Clawboo has Hermes agents
 * (or profiles from before), so their own scheduled jobs keep firing. Never
 * throws: a gateway that cannot start is reported on the Runtimes card.
 */
export async function startHermesAtBoot(): Promise<void> {
  try {
    const n = expireOrphanedHermesApprovals(getDb())
    if (n > 0) log.info({ count: n }, 'expired Hermes approval cards left from the last run')
  } catch (err) {
    log.debug({ err }, 'could not sweep Hermes approval cards')
  }
  await startHermesIfWanted('at boot')
}

/** Whether Clawboo has Hermes agents, or an unreadable registry and profiles
 *  on disk from before. */
async function hermesWanted(): Promise<boolean> {
  try {
    return Boolean(
      getDb().select({ id: agents.id }).from(agents).where(eq(agents.runtime, 'hermes')).get(),
    )
  } catch {
    return (await listClawbooProfiles(hermesGatewayHome()).catch(() => [])).length > 0
  }
}

/** Start the gateway when Hermes is installed and Clawboo has Hermes agents, so
 *  their own scheduled jobs fire. Never throws. */
export async function startHermesIfWanted(when: string): Promise<void> {
  if (!managedHermesCommand() || !(await hermesWanted())) return
  try {
    await hermesGateway().ensureRunning()
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), when },
      'Hermes gateway did not start',
    )
  }
}

/**
 * After an agent is deleted: pause its Hermes jobs now, so they stop spending
 * the keys Clawboo gives Hermes. Its profile is set aside at the next gateway
 * start. Never throws.
 */
export async function pauseDeletedHermesAgentJobs(agentId: string): Promise<void> {
  try {
    const gw = hermesGateway()
    const conn = gw.runningConnection()
    if (!conn) return
    const client = gw.profileClient(
      conn,
      hermesProfileName(runtimeIdentityHomePath('hermes', agentId)),
    )
    for (const job of await client.listJobs()) {
      if (job.enabled !== false) await client.pauseJob(job.id).catch(() => undefined)
    }
  } catch (err) {
    // A profile that never ran has no jobs to pause.
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'no Hermes jobs paused for a deleted agent',
    )
  }
}

/** Every Clawboo Hermes agent and its profile. */
function hermesAgentProfiles(): { agentId: string; profile: string }[] {
  const rows = getDb()
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.runtime, 'hermes'))
    .all()
  return rows.map((r) => ({
    agentId: r.id,
    profile: hermesProfileName(runtimeIdentityHomePath('hermes', r.id)),
  }))
}

/** What the Routines view's Hermes section reads and writes through. */
export function hermesJobsBackend(): HermesJobsBackend {
  return {
    configured() {
      try {
        return managedHermesCommand() !== null && hermesAgentProfiles().length > 0
      } catch {
        return false
      }
    },
    async agentClients() {
      // A read never starts the gateway, nor checks it hard enough to replace it.
      const gw = hermesGateway()
      const conn = gw.runningConnection()
      if (!conn) return null
      return hermesAgentProfiles().map(({ agentId, profile }) => ({
        agentId,
        profile,
        client: gw.profileClient(conn, profile),
      }))
    },
    async clientFor(agentId) {
      const entry = hermesAgentProfiles().find((a) => a.agentId === agentId)
      if (!entry) return null
      const gw = hermesGateway()
      const conn = await gw.ensureRunning()
      return { profile: entry.profile, client: gw.profileClient(conn, entry.profile) }
    },
    async agentForProfile(profile) {
      return hermesAgentProfiles().find((a) => a.profile === profile)?.agentId ?? null
    },
  }
}

/** After Hermes's keys changed (a Disconnect): the profiles keep only the keys
 *  Clawboo still gives Hermes. Never throws. */
export async function syncHermesProfileKeys(): Promise<void> {
  try {
    await refreshProfileProviderKeys(hermesGatewayHome(), runtimeKeyEnv('hermes'))
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'could not update Hermes profile keys',
    )
  }
}
