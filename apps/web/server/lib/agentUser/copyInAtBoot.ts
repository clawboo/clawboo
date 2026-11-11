// The boot-time call of the one-time copy into agent space (see copyIn.ts):
// where the originals are, and where they go.

import path from 'node:path'

import { resolveClawbooDir, resolveWorkDir } from '@clawboo/config'

import { runtimeHomesRoot } from '../runtimes/identityHome'
import { workDirInUse } from '../workDir'
import { copyIntoAgentSpace, planCopyIn, type CopyInReport } from './copyIn'

export async function copyAgentStateIn(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CopyInReport> {
  const dataDir = resolveClawbooDir(env)
  const workDir = workDirInUse(env)
  // The work folder a server without agent isolation would use: team folders
  // made before the setting was turned on are there (or, older still, in the
  // data folder's `workspaces/`).
  const { CLAWBOO_WORK_DIR: _ignored, ...withoutWork } = env
  const previousWork = path.resolve(resolveWorkDir(withoutWork))
  const teamRoots = [path.join(dataDir, 'workspaces')]
  if (previousWork !== workDir) teamRoots.push(path.join(previousWork, 'teams'))
  return copyIntoAgentSpace(
    planCopyIn({ dataDir, agentRuntimesRoot: runtimeHomesRoot(env), workDir, teamRoots }),
  )
}
