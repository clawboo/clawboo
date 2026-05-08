// Clawboo agent catalog source. Re-exports CLAWBOO_BUILTIN_AGENTS and exposes
// an aggregate CLAWBOO_AGENTS array. In future sessions this can grow to include
// user-authored clawboo agents alongside the 15 built-ins.

import type { AgentCatalogEntry } from '@/features/teams/types'
import { CLAWBOO_BUILTIN_AGENTS } from './builtin'

export { CLAWBOO_BUILTIN_AGENTS } from './builtin'

export const CLAWBOO_AGENTS: AgentCatalogEntry[] = [...CLAWBOO_BUILTIN_AGENTS]
