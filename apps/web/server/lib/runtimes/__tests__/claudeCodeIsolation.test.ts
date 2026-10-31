import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { claudeCodeIsolation } from '../claudeCodeIsolation'

const posix = process.platform !== 'win32'

describe('claudeCodeIsolation', () => {
  it('loads the project tier only and turns auto memory off', () => {
    const iso = claudeCodeIsolation('/home/ada/.clawboo/workspaces/t1', '/home/ada')
    expect(iso.settingSources).toEqual(['project'])
    expect(iso.settings.autoMemoryEnabled).toBe(false)
  })

  it.runIf(posix)('cuts every memory file above the working folder, and in home', () => {
    const { claudeMdExcludes } = claudeCodeIsolation(
      '/home/ada/.clawboo/workspaces/t1',
      '/home/ada',
    ).settings
    for (const dir of [
      '/home/ada/.clawboo/workspaces',
      '/home/ada/.clawboo',
      '/home/ada',
      '/home',
    ]) {
      expect(claudeMdExcludes).toContain(`${dir}/CLAUDE.md`)
      expect(claudeMdExcludes).toContain(`${dir}/.claude/CLAUDE.md`)
      expect(claudeMdExcludes).toContain(`${dir}/.claude/rules/**`)
    }
    expect(claudeMdExcludes).toContain('/CLAUDE.md')
    // The working folder's own files are the project's, and stay.
    expect(claudeMdExcludes.some((p) => p.startsWith('/home/ada/.clawboo/workspaces/t1/'))).toBe(
      false,
    )
  })

  it.runIf(posix)('cuts home even when the run starts in home itself', () => {
    const { claudeMdExcludes } = claudeCodeIsolation('/home/ada', '/home/ada').settings
    expect(claudeMdExcludes).toContain('/home/ada/.claude/CLAUDE.md')
    expect(claudeMdExcludes).toContain('/home/ada/CLAUDE.md')
  })

  it.runIf(posix)('widens a glob character in a path rather than escaping it', () => {
    const { claudeMdExcludes } = claudeCodeIsolation('/srv/a[1]/repo', '/home/ada').settings
    expect(claudeMdExcludes).toContain('/srv/a?1?/.claude/CLAUDE.md')
  })

  describe('through a symlinked folder', () => {
    let root: string
    beforeEach(() => {
      root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clawboo-cc-iso-')))
    })
    afterEach(() => rmSync(root, { recursive: true, force: true }))

    it.runIf(posix)('cuts the ancestors of the real path too', () => {
      mkdirSync(path.join(root, 'real', 'work'), { recursive: true })
      symlinkSync(path.join(root, 'real'), path.join(root, 'link'))
      const { claudeMdExcludes } = claudeCodeIsolation(
        path.join(root, 'link', 'work'),
        '/home/ada',
      ).settings
      expect(claudeMdExcludes).toContain(`${path.join(root, 'link')}/CLAUDE.md`)
      expect(claudeMdExcludes).toContain(`${path.join(root, 'real')}/CLAUDE.md`)
    })
  })
})
