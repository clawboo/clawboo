import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveClawbooDir, resolveWorkDir } from '../index'

describe('resolveWorkDir', () => {
  it('defaults to clawboo-work in the home folder', () => {
    expect(resolveWorkDir({})).toBe(path.join(os.homedir(), 'clawboo-work'))
  })

  it('puts it beside CLAWBOO_HOME, so two installs keep their work apart', () => {
    const data = path.join(os.tmpdir(), 'install-a')
    expect(resolveWorkDir({ CLAWBOO_HOME: data })).toBe(`${data}-work`)
    expect(resolveWorkDir({ CLAWBOO_HOME: `${data}${path.sep}` })).toBe(`${data}-work`)
  })

  it('takes CLAWBOO_WORK_DIR over everything else', () => {
    const work = path.join(os.tmpdir(), 'elsewhere')
    expect(resolveWorkDir({ CLAWBOO_WORK_DIR: work, CLAWBOO_HOME: '/data' })).toBe(work)
  })

  it('expands a leading ~ and resolves a relative CLAWBOO_WORK_DIR', () => {
    expect(resolveWorkDir({ CLAWBOO_WORK_DIR: '~/w' })).toBe(path.join(os.homedir(), 'w'))
    expect(resolveWorkDir({ CLAWBOO_WORK_DIR: 'rel/w' })).toBe(path.resolve('rel/w'))
  })

  it('ignores a blank CLAWBOO_WORK_DIR', () => {
    expect(resolveWorkDir({ CLAWBOO_WORK_DIR: '  ' })).toBe(path.join(os.homedir(), 'clawboo-work'))
  })

  it('is never the data folder by default', () => {
    for (const env of [{}, { CLAWBOO_HOME: '/srv/clawboo' }]) {
      expect(resolveWorkDir(env)).not.toBe(resolveClawbooDir(env))
    }
  })
})
