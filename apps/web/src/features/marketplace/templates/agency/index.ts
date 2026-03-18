import type { TeamTemplate } from '@/features/teams/types'
import { engineeringTemplates } from './engineering'
import { marketingTemplates } from './marketing'
import { marketingChinaTemplates } from './marketing-china'
import { paidMediaTemplates } from './paid-media'

export const agencyTemplates: TeamTemplate[] = [
  ...engineeringTemplates,
  ...marketingTemplates,
  ...marketingChinaTemplates,
  ...paidMediaTemplates,
]
