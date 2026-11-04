// Value-based redaction: a saved key that matches none of the scrub's shapes.
//
// The storage scrub in @clawboo/db masks credentials by SHAPE (`sk-…`, `ghp_…`,
// `AIza…`, JWTs, `NAME_KEY=value`). Keys of other shapes (Groq's `gsk_…`, a
// Mistral key, xAI's `xai-…`) passed straight through into every place that
// scrub guards. The vault holds the exact values, so the scrub also masks
// those. This suite saves keys through the real vault, pushes them through the
// real write paths (tool audit, events, governance audit, memory, a run
// summary, the verify gate), and then reads every row of the database back.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  SqliteMemoryStore,
  appendAudit,
  appendEvent,
  createDb,
  scrubResultSummary,
  scrubSecrets,
  writeAuditAfter,
  writeAuditBefore,
  type ClawbooDb,
} from '@clawboo/db'

import { saveStoredClient, saveStoredTokens } from '../connectors/oauthStore'
import { deleteRuntimeSecret, setRuntimeSecret } from '../secretsVault'
import { runDeterministicGate } from '../verification/deterministicGate'

// Fake keys shaped like the providers' real ones. None of them matches a
// pattern in the scrub, which is the point. The Mistral one is joined at run
// time so secret scanners do not read the source line as a real key.
const GROQ = 'gsk_9fQx2LmZ7tVbR4cWnY8pKdHs3JgA6eUiTo1MrXyNqBvCzLw5'
const MISTRAL = ['q7Lm2ZxW9tRb4VcN', '8pKd3HsJ6gAeYu1T'].join('')
const XAI = 'xai-Zt4Qp8LmX2vB7nR3cK9dW5sH1gJ6yA0eUfToMrNqVbCzLwPx'

/** Every text cell of every table, so a value cannot hide in a column nobody checked. */
function allStoredText(db: ClawbooDb): string {
  const sqlite = db.$client
  const tables = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>
  let out = ''
  for (const { name } of tables) {
    const rows = sqlite.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>
    for (const row of rows) {
      for (const cell of Object.values(row)) if (typeof cell === 'string') out += `${cell}\n`
    }
  }
  return out
}

