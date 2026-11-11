import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveClawbooDir, resolveRuntimesDir, resolveWorkDir } from '../index'

describe('resolveRuntimesDir', () => {
  it('defaults to clawboo-runtimes in the home folder', () => {
    expect(resolveRuntimesDir({})).toBe(path.join(os.homedir(), 'clawboo-runtimes'))
  })

  it('puts it beside CLAWBOO_HOME, so a sandboxed install keeps its own copies', () => {
    const data = path.join(os.tmpdir(), 'install-a')
    expect(resolveRuntimesDir({ CLAWBOO_HOME: data })).toBe(`${data}-runtimes`)
    expect(resolveRuntimesDir({ CLAWBOO_HOME: `${data}${path.sep}` })).toBe(`${data}-runtimes`)
  })

  it('takes CLAWBOO_RUNTIMES_DIR over everything else', () => {
    const dir = path.join(os.tmpdir(), 'runtimes-elsewhere')
    expect(resolveRuntimesDir({ CLAWBOO_RUNTIMES_DIR: dir, CLAWBOO_HOME: '/data' })).toBe(dir)
  })

  it('expands a leading ~ and resolves a relative CLAWBOO_RUNTIMES_DIR', () => {
    expect(resolveRuntimesDir({ CLAWBOO_RUNTIMES_DIR: '~/r' })).toBe(path.join(os.homedir(), 'r'))
    expect(resolveRuntimesDir({ CLAWBOO_RUNTIMES_DIR: 'rel/r' })).toBe(path.resolve('rel/r'))
  })

  it('ignores a blank CLAWBOO_RUNTIMES_DIR', () => {
    expect(resolveRuntimesDir({ CLAWBOO_RUNTIMES_DIR: '  ' })).toBe(
      path.join(os.homedir(), 'clawboo-runtimes'),
    )
  })

  it('is never the data folder or the work folder by default', () => {
    for (const env of [{}, { CLAWBOO_HOME: '/srv/clawboo' }]) {
      expect(resolveRuntimesDir(env)).not.toBe(resolveClawbooDir(env))
      expect(resolveRuntimesDir(env)).not.toBe(resolveWorkDir(env))
    }
  })
})
