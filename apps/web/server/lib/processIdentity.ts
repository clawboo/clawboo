// Is the process holding a recorded pid still the one we recorded?
//
// Shared by the durable pid records (`connectors/pidFile.ts` for connector
// children, `runtimes/runtimePidFile.ts` for agent runs) and the start marker
// (`portUtils.ts`). Each writes a pid down so a LATER process can act on it, and
// a bare pid is not enough for that: the kernel hands the same numbers out
// again.
//
// The checks live in `@clawboo/process-lookup`, because the `clawboo` command
// reads the start marker too and cannot import the server's code. Re-exported
// here BY NAME (never `export *` from a workspace package: tsup keeps it
// external and a downstream bundle cannot follow the star).

export {
  currentBootAt,
  currentBootIdentity,
  currentEngineIdentity,
  currentInitStart,
  currentPidNamespace,
  engineStanding,
  isAlive,
  LINUX_BOOT_UNREADABLE,
  linuxBootUnreadable,
  MAX_TRUSTED_AGE_MS,
  parseStatStartTime,
  pidExists,
  processStartTimes,
  START_TIME_SLACK_MS,
  startTimeMatch,
} from '@clawboo/process-lookup'
export type {
  BootIdentity,
  EngineIdentity,
  EngineStanding,
  ProcView,
  StartTimeMatch,
  StartTimes,
} from '@clawboo/process-lookup'
