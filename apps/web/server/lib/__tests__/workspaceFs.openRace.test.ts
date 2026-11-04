// `openConfinedFile` checks an open from the handle's side because the agent
// changes its worktree while the server reads it. Each test here makes that
// change at the one moment it matters: during the checks that run after the
// open. The path lookups are wrapped so a test can act just before the nth one
// runs; everything else is the real file system.

import { link, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Armed {
  /** Lookups of this kind still to pass before `fn` runs (1 = the next one). */
  left: number
  fn: () => Promise<void>
}

const hooks = vi.hoisted(() => ({
  /** Before a `realpath`: the name check. */
  realpath: null as null | Armed,
  /** Before a `stat` or `lstat`: the identity check. */
  identity: null as null | Armed,
  /** False simulates a platform without O_NOFOLLOW (Windows). */
  noFollow: true,
  /** True makes the kernel's name for an open file unreadable, as it is off
   *  Linux, so a test reaches the path checks that come after it. */
  noKernelPath: false,
  /** Path lookups made since the test began. */
  seen: { realpath: 0, identity: 0 },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const tick = async (key: 'realpath' | 'identity'): Promise<void> => {
    hooks.seen[key] += 1
    const armed = hooks[key]
    if (!armed) return
    armed.left -= 1
    if (armed.left > 0) return
    hooks[key] = null
    await armed.fn()
  }
  const mocked = {
    ...actual,
    realpath: (async (...args: Parameters<typeof actual.realpath>) => {
      await tick('realpath')
      return actual.realpath(...args)
    }) as typeof actual.realpath,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      await tick('identity')
      return actual.stat(...args)
    }) as typeof actual.stat,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      await tick('identity')
      return actual.lstat(...args)
    }) as typeof actual.lstat,
    readlink: (async (...args: Parameters<typeof actual.readlink>) => {
      if (hooks.noKernelPath && String(args[0]).startsWith('/proc/self/fd/')) {
        throw Object.assign(new Error('no /proc here'), { code: 'ENOENT' })
      }
      return actual.readlink(...args)
    }) as typeof actual.readlink,
  }
  return { ...mocked, default: mocked }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const flags = { ...actual.constants }
  Object.defineProperty(flags, 'O_NOFOLLOW', {
    get: () => (hooks.noFollow ? actual.constants.O_NOFOLLOW : undefined),
    enumerable: true,
  })
  return { ...actual, constants: flags, default: { ...actual, constants: flags } }
})

const { openConfinedFile, readFileAt, WorkspacePathError } = await import('../workspaceFs')
const { realpath: realRealpath } =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

let root: string
let outside: string

