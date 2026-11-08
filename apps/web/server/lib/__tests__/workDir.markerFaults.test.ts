// The ownership marker when its write fails partway: the temp file it was being
// written to does not stay beside the checkout.

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeOwnerMarker } from '../workDir'

const hooks = vi.hoisted(() => ({ fail: null as null | 'writeFile' | 'close' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    const fail = hooks.fail
    hooks.fail = null
    if (fail === 'writeFile') {
      handle.writeFile = async () => {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      }
    } else if (fail === 'close') {
      const close = handle.close.bind(handle)
      handle.close = async () => {
        await close()
        throw Object.assign(new Error('i/o error'), { code: 'EIO' })
      }
    }
    return handle
  }) as typeof actual.open
  const mocked = { ...actual, open }
  return { ...mocked, default: mocked }
})

let root: string
beforeEach(async () => {
  hooks.fail = null
  root = await mkdtemp(path.join(os.tmpdir(), 'clawboo-marker-faults-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('writeOwnerMarker', () => {
  it.each(['writeFile', 'close'] as const)(
    'leaves no temp file beside the checkout when %s fails',
    async (step) => {
      hooks.fail = step
      await expect(writeOwnerMarker(root, 't1', 'install-a')).rejects.toThrow()
      expect(await readdir(root)).toEqual([])
    },
  )
})
