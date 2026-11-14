// Node's compile cache stays this server's: the variable leaves the process's
// environment as the server loads, so nothing it spawns inherits it, and only the
// server's own successor gets it back.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let saved: string | undefined

beforeEach(() => {
  saved = process.env['NODE_COMPILE_CACHE']
  vi.resetModules()
})

afterEach(() => {
  if (saved === undefined) delete process.env['NODE_COMPILE_CACHE']
  else process.env['NODE_COMPILE_CACHE'] = saved
})

describe('compile cache environment', () => {
  it('takes the cache out of the environment children inherit, and keeps it for the successor', async () => {
    process.env['NODE_COMPILE_CACHE'] = '/data/cache/compile'
    const { compileCacheEnvForSuccessor } = await import('../compileCacheEnv')
    expect(process.env['NODE_COMPILE_CACHE']).toBeUndefined()
    expect(compileCacheEnvForSuccessor()).toEqual({ NODE_COMPILE_CACHE: '/data/cache/compile' })
  })

  it('hands the successor nothing when the server started without one', async () => {
    delete process.env['NODE_COMPILE_CACHE']
    const { compileCacheEnvForSuccessor } = await import('../compileCacheEnv')
    expect(compileCacheEnvForSuccessor()).toEqual({})
  })
})
