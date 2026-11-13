// The boot-time call of the one-time copy into agent space (see copyIn.ts):
// where the originals are, and where they go.

import path from 'node:path'

import { resolveClawbooDir, resolveWorkDir } from '@clawboo/config'
import { getSetting, type ClawbooDb } from '@clawboo/db'

import { runtimeHomesRoot } from '../runtimes/identityHome'
import { realPathOrSpelling, workDirInUse } from '../workDir'
import { ownTeamFolderNames, WORK_DIR_IN_USE_KEY } from '../workDirMigration'
import { copyIntoAgentSpace, planCopyIn, type CopyInReport } from './copyIn'

export async function copyAgentStateIn(
  env: NodeJS.ProcessEnv = process.env,
  db?: ClawbooDb,
): Promise<CopyInReport> {
  const dataDir = resolveClawbooDir(env)
  const workDir = workDirInUse(env)
  // Where team folders made before the setting was turned on can be, the most
  // recent first (planCopyIn takes the first folder of each name):
  // - the work folder the last boot without agent isolation used, as it
  //   recorded it. A CLAWBOO_WORK_DIR it had, unset since, is not in the
  //   environment any more. Only the work-folder move writes this setting, and
  //   the move does not run while isolation is on, so it still names that folder;
  // - the work folder a server without agent isolation would use now;
  // - older still, the data folder's `workspaces/`.
  const { CLAWBOO_WORK_DIR: _ignored, ...withoutWork } = env
  const recorded = db ? getSetting(db, WORK_DIR_IN_USE_KEY) : null
  const previous = new Set<string>()
  if (recorded) previous.add(path.resolve(recorded))
  previous.add(path.resolve(resolveWorkDir(withoutWork)))
  const workRoots = [...previous]
    .filter((dir) => dir !== workDir && realPathOrSpelling(dir) !== workDir)
    .map((dir) => path.join(dir, 'teams'))
  // A work folder can be shared with another install: only this install's
  // teams come out of one, as the work-folder move takes them.
  const mine = db ? ownTeamFolderNames(db) : null
  return copyIntoAgentSpace(
    planCopyIn({
      dataDir,
      agentRuntimesRoot: runtimeHomesRoot(env),
      workDir,
      teamRoots: [...workRoots, path.join(dataDir, 'workspaces')],
      keepTeam: (root, name) => !mine || !workRoots.includes(root) || mine.has(name),
    }),
  )
}
