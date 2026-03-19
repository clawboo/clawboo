import type { TeamTemplate } from '@/features/teams/types'

import { marketingTemplate } from './marketing'
import { devTemplate } from './dev'
import { researchTemplate } from './research'
import { youtubeTemplate } from './youtube'
import { studentTemplate } from './student'

export const builtinTemplates: TeamTemplate[] = [
  marketingTemplate,
  devTemplate,
  researchTemplate,
  youtubeTemplate,
  studentTemplate,
]
