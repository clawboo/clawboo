// `clawboo agent-user plan` and `clawboo agent-user check`, run by the server
// bundle (`node server.js --agent-user <action>`) so the check is the very code
// the server runs at boot. Neither starts the dashboard. `check` never stops
// running agents and never changes the work folder.

import { runAgentUserCheck } from './check'
import { checkDepsFor } from './boot'
import { AgentUserConfigError, resolveAgentPoolConfig, resolveAgentUserConfig } from './config'
import { agentPoolPlan, agentUserPlan, planInputForThisComputer } from './plan'
import { poolCheckDepsFor, runAgentPoolCheck } from './poolBoot'
import { gatherCheckInputs } from './serverBoot'
import { currentUserName } from './system'

const MARK = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const

/** Run one action; returns the exit code. */
export async function runAgentUserCommand(
  args: string[],
  out: (line: string) => void = (l) => process.stdout.write(l + '\n'),
): Promise<number> {
  const [action, ...rest] = args
  if (action === 'plan' && rest.includes('--pool')) {
    const num = (flag: string, fallback: number): number => {
      const i = rest.indexOf(flag)
      const n = i >= 0 ? Number(rest[i + 1]) : fallback
      return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : fallback
    }
    const base = planInputForThisComputer()
    out(
      agentPoolPlan({
        platform: base.platform,
        serverUser: base.serverUser,
        serverHome: base.serverHome,
        nodePath: base.nodePath,
        users: Math.max(1, num('--pool', 8)),
        teams: num('--teams', 4),
        firstUid: num('--first-uid', 20001),
        firstTeamGid: num('--first-team-gid', 21001),
      }),
    )
    return 0
  }
  if (action === 'plan') {
    const at = rest.indexOf('--user')
    const user = at >= 0 ? rest[at + 1] : process.env['CLAWBOO_AGENT_USER']
    out(agentUserPlan(planInputForThisComputer(user)))
    return 0
  }
  if (action !== 'check') {
    out(
      'Usage: clawboo agent-user plan [--user <name>] | clawboo agent-user plan --pool <n> [--teams <m>] | clawboo agent-user check',
    )
    return 2
  }
  let pool
  try {
    pool = resolveAgentPoolConfig(process.env)
  } catch (err) {
    if (err instanceof AgentUserConfigError) {
      out(err.message)
      return 1
    }
    throw err
  }
  if (pool) {
    const report = await runAgentPoolCheck(
      pool,
      poolCheckDepsFor(pool, process.env, gatherCheckInputs()),
    )
    for (const s of report.steps) out(`${MARK[s.level]}  ${s.step}. ${s.name}: ${s.message}`)
    out(
      report.ok
        ? `\nAgent isolation is ready: each agent will run as its own user (${report.users.length} in the pool).`
        : '\nAgent isolation is not ready. Fix the failed step and run the check again.',
    )
    return report.ok ? 0 : 1
  }
  let config
  try {
    config = resolveAgentUserConfig(process.env)
  } catch (err) {
    if (err instanceof AgentUserConfigError) {
      out(err.message)
      return 1
    }
    throw err
  }
  if (!config) {
    out('Set CLAWBOO_AGENT_USER to the agent user first, for example:')
    out('  CLAWBOO_AGENT_USER=clawboo-agent clawboo agent-user check')
    out('`clawboo agent-user plan` prints the commands that create one.')
    return 1
  }
  const report = await runAgentUserCheck(
    config,
    checkDepsFor(config, process.env, gatherCheckInputs()),
    {
      serverUser: currentUserName(),
    },
  )
  for (const s of report.steps) {
    out(`${MARK[s.level]}  ${s.step}. ${s.name}: ${s.message}`)
  }
  report.client?.close('the check is done')
  out(
    report.ok
      ? `\nAgent isolation is ready: agents will run as ${config.user}.`
      : '\nAgent isolation is not ready. Fix the failed step and run the check again.',
  )
  return report.ok ? 0 : 1
}
