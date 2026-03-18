import type { TeamTemplate } from '@/features/teams/types'
import { designTemplates } from './design'
import { engineeringTemplates } from './engineering'
import { marketingTemplates } from './marketing'
import { marketingChinaTemplates } from './marketing-china'
import { paidMediaTemplates } from './paid-media'
import { productTemplates } from './product'
import { salesTemplates } from './sales'
import { testingTemplates } from './testing'

export const agencyTemplates: TeamTemplate[] = [
  ...engineeringTemplates,
  ...marketingTemplates,
  ...marketingChinaTemplates,
  ...paidMediaTemplates,
  ...salesTemplates,
  ...productTemplates,
  ...designTemplates,
  ...testingTemplates,
]
