// Clean-environment isolation for trials. Each trial gets its OWN throwaway
// sqlite board in a fresh temp dir — leftover files or shared state cause
// correlated failures (an eval cardinal sin). Server-only (node:fs + better-
// sqlite3 via @clawboo/db). Track + cleanup the temp dirs so a long ablation
// run doesn't leak.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDb } from '@clawboo/db'

import type { EvalContext, EvalFlags } from './types'

export const DEFAULT_FLAGS: EvalFlags = { verify: true, structuredState: true }

const createdDirs: string[] = []

/** Build a CLEAN eval context backed by a throwaway board. Call once per trial. */
export function makeBoardContext(flags: EvalFlags = DEFAULT_FLAGS): EvalContext {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-eval-'))
  createdDirs.push(dir)
  return { db: createDb(path.join(dir, 'board.db')), flags }
}

/** Remove every temp board created since the last cleanup (call in afterAll). */
export function cleanupEvalContexts(): void {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true })
}
