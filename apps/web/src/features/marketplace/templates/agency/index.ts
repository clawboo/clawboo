import type { TeamTemplate } from '@/features/teams/types'
import { academicTemplates } from './academic'
import { designTemplates } from './design'
import { engineeringTemplates } from './engineering'
import { gameDevelopmentTemplates } from './game-development'
import { marketingTemplates } from './marketing'
import { marketingChinaTemplates } from './marketing-china'
import { paidMediaTemplates } from './paid-media'
import { productTemplates } from './product'
import { projectManagementTemplates } from './project-management'
import { salesTemplates } from './sales'
import { spatialComputingTemplates } from './spatial-computing'
import { specializedTemplates } from './specialized'
import { supportTemplates } from './support'
import { testingTemplates } from './testing'
import { workflowTemplates } from './workflows'

export const agencyTemplates: TeamTemplate[] = [
  ...engineeringTemplates,
  ...marketingTemplates,
  ...marketingChinaTemplates,
  ...paidMediaTemplates,
  ...salesTemplates,
  ...productTemplates,
  ...designTemplates,
  ...testingTemplates,
  ...projectManagementTemplates,
  ...supportTemplates,
  ...gameDevelopmentTemplates,
  ...spatialComputingTemplates,
  ...academicTemplates,
  ...specializedTemplates,
  ...workflowTemplates,
]
