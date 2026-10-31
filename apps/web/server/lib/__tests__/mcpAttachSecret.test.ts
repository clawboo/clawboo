// Two connections to one database stand in for two Clawboo processes: a
// rotation through either must change what the other signs and accepts.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDb, type ClawbooDb } from '@clawboo/db'
import { signAttachAccess, verifyAttachAccess } from '@clawboo/mcp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getMcpAttachSecret, rotateMcpAttachSecret } from '../mcpAttachSecret'

describe('the attach secret across processes', () => {
  let dir: string
  let a: ClawbooDb
  let b: ClawbooDb

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-attach-secret-'))
    a = createDb(path.join(dir, 'clawboo.db'))
    b = createDb(path.join(dir, 'clawboo.db'))
  })
  afterEach(() => {
    a.$client.close()
    b.$client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('mints one secret that both connections share', () => {
    expect(getMcpAttachSecret(a)).toBe(getMcpAttachSecret(b))
  })

  it('a rotation through one connection voids the old token on the other', async () => {
    const before = signAttachAccess(getMcpAttachSecret(a))
    expect(verifyAttachAccess(getMcpAttachSecret(a), before)).toBe(true)

    await rotateMcpAttachSecret(b)

    expect(verifyAttachAccess(getMcpAttachSecret(a), before)).toBe(false)
    const after = signAttachAccess(getMcpAttachSecret(a))
    expect(after).not.toBe(before)
    expect(verifyAttachAccess(getMcpAttachSecret(b), after)).toBe(true)
  })
})
