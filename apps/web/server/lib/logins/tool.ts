// The `fill_login` tool, as a session's tools server serves it.
//
// Served only to a session that names its agent (a signed attach URL, or a Native
// run in-process) and whose run has a person, and only while a browser connector
// is connected. A session without those would only ever be refused, and a tool
// the model cannot use is a tool it wastes turns on.
//
// The audit row the broker writes holds the site and this outcome text; the log
// line below holds the outcome's codes. Neither can hold a value, because nothing
// here ever sees one: `fillLogin` returns an outcome, not a login.

import { createFillLoginTool, type ToolDescriptor } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'

import { getDb } from '../db'
import { runPersonForRef } from '../runPerson'
import { agentBrowserFillAvailable } from './browserLink'
import { fillLogin, outcomeText } from './fill'

const log = createLogger('website-logins')

export interface LoginFillBinding {
  agentId: string | null
  /** The run's board task, when it has one. */
  taskId: string | null
  /** The run's reference (`openRunRef`). */
  runRef: string | null
}

export function loginFillTools(binding: LoginFillBinding): ToolDescriptor[] {
  const agentId = binding.agentId
  if (!agentId) return []
  if (!agentBrowserFillAvailable()) return []
  const runPerson = runPersonForRef(binding.runRef, agentId)
  if (!runPerson?.person) return []
  return [
    createFillLoginTool(async (site) => {
      // Looked up again at call time: a run that ended since the list was built
      // has no person any more.
      const current = runPersonForRef(binding.runRef, agentId) ?? { person: null, basis: 'none' }
      const outcome = await fillLogin({
        db: getDb(),
        agentId,
        site,
        runPerson: current,
        taskId: binding.taskId,
      })
      log.info(
        {
          agentId,
          origin: outcome.origin,
          outcome: outcome.outcome,
          ...('reason' in outcome ? { reason: outcome.reason } : {}),
          ...(outcome.outcome === 'filled' ? { source: outcome.source } : {}),
          basis: current.basis,
        },
        'login fill',
      )
      return outcomeText(outcome)
    }),
  ]
}
