import type { TeamTemplate } from '@/features/teams/types'
import { engineeringTemplates } from './engineering'

export const agencyTemplates: TeamTemplate[] = [...engineeringTemplates]
