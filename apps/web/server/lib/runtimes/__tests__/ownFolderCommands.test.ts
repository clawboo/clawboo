// What a person is told to type once a runtime lives in Clawboo's runtimes
// folder, which is not on their PATH: the full launcher path in a sign-in
// command, and "update it in Settings" instead of an `npm install -g`. The
// runtimes folder is a temp dir with a real install record.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { commitRuntimeInstall, newInstallFolder, terminalCommandName } from '../../runtimeFolder'
import { buildCliLoginPlan, CLI_LOGIN_COMMANDS } from '../cliLoginPlans'
import { codexFailureMessage } from '../codexFailure'

const KEYS = ['CLAWBOO_HOME', 'CLAWBOO_RUNTIMES_DIR', 'CLAWBOO_WORK_DIR'] as const
const saved: Record<string, string | undefined> = {}
let base: string

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k]
  base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'clawboo own folder ')))
  process.env['CLAWBOO_HOME'] = path.join(base, 'data')
  process.env['CLAWBOO_WORK_DIR'] = path.join(base, 'work')
  process.env['CLAWBOO_RUNTIMES_DIR'] = path.join(base, 'runtimes')
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(base, { recursive: true, force: true })
})

function installCodex(): string {
  const folder = newInstallFolder('codex', 'v1')
  const entry = path.join(folder, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  mkdirSync(path.dirname(entry), { recursive: true })
  writeFileSync(entry, '// codex\n')
  commitRuntimeInstall('codex', {
    folder,
    version: '0.167.1',
    source: '@openai/codex@0',
    launchers: { codex: { command: process.execPath, args: [entry] } },
  })
  const bin = path.join(base, 'runtimes', 'bin', 'codex')
  return process.platform === 'win32' ? `${bin}.cmd` : bin
}

const REFUSED = {
  streamError: 'The model is not supported when using Codex with a ChatGPT account.',
  stderr: '',
  modelPinned: false,
}

describe('commands for a runtime in the runtimes folder', () => {
  it('a bare name while Clawboo installed nothing', () => {
    expect(terminalCommandName('codex')).toBe('codex')
    expect(codexFailureMessage(REFUSED)).toMatch(/npm install -g @openai\/codex@0/)
  })

  it.skipIf(process.platform === 'win32')('the quoted launcher path in the sign-in command', () => {
    const launcher = installCodex()
    const plan = buildCliLoginPlan('codex', 'darwin', () => launcher)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.plan.command).toBe(launcher)
    // The folder name has spaces, so the path is quoted for a shell.
    expect(plan.plan.displayCommand).toBe(`'${launcher}' login`)
    // A copy on PATH keeps the bare command.
    const onPath = buildCliLoginPlan('codex', 'darwin', () => '/usr/local/bin/codex')
    expect(onPath.ok && onPath.plan.displayCommand).toBe(CLI_LOGIN_COMMANDS.codex)
  })

  it('an update from Settings, not npm, for a Codex Clawboo installed', () => {
    installCodex()
    const msg = codexFailureMessage(REFUSED)
    expect(msg).toMatch(/Update it in Settings, Runtimes/)
    expect(msg).not.toMatch(/npm install -g/)
  })
})
