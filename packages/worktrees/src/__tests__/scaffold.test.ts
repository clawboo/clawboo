import { readFile, stat, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  SOR_FILES,
  renderInitSh,
  renderTaskMd,
  renderDecisionsJson,
  writeScaffold,
} from '../scaffold'
import { scaffoldInput } from './gitHarness'

describe('system-of-record scaffold', () => {
  it('renders TASK.md with title, id, acceptance criteria', () => {
    const md = renderTaskMd(scaffoldInput('abc'))
    expect(md).toContain('# Task: Add feature X')
    expect(md).toContain('`abc`')
    expect(md).toContain('- [ ] Feature X works')
  })

  it('renders a fail-loud, runtime-agnostic init.sh with the configured commands', () => {
    const sh = renderInitSh(scaffoldInput())
    expect(sh).toContain('#!/usr/bin/env bash')
    expect(sh).toContain('set -euo pipefail')
    expect(sh).toContain("INSTALL_CMD='echo install'")
    expect(sh).toContain("VERIFY_CMD='echo verify'")
    expect(sh).toContain('RUN_START_COMMAND')
  })

  it('renders DECISIONS.json as a valid, empty-but-schema-tagged structure', () => {
    const parsed = JSON.parse(renderDecisionsJson()) as { $schema: string; decisions: unknown[] }
    expect(parsed.$schema).toContain('clawboo/decisions')
    expect(parsed.decisions).toEqual([])
  })

  describe('writeScaffold', () => {
    let dir: string
    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-scaffold-'))
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('writes the five SoR files and makes init.sh executable (but NOT a handoff)', async () => {
      await writeScaffold(dir, scaffoldInput('x'))
      for (const leaf of [
        SOR_FILES.task,
        SOR_FILES.progress,
        SOR_FILES.decisions,
        SOR_FILES.init,
        SOR_FILES.verification,
      ]) {
        await expect(readFile(path.join(dir, leaf), 'utf8')).resolves.toBeTruthy()
      }
      // init.sh is executable (owner exec bit set).
      const st = await stat(path.join(dir, SOR_FILES.init))
      expect(st.mode & 0o100).toBeTruthy()
      // AGENT_HANDOFF.json is the clock-out artifact — not written by the scaffold.
      await expect(readFile(path.join(dir, SOR_FILES.handoff), 'utf8')).rejects.toThrow()
    })
  })
})
