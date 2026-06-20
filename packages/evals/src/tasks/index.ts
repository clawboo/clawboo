import type { EvalTask } from '../types'
import { CAPABILITY_TASKS } from './capability'
import { REGRESSION_TASKS } from './regression'

export { CAPABILITY_TASKS } from './capability'
export { REGRESSION_TASKS } from './regression'

export const ALL_TASKS: EvalTask[] = [...REGRESSION_TASKS, ...CAPABILITY_TASKS]

/** The cheap, deterministic subset that runs on every PR (no live model). */
export const SMOKE_TASKS: EvalTask[] = ALL_TASKS.filter((t) => t.smoke)

/** The ablation set — capability tasks whose success depends on a toggled subsystem. */
export const ABLATION_TASKS: EvalTask[] = CAPABILITY_TASKS
