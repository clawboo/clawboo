// Native runtime health resolves across the descriptor's FULL provider env-var
// set (envVar + altEnvVars: Anthropic / OpenAI / OpenRouter) plus keyless Ollama.
// The vault + OpenClaw .env are sandboxed (empty) so resolveRuntimeKey reads only
// the process env we control here — an OpenRouter-only setup must read healthy.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { adapterFactoryFor } from '../index'
import type { RuntimeRunContext } from '../types'

const PROVIDER_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'OLLAMA_BASE_URL',
] as const

function nativeHealth() {
  return adapterFactoryFor('clawboo-native')({} as RuntimeRunContext).health()
}

describe('nativeKeyHealth — full env-var set + keyless Ollama', () => {
  let home: string
  let stateDir: string
  const saved: Record<string, string | undefined> = {}
  let prevHome: string | undefined
  let prevState: string | undefined

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-nativehealth-'))
    stateDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-nativehealth-st-'))
    prevHome = process.env['CLAWBOO_HOME']
    prevState = process.env['OPENCLAW_STATE_DIR']
    process.env['CLAWBOO_HOME'] = home // empty vault
    process.env['OPENCLAW_STATE_DIR'] = stateDir // no OpenClaw .env
    for (const k of PROVIDER_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of PROVIDER_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevHome
    if (prevState === undefined) delete process.env['OPENCLAW_STATE_DIR']
    else process.env['OPENCLAW_STATE_DIR'] = prevState
    rmSync(home, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('is healthy with ONLY an OpenRouter key (an altEnvVar, not the primary)', async () => {
    process.env['OPENROUTER_API_KEY'] = 'or-test-key'
    expect(await nativeHealth()).toMatchObject({ ok: true })
  })

  it('is healthy with a keyless Ollama base URL', async () => {
    process.env['OLLAMA_BASE_URL'] = 'http://localhost:11434'
    expect(await nativeHealth()).toMatchObject({ ok: true })
  })

  it('is unhealthy with no provider key and no Ollama', async () => {
    expect(await nativeHealth()).toMatchObject({ ok: false })
  })
})
