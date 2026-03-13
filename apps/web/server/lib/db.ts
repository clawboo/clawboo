import path from 'node:path'
import os from 'node:os'

export function getDbPath(): string {
  return path.join(os.homedir(), '.openclaw', 'clawboo', 'clawboo.db')
}
