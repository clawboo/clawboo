// What `index.ts` calls at boot when CLAWBOO_AGENT_USER is set: gather what the
// startup check needs from the rest of the server, run it, and say how to fix
// a refusal.

import { resolveBootAccessToken } from '../bootAccessToken'
import { resolveRuntimeBin } from '../platform'
import { ownedRuntimeLaunch } from '../runtimeFolder'
import { resolveAgentSdkBinary } from '../runtimes/agentSdkBinary'
import { secretValuesForExposureCheck } from '../secretsVault'
import { startAgentUser } from './boot'
import { AgentUserConfigError } from './config'

type Log = Parameters<typeof startAgentUser>[0]['log']

/** Runtime binaries the agent user will need to run (design 4.6 step 9). */
function runtimeBinaries(): { runtime: string; path: string }[] {
  const out: { runtime: string; path: string }[] = [{ runtime: 'node', path: process.execPath }]
  const claude = resolveAgentSdkBinary()
  if (claude) out.push({ runtime: 'claude-code', path: claude })
  for (const name of ['codex', 'hermes']) {
    const bin = resolveRuntimeBin(name)
    if (bin) out.push({ runtime: name, path: bin })
  }
  // The runtimes Clawboo installed: each launcher and what it runs. Hermes's
  // launcher runs a script on the Python it was installed with. The agent user
  // must be able to run each.
  for (const name of ['openclaw', 'codex', 'hermes']) {
    const launch = ownedRuntimeLaunch(name)
    if (!launch) continue
    const interpreter = launch.record.interpreter?.path
    for (const p of [launch.launcher, launch.command, ...(interpreter ? [interpreter] : [])]) {
      if (!out.some((b) => b.runtime === name && b.path === p)) out.push({ runtime: name, path: p })
    }
  }
  return out
}

/** What the startup check needs from the rest of the server. */
export function gatherCheckInputs(): {
  accessToken: string | null
  secretValues: string[]
  runtimeBinaries: { runtime: string; path: string }[]
} {
  const token = resolveBootAccessToken(process.env)
  const accessToken = token.ok ? (token.token ?? null) : null
  const secrets = new Set(secretValuesForExposureCheck())
  if (accessToken) secrets.add(accessToken)
  for (const k of ['STUDIO_ACCESS_TOKEN', 'GATEWAY_AUTH_TOKEN', 'CLAWBOO_SECRETS_MASTER_KEY']) {
    const v = process.env[k]?.trim()
    if (v) secrets.add(v)
  }
  return { accessToken, secretValues: [...secrets], runtimeBinaries: runtimeBinaries() }
}

/**
 * Start agent isolation. Returns true when agents may run; false after logging
 * why the server must not start.
 */
export async function bootAgentIsolation(log: Log): Promise<boolean> {
  try {
    const report = await startAgentUser({ log, ...gatherCheckInputs() })
    if (report.ok) return true
    const failed = report.steps.find((s) => s.level === 'fail')
    log.error(
      `SECURITY: refusing to start. Agent isolation (CLAWBOO_AGENT_USER) check ${failed?.step ?? '?'} (${failed?.name ?? 'unknown'}) failed: ${failed?.message ?? 'no detail'}`,
    )
    return false
  } catch (err) {
    if (err instanceof AgentUserConfigError) {
      log.error(`CONFIG: refusing to start. ${err.message}`)
      return false
    }
    log.error({ err }, 'SECURITY: refusing to start. Agent isolation could not be checked.')
    return false
  }
}
