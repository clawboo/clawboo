// Hermes native skills: READ-ONLY listing + the native-wins merge policy.
// There is deliberately no sync/writer under test — clawboo never writes into a
// Hermes home's skills dir.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listNativeSkills, mergeSkillSets } from '../hermesSkills'

describe('hermes native skills', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hskills-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('listNativeSkills reads dirs as-is and files extension-stripped, ignoring dotfiles', async () => {
    const skills = path.join(home, 'skills')
    await mkdir(path.join(skills, 'web-scraper'), { recursive: true })
    await writeFile(path.join(skills, 'summarize.md'), '# skill', 'utf8')
    await writeFile(path.join(skills, '.DS_Store'), '', 'utf8')
    expect(await listNativeSkills(home)).toEqual(['summarize', 'web-scraper'])
  })

  it('listNativeSkills returns [] when the skills dir is absent (read-only, never creates it)', async () => {
    expect(await listNativeSkills(home)).toEqual([])
  })

  it('mergeSkillSets unions both sources and NATIVE wins on a name collision', () => {
    const merged = mergeSkillSets(['summarize', 'web-scraper'], ['summarize', 'clawboo-board'])
    expect(merged).toEqual([
      { name: 'clawboo-board', source: 'managed' },
      { name: 'summarize', source: 'native' }, // collision → native wins
      { name: 'web-scraper', source: 'native' },
    ])
  })
})
