import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'

export function getDbPath(): string {
  return path.join(resolveClawbooDir(), 'clawboo.db')
}
