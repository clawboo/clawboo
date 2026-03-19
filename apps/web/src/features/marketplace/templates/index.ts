import type { TeamTemplate } from '@/features/teams/types'

import { builtinTemplates } from './builtin'
import { agencyTemplates } from './agency'
import { openclawTemplates } from './openclaw'

export const ALL_TEMPLATES: TeamTemplate[] = [
  ...builtinTemplates,
  ...agencyTemplates,
  ...openclawTemplates,
]
