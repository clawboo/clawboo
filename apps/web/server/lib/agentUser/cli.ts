// `clawboo agent-user plan` and `clawboo agent-user check`, run by the server
// bundle (`node server.js --agent-user <action>`) so the check is the very code
// the server runs at boot. Neither starts the dashboard. `check` never stops
// running agents and never changes the work folder.

import { runAgentUserCheck } from './check'
import { checkDepsFor } from './boot'
import { AgentUserConfigError, resolveAgentUserConfig } from './config'
import { agentUserPlan, planInputForThisComputer } from './plan'
import { gatherCheckInputs } from './serverBoot'
import { currentUserName } from './system'

const MARK = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const

/** Run one action; returns the exit code. */
export async function runAgentUserCommand(
  args: string[],
  out: (line: string) => void = (l) => process.stdout.write(l + '\n'),
): Promise<number> {
  const [action, ...rest] = args
  if (action === 'plan') {
    const at = rest.indexOf('--user')
    const user = at >= 0 ? rest[at + 1] : process.env['CLAWBOO_AGENT_USER']
    out(agentUserPlan(planInputForThisComputer(user)))
    return 0
  }
  if (action !== 'check') {
    out('Usage: clawboo agent-user plan [--user <name>] | clawboo agent-user check')
    return 2
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