beforeEach(async () => {
  hooks.realpath = null
  hooks.identity = null
  hooks.noFollow = true
  hooks.noKernelPath = false
  root = await realRealpath(await mkdtemp(path.join(os.tmpdir(), 'clawboo-race-root-')))
  outside = await realRealpath(await mkdtemp(path.join(os.tmpdir(), 'clawboo-race-out-')))
  await mkdir(path.join(root, 'dist'))
  await writeFile(path.join(root, 'dist', 'index.html'), '<h1>Built</h1>')
  await writeFile(path.join(root, 'notes.txt'), 'inside the worktree')
  await writeFile(path.join(outside, 'index.html'), 'vault-key-canary')
  hooks.seen = { realpath: 0, identity: 0 }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const abs = (): string => path.join(root, 'dist', 'index.html')

/** The folder above the file now leads outside the worktree. */
async function swapDistForLink(): Promise<void> {
  await rename(path.join(root, 'dist'), path.join(root, 'dist-was'))
  await symlink(outside, path.join(root, 'dist'))
}

/** The folder above the file is the worktree's own again. */
async function restoreDist(): Promise<void> {
  await rm(path.join(root, 'dist'))
  await rename(path.join(root, 'dist-was'), path.join(root, 'dist'))
}

async function bytesServed(): Promise<string | Error> {
  try {
    const { handle } = await openConfinedFile(root, abs())
    try {
      return (await handle.readFile()).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch (err) {
    return err as Error
  }
}

describe('openConfinedFile refuses an outside file however the swap is timed', () => {
  it('serves the worktree file when nothing changes', async () => {
    expect(await bytesServed()).toBe('<h1>Built</h1>')
  })

  it('re-reads the link count after the name check: a second name made during the checks is refused', async () => {
    // Opened through a folder that led outside; then, before the name check,
    // the folder is the worktree's again and the outside file has a second
    // name at the checked path. The name and the inode now match.
    // On Linux the kernel check would refuse this first; it is switched off
    // so the test reaches the link-count check it is about.
    hooks.noKernelPath = true
    await swapDistForLink()
    hooks.realpath = {
      left: 1,
      fn: async () => {
        await restoreDist()
        await rm(path.join(root, 'dist', 'index.html'))
        await link(path.join(outside, 'index.html'), path.join(root, 'dist', 'index.html'))
      },
    }
    const served = await bytesServed()
    expect(served).toBeInstanceOf(WorkspacePathError)
    // The name and the inode matched, so only the second link-count read refused it.
    expect((served as Error).message).toBe('Hard-linked files are not served.')
    expect(hooks.seen.identity).toBe(1)
  })

  it('refuses a leaf swapped for a link where O_NOFOLLOW does not exist, even to a file inside', async () => {
    hooks.noFollow = false
    hooks.noKernelPath = true
    await rm(path.join(root, 'dist', 'index.html'))
    await symlink(path.join(root, 'notes.txt'), path.join(root, 'dist', 'index.html'))
    const served = await bytesServed()
    expect(served).toBeInstanceOf(WorkspacePathError)
    // Refused by the name check (the path no longer resolves to itself), before
    // the identity lookup could see the link.
    expect(hooks.seen.realpath).toBe(1)
    expect(hooks.seen.identity).toBe(0)
  })

  // The handle holds the outside file (the folder led outside at the open),
  // and the folder is toggled so both path lookups after the open agree with
  // it: inside for the name check, outside again for the identity check. The
  // path checks pass that, so only the kernel's own name for the handle can
  // refuse it, which Node can read on Linux. The hooks are what make the
  // test fail if that check is ever removed.
  it.runIf(process.platform === 'linux')(
    'on Linux, refuses a folder toggled between the post-open lookups',
    async () => {
      await swapDistForLink()
      hooks.realpath = { left: 1, fn: restoreDist }
      hooks.identity = { left: 1, fn: swapDistForLink }
      const served = await bytesServed()
      expect(served).toBeInstanceOf(WorkspacePathError)
      // Refused by the kernel check, before any path lookup ran.
      expect(hooks.seen.realpath).toBe(0)
    },
  )
})

describe('readFileAt reports truncation from what it read', () => {
  it('a file that shrank after the open and was read whole is not cut', async () => {
    const file = path.join(root, 'shrinks.txt')
    await writeFile(file, 'x'.repeat(30))
    // The resolve makes two realpath lookups (the root, then the file); the
    // third is the check after the open, so the shrink lands between the
    // open and the read.
    hooks.realpath = { left: 3, fn: () => truncate(file, 5) }

    const read = await readFileAt(root, 'shrinks.txt', { maxBytes: 10 })
    expect(read.binary).toBe(false)
    if (read.binary) return
    expect(read.content).toBe('xxxxx')
    expect(read.truncated).toBe(false)
  })

  it('a file longer than the limit is still reported cut', async () => {
    await writeFile(path.join(root, 'long.txt'), 'y'.repeat(30))
    const read = await readFileAt(root, 'long.txt', { maxBytes: 10 })
    expect(read).toMatchObject({ binary: false, content: 'y'.repeat(10), truncated: true })
  })
})
