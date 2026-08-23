// A credential value goes into the vault and reaches exactly one place: the
// spawned child's environment. These assert that boundary rather than describing
// it.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearConnectorCredential,
  connectorSecretSlot,
  credentialStatus,
  credentialsSatisfied,
  resolveConnectorCredentials,
  setConnectorCredential,
  type DeclaredInput,
} from '../credentials'

const INPUTS: DeclaredInput[] = [
  { key: 'NOTION_TOKEN', description: 'a token', required: true, secret: true },
  { key: 'NOTION_SPACE', description: 'optional space', required: false, secret: false },
]

describe('connector credentials', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let prevAmbient: string | undefined

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-creds-'))
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    prevAmbient = process.env['NOTION_TOKEN']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = home
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    if (prevAmbient === undefined) delete process.env['NOTION_TOKEN']
    else process.env['NOTION_TOKEN'] = prevAmbient
    rmSync(home, { recursive: true, force: true })
  })

  it('reports presence, and only a REQUIRED gap blocks', () => {
    expect(credentialsSatisfied('notion', INPUTS)).toBe(false)
    setConnectorCredential('notion', 'NOTION_TOKEN', 'ntn_secret')
    // The optional one is still missing and must not block.
    expect(credentialsSatisfied('notion', INPUTS)).toBe(true)

    const status = credentialStatus('notion', INPUTS)
    expect(status.find((c) => c.key === 'NOTION_TOKEN')?.present).toBe(true)
    expect(status.find((c) => c.key === 'NOTION_SPACE')?.present).toBe(false)
    // Presence only. A value must never appear in a status shape.
    expect(JSON.stringify(status)).not.toContain('ntn_secret')
  })

  it('IGNORES an ambient value with the same name', () => {
    // resolveRuntimeKey reads process.env first, which is right for a runtime
    // and wrong here: a user with NOTION_TOKEN exported would silently hand it
    // to any connector that happened to name the same variable.
    process.env['NOTION_TOKEN'] = 'ambient-must-not-be-used'
    expect(credentialsSatisfied('notion', INPUTS)).toBe(false)
    expect(resolveConnectorCredentials('notion', INPUTS)).toEqual({})
  })

  it('namespaces the slot per connector, so two cannot overwrite each other', () => {
    // A work and a personal Notion token both want NOTION_TOKEN.
    setConnectorCredential('notion', 'NOTION_TOKEN', 'work')
    setConnectorCredential('notion-personal', 'NOTION_TOKEN', 'personal')
    expect(resolveConnectorCredentials('notion', INPUTS)['NOTION_TOKEN']).toBe('work')
    expect(resolveConnectorCredentials('notion-personal', INPUTS)['NOTION_TOKEN']).toBe('personal')
    expect(connectorSecretSlot('notion', 'NOTION_TOKEN')).not.toBe(
      connectorSecretSlot('notion-personal', 'NOTION_TOKEN'),
    )
  })

  it('omits a missing optional credential rather than passing an empty string', () => {
    // A connector that reads "" as configured fails far more confusingly than
    // one that reports the variable as missing.
    setConnectorCredential('notion', 'NOTION_TOKEN', 'x')
    const env = resolveConnectorCredentials('notion', INPUTS)
    expect('NOTION_SPACE' in env).toBe(false)
  })

  it('clears a credential', () => {
    setConnectorCredential('notion', 'NOTION_TOKEN', 'x')
    expect(credentialsSatisfied('notion', INPUTS)).toBe(true)
    clearConnectorCredential('notion', 'NOTION_TOKEN')
    expect(credentialsSatisfied('notion', INPUTS)).toBe(false)
  })
})
