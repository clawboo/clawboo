// Clean-environment isolation for trials. Each trial gets its OWN throwaway
// sqlite board in a fresh temp dir — leftover files or shared state cause
// correlated failures (an eval cardinal sin). Server-only (node:fs + better-
// sqlite3 via @clawboo/db). Track + cleanup the temp dirs so a long ablation
// run doesn't leak.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDb, type ClawbooDb } from '@clawboo/db'

import type { EvalContext, EvalFlags } from './types'

export const DEFAULT_FLAGS: EvalFlags = { verify: true, structuredState: true }

// Track the HANDLE alongside its dir, not just the dir: a long ablation run makes
// one connection per trial, and removing a directory that still holds an open
// SQLite file fails outright on Windows.
const created: Array<{ dir: string; db: ClawbooDb }> = []

/** Build a CLEAN eval context backed by a throwaway board. Call once per trial. */
export function makeBoardContext(flags: EvalFlags = DEFAULT_FLAGS): EvalContext {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-eval-'))
  const db = createDb(path.join(dir, 'board.db'))
  created.push({ dir, db })
  return { db, flags }
}

/** Close + remove every temp board created since the last cleanup (call in afterAll). */
export function cleanupEvalContexts(): void {
  for (const { dir, db } of created.splice(0)) {
    try {
      db.$client.close()
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true })
  }
}
