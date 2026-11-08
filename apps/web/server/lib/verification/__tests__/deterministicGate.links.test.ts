// The verify gate reads its command from the checkout's init.sh or
// VERIFICATION.md and appends evidence to VERIFICATION.md. The builder owns the
// checkout, so either can be a link, or a hard link, to a file the server can
// open. The gate never follows one: a linked init.sh reads as none, and no
// evidence is written through a link.

import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveVerifyCommand, runDeterministicGate } from '../deterministicGate'

const isWindows = process.platform === 'win32'
const PASSING = 'git --version'

let base: string
let wt: string
let outside: string
let prevHome: string | undefined

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'clawboo-gate-links-'))
  prevHome = process.env['CLAWBOO_HOME']
  process.env['CLAWBOO_HOME'] = path.join(base, 'data')
  wt = path.join(base, 'data', 'worktrees', 'abc', 't1')
  await mkdir(wt, { recursive: true })
  outside = path.join(base, 'secret.txt')
  await writeFile(outside, "VERIFY_CMD='cat secret'\n")
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  await rm(base, { recursive: true, force: true })
})

describe('the verify gate never follows a link in the checkout', () => {
  it.skipIf(isWindows)('a linked init.sh or VERIFICATION.md reads as no command', async () => {
    await symlink(outside, path.join(wt, 'init.sh'))
    await symlink(outside, path.join(wt, 'VERIFICATION.md'))
    expect(await resolveVerifyCommand(wt)).toEqual({ command: null, source: 'none' })
  })

  it('a hard-linked init.sh reads as no command', async () => {
    await link(outside, path.join(wt, 'init.sh'))
    expect(await resolveVerifyCommand(wt)).toEqual({ command: null, source: 'none' })
  })

  it.skipIf(isWindows)('writes no evidence through a link at VERIFICATION.md', async () => {
    await symlink(outside, path.join(wt, 'VERIFICATION.md'))
    const det = await runDeterministicGate({ worktreePath: wt, verifyCommand: PASSING })
    expect(det.passed).toBe(true)
    expect(await readFile(outside, 'utf8')).toBe("VERIFY_CMD='cat secret'\n")
  })

  it('writes no evidence through a hard link at VERIFICATION.md', async () => {
    await link(outside, path.join(wt, 'VERIFICATION.md'))
    const det = await runDeterministicGate({ worktreePath: wt, verifyCommand: PASSING })
    expect(det.passed).toBe(true)
    expect(await readFile(outside, 'utf8')).toBe("VERIFY_CMD='cat secret'\n")
  })

  it('still reads a plain init.sh and appends evidence to a plain VERIFICATION.md', async () => {
    await writeFile(path.join(wt, 'init.sh'), "VERIFY_CMD='git --version'\n")
    await writeFile(path.join(wt, 'VERIFICATION.md'), '# Verification\n')
    expect(await resolveVerifyCommand(wt)).toMatchObject({ command: 'git --version' })
    await runDeterministicGate({ worktreePath: wt })
    expect(await readFile(path.join(wt, 'VERIFICATION.md'), 'utf8')).toMatch(/### Gate run/)
  })
})
