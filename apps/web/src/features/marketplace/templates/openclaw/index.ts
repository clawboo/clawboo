import type { TeamTemplate } from '@/features/teams/types'

import { composedTemplates } from './composed'
import { multiAgentTemplates } from './multi-agent'

export const openclawTemplates: TeamTemplate[] = [...multiAgentTemplates, ...composedTemplates]