describe('value-based redaction of saved keys', () => {
  let clawbooHome: string
  let db: ClawbooDb
  const SAVED = ['CLAWBOO_HOME', 'CLAWBOO_SECRETS_MASTER_KEY'] as const
  const prev: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of SAVED) prev[k] = process.env[k]
    clawbooHome = mkdtempSync(path.join(os.tmpdir(), 'clawboo-redact-'))
    process.env['CLAWBOO_HOME'] = clawbooHome
    delete process.env['CLAWBOO_SECRETS_MASTER_KEY']
    db = createDb(':memory:')
    setRuntimeSecret('GROQ_API_KEY', GROQ)
    setRuntimeSecret('MISTRAL_API_KEY', MISTRAL)
    setRuntimeSecret('XAI_API_KEY', XAI)
  })

  afterEach(() => {
    db.$client.close()
    for (const k of SAVED) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    rmSync(clawbooHome, { recursive: true, force: true })
  })

  it('keeps a saved key out of the tool audit, events, governance audit and memory', async () => {
    // `printenv GROQ_API_KEY` prints the bare value: no NAME= for the pattern to see.
    writeAuditAfter(db, { toolName: 'shell', result: `${GROQ}\n`, isError: false })
    writeAuditBefore(db, {
      toolName: 'shell',
      decision: 'allow',
      args: { command: `curl -H 'x-api-key: ${MISTRAL}' https://api.example.test/v1` },
    })
    appendEvent(db, {
      kind: 'tool_call',
      data: { output: `key is ${XAI}`, nested: [{ line: `export K=${GROQ}` }] },
    })
    appendAudit(db, { eventType: 'tool_call', summary: { stdout: `${MISTRAL} ok` } })
    await new SqliteMemoryStore(db).saveFact({
      title: 'Groq setup',
      content: `The Groq key is ${GROQ}; use it for fast models.`,
    })

    const stored = allStoredText(db)
    expect(stored).not.toContain(GROQ)
    expect(stored).not.toContain(MISTRAL)
    expect(stored).not.toContain(XAI)
    // The prose around a key survives; only the key goes.
    expect(stored).toContain('use it for fast models')
    expect(stored).toContain('[REDACTED]')
  })

  it('masks a run summary', () => {
    const summary = scrubResultSummary(`Done. I checked the env: XAI=${XAI}, GROQ ${GROQ}.`)
    expect(summary).not.toContain(XAI)
    expect(summary).not.toContain(GROQ)
    expect(summary).toContain('Done. I checked the env')
  })

  it("masks the verify gate's output", async () => {
    const worktree = path.join(clawbooHome, 'worktrees', 'repo', 'task-1')
    mkdirSync(worktree, { recursive: true })
    const det = await runDeterministicGate({
      worktreePath: worktree,
      verifyCommand: `echo ${MISTRAL}`,
      env: { ...process.env },
    })
    expect(det.passed).toBe(true)
    expect(det.stdoutTail).not.toContain(MISTRAL)
    expect(det.stdoutTail).toContain('[REDACTED]')
  })

  it("masks the verify gate's error output", async () => {
    const worktree = path.join(clawbooHome, 'worktrees', 'repo', 'task-2')
    mkdirSync(worktree, { recursive: true })
    const det = await runDeterministicGate({
      worktreePath: worktree,
      verifyCommand: `node -e "process.stderr.write('${MISTRAL}')"`,
      env: { ...process.env },
    })
    expect(det.passed).toBe(true)
    expect(det.stderrTail).not.toContain(MISTRAL)
    expect(det.stderrTail).toContain('[REDACTED]')
  })

  it('reads the vault again after a read that failed, keeping what it lent meanwhile', () => {
    const file = path.join(clawbooHome, 'secrets', 'runtime-keys.json')
    const saved = readFileSync(file, 'utf8')
    // A vault file that cannot be parsed, read before anything was lent.
    writeFileSync(file, '{ not json')
    expect(scrubResultSummary(GROQ)).toBe(GROQ)
    writeFileSync(file, saved)
    expect(scrubResultSummary(GROQ)).toBe('[REDACTED]')
    // Once a set was lent, a later read that fails keeps it rather than lending nothing.
    setRuntimeSecret('connector:x:TOKEN', ['another-saved', '-value-0123'].join(''))
    writeFileSync(file, '{ not json')
    expect(scrubResultSummary(XAI)).toBe('[REDACTED]')
  })

  it('reads the vault again after the master key could not be loaded', () => {
    process.env['CLAWBOO_SECRETS_MASTER_KEY'] = 'not a usable key'
    expect(scrubResultSummary(GROQ)).toBe(GROQ)
    delete process.env['CLAWBOO_SECRETS_MASTER_KEY']
    expect(scrubResultSummary(GROQ)).toBe('[REDACTED]')
  })

  it('masks the JSON-escaped and URL-encoded spellings of a saved value', () => {
    // An OAuth token is base64-ish, so it changes under URL encoding; a pasted
    // credential can hold a quote or a backslash, so it changes under JSON.
    const token = 'ya29.A0Ab+Cd/Ef==Gh9iJkLmNoPqRsTuVwXyZ'
    const password = 'Tr0ub4dor"&\\3-horse-battery'
    saveStoredTokens('notion', { access_token: token, refresh_token: 'rt-1/2+3=4-5678901234' })
    setRuntimeSecret('connector:pg:PGPASSWORD', password)

    const text = [
      `GET /v1/pages?access_token=${encodeURIComponent(token)}`,
      `body=${new URLSearchParams({ t: token }).toString()}`,
      JSON.stringify({ config: { pass: password } }),
    ].join('\n')
    const out = scrubResultSummary(text)
    expect(out).not.toContain(encodeURIComponent(token))
    expect(out).not.toContain(new URLSearchParams({ t: token }).toString().slice(2))
    expect(out).not.toContain(JSON.stringify(password).slice(1, -1))
    expect(out).toContain('GET /v1/pages?access_token=')
  })

  it('lends the secret fields of an OAuth blob, not its structure', () => {
    saveStoredClient('linear', {
      client_id: 'client-id-that-is-public-enough',
      client_secret: 'cs_live_aBcDeFgHiJkLmNoP',
      redirect_uri: 'http://127.0.0.1:43123/callback',
    })
    const out = scrubResultSummary(
      'redirect http://127.0.0.1:43123/callback secret cs_live_aBcDeFgHiJkLmNoP',
    )
    expect(out).not.toContain('cs_live_aBcDeFgHiJkLmNoP')
    // The redirect is not a credential and stays readable.
    expect(out).toContain('http://127.0.0.1:43123/callback')
  })

  it('follows the vault: a replaced key is masked at once, a removed one is not', () => {
    const NEXT = 'gsk_N3wK3yAft3rR0tat1onZZ0123456789abcdefghijklmnop'
    setRuntimeSecret('GROQ_API_KEY', NEXT)
    expect(scrubResultSummary(`now ${NEXT}`)).toBe('now [REDACTED]')

    deleteRuntimeSecret('MISTRAL_API_KEY')
    expect(scrubResultSummary(`was ${MISTRAL}`)).toBe(`was ${MISTRAL}`)
  })

  it('never masks a short saved value, and leaves object keys alone', () => {
    // Short values would wipe ordinary words out of every stored string.
    setRuntimeSecret('connector:pg:PGUSER', 'postgres')
    expect(scrubResultSummary('connect to postgres on 5432')).toBe('connect to postgres on 5432')

    // A saved value that happens to spell a field name must not blank the field.
    setRuntimeSecret('connector:odd:VALUE', 'conversationSummaryText')
    expect(scrubSecrets({ conversationSummaryText: 'hello' })).toEqual({
      conversationSummaryText: 'hello',
    })
  })
})
