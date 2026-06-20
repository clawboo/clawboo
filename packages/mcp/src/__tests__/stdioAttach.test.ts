// The stdio attach snippets must embed CLAWBOO_DB_PATH so a copy-pasted attach
// opens the SAME board as the server (the bins default to a DIFFERENT db path
// than the server's). Codex already did this; claude-code + openclaw must too.

import { describe, expect, it } from 'vitest'

import { buildAttachConfig } from '../config'

const DB = '/home/u/.clawboo/clawboo.db'
const BIN = '/pkg/dist/bin/tasks.js'

describe('buildAttachConfig stdio db path', () => {
  it('claude-code stdio snippet embeds CLAWBOO_DB_PATH (-e flag + structured env)', () => {
    const cfg = buildAttachConfig({
      runtime: 'claude-code',
      server: 'tasks',
      transport: 'stdio',
      binPath: BIN,
      dbPath: DB,
    })
    expect(cfg.snippet).toContain(`-e CLAWBOO_DB_PATH=${DB}`)
    expect(JSON.stringify(cfg.structured)).toContain(DB)
  })

  it('openclaw stdio snippet embeds CLAWBOO_DB_PATH (env block + structured env)', () => {
    const cfg = buildAttachConfig({
      runtime: 'openclaw',
      server: 'tasks',
      transport: 'stdio',
      binPath: BIN,
      dbPath: DB,
    })
    expect(cfg.snippet).toContain(`"CLAWBOO_DB_PATH": "${DB}"`)
    expect(JSON.stringify(cfg.structured)).toContain(DB)
  })

  it('codex stdio snippet still embeds CLAWBOO_DB_PATH (regression anchor)', () => {
    const cfg = buildAttachConfig({
      runtime: 'codex',
      server: 'tasks',
      transport: 'stdio',
      binPath: BIN,
      dbPath: DB,
    })
    expect(cfg.snippet).toContain(`CLAWBOO_DB_PATH = "${DB}"`)
  })
})
