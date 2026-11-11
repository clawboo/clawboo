// `clawboo agent-user plan` and `clawboo agent-user check`.
//
// Both run inside the server bundle (`node server.js --agent-user <action>`),
// so `check` is exactly the check the server runs at boot. Neither starts the
// dashboard.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { findMonorepoRoot } from './lifecycle'

/** Run `plan` or `check`; resolves to the exit code. */
export function runAgentUser(action: string, args: string[] = []): Promise<number> {
  const bundled = path.join(__dirname, 'server.js')
  const root = fs.existsSync(bundled) ? null : findMonorepoRoot()
  const dev = root ? path.join(root, 'apps/web/server/index.ts') : null
  const [command, argv] = fs.existsSync(bundled)
    ? [process.execPath, [bundled, '--agent-user', action, ...args]]
    : dev && fs.existsSync(dev)
      ? [process.execPath, ['--import', 'tsx', dev, '--agent-user', action, ...args]]
      : [null, []]
  if (!command) {
    process.stderr.write('Could not find the Clawboo server to run the check with.\n')
    return Promise.resolve(1)
  }
  return new Promise((resolve) => {
    const child = spawn(command, argv as string[], {
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
      ...(root ? { cwd: root } : {}),
    })
    child.on('error', (err) => {
      process.stderr.write(`${err.message}\n`)
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}
