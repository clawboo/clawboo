// The workspace filesystem view's safety properties. The confinement suite is
// the load-bearing part: these endpoints serve arbitrary files from a local
// server, so every escape route (.., absolute paths, symlinked files,
// symlinked ancestor directories, lexical prefix cousins) must be refused, and
// each refusal is pinned here. Real-filesystem tests in a temp dir; the git
// status parser is covered against a real `git status` run.

import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { execGit } from '@clawboo/worktrees'

import {
  listDirAt,
  parsePorcelainStatus,
  readFileAt,
  resolveWorkspaceRelPath,
  WorkspacePathError,
} from '../workspaceFs'

let root: string
let outside: string

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'clawboo-wsfs-'))
  outside = await mkdtemp(path.join(os.tmpdir(), 'clawboo-wsfs-outside-'))
  await mkdir(path.join(root, 'src', 'deep'), { recursive: true })
  await mkdir(path.join(root, '.git'), { recursive: true })
  await writeFile(path.join(root, 'README.md'), '# hello\n')
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  await writeFile(path.join(root, 'src', 'deep', 'b.ts'), 'export const b = 2\n')
  await writeFile(path.join(root, '.hidden'), 'dot\n')
  await writeFile(path.join(outside, 'secret.txt'), 'outside\n')
  // A symlinked FILE inside the workspace pointing outside.
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
  // A symlinked DIRECTORY inside the workspace pointing outside.
  await symlink(outside, path.join(root, 'linkdir'))
  // Binary sample.
  await writeFile(path.join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('resolveWorkspaceRelPath confinement', () => {
  it('resolves a plain relative path', async () => {
    const abs = await resolveWorkspaceRelPath(root, 'src/a.ts')
    expect(abs.endsWith(path.join('src', 'a.ts'))).toBe(true)
  })

  it('resolves the root itself for the empty path', async () => {
    await expect(resolveWorkspaceRelPath(root, '')).resolves.toBeTruthy()
  })

  it('refuses an absolute path', async () => {
    await expect(resolveWorkspaceRelPath(root, '/etc/passwd')).rejects.toThrow(WorkspacePathError)
  })

  it('refuses .. traversal', async () => {
    await expect(resolveWorkspaceRelPath(root, '../secret.txt')).rejects.toThrow(WorkspacePathError)
    await expect(resolveWorkspaceRelPath(root, 'src/../../x')).rejects.toThrow(WorkspacePathError)
  })

  it('refuses NUL bytes, control characters, and backslashes', async () => {
    await expect(resolveWorkspaceRelPath(root, 'a\0b')).rejects.toThrow(WorkspacePathError)
    await expect(resolveWorkspaceRelPath(root, 'a\nb')).rejects.toThrow(WorkspacePathError)
    await expect(resolveWorkspaceRelPath(root, 'a\\b')).rejects.toThrow(WorkspacePathError)
  })

  it('refuses an over-long path', async () => {
    await expect(resolveWorkspaceRelPath(root, 'a/'.repeat(600) + 'x')).rejects.toThrow(
      WorkspacePathError,
    )
  })

  it('refuses a symlinked file (points outside or not)', async () => {
    await expect(resolveWorkspaceRelPath(root, 'link.txt')).rejects.toThrow(
      'Symbolic links are not served.',
    )
  })

  it('refuses a path through a symlinked directory', async () => {
    await expect(resolveWorkspaceRelPath(root, 'linkdir/secret.txt')).rejects.toThrow(
      WorkspacePathError,
    )
  })

  it('refuses a missing file when mustExist (default)', async () => {
    await expect(resolveWorkspaceRelPath(root, 'nope.txt')).rejects.toThrow(
      'No such file in the workspace.',
    )
  })

  it('confines but allows a missing leaf when mustExist is false', async () => {
    const abs = await resolveWorkspaceRelPath(root, 'gone.txt', { mustExist: false })
    // Compare against the REALPATHED root: on macOS the tmpdir is /var/...,
    // which resolves to /private/var/..., and resolution works on real paths.
    expect(abs.startsWith(await realpath(root))).toBe(true)
    await expect(
      resolveWorkspaceRelPath(root, '../gone.txt', { mustExist: false }),
    ).rejects.toThrow(WorkspacePathError)
  })

  it('a lexical prefix cousin of the root cannot pass as the root', async () => {
    // <root>-evil/x resolved against <root> would survive a startsWith(root)
    // prefix test; path.relative refuses it.
    const cousin = `${root}-evil`
    await mkdir(cousin, { recursive: true })
    await writeFile(path.join(cousin, 'x'), 'evil\n')
    try {
      await expect(resolveWorkspaceRelPath(root, `../${path.basename(cousin)}/x`)).rejects.toThrow(
        WorkspacePathError,
      )
    } finally {
      await rm(cousin, { recursive: true, force: true })
    }
  })
})

describe('regressions fixed in review', () => {
  it('allows a root-level entry whose name begins with ".." ', async () => {
    // `path.relative` returns "..foo" for this, which a prefix test would have
    // refused as an escape. The segment test accepts it.
    await writeFile(path.join(root, '..foo'), 'legit\n')
    const abs = await resolveWorkspaceRelPath(root, '..foo')
    expect(abs.endsWith('..foo')).toBe(true)
    // The real escape is still refused.
    await expect(resolveWorkspaceRelPath(root, '../foo')).rejects.toThrow(WorkspacePathError)
  })

  it('a short read does not misclassify a text file as binary', async () => {
    // A zero-filled tail from a shrinking file used to read as NUL bytes.
    const p = path.join(root, 'shrink.txt')
    await writeFile(p, 'hello world\n')
    const read = await readFileAt(root, 'shrink.txt', { maxBytes: 4096 })
    expect(read.binary).toBe(false)
    if (!read.binary) expect(read.content).toBe('hello world\n')
  })

  it('sizes only the entries it returns', async () => {
    const dir = path.join(root, 'sized')
    await mkdir(dir, { recursive: true })
    for (let i = 0; i < 6; i++) await writeFile(path.join(dir, `s${i}.txt`), 'xx')
    const listing = await listDirAt(root, 'sized', { maxEntries: 3 })
    expect(listing.entries.length).toBe(3)
    expect(listing.truncated).toBe(true)
    for (const e of listing.entries) expect(e.size).toBe(2)
  })

  it('drops a trailing incomplete multi-byte sequence rather than mangling it', async () => {
    // 'é' is two bytes; cutting at 1 byte must not emit a replacement char.
    await writeFile(path.join(root, 'utf8.txt'), 'aé')
    const read = await readFileAt(root, 'utf8.txt', { maxBytes: 2 })
    expect(read.binary).toBe(false)
    if (!read.binary) {
      expect(read.content).toBe('a')
      expect(read.content).not.toContain('\uFFFD')
      expect(read.truncated).toBe(true)
    }
  })
})

describe('listDirAt', () => {
  it('lists one level, dirs first, skipping .git and symlinks', async () => {
    const listing = await listDirAt(root, '')
    const names = listing.entries.map((e) => e.name)
    expect(names).not.toContain('.git')
    expect(names).not.toContain('link.txt')
    expect(names).not.toContain('linkdir')
    expect(names).toContain('src')
    expect(names).toContain('README.md')
    expect(names).toContain('.hidden') // dotfiles are shown
    // Directories sort before files.
    expect(names.indexOf('src')).toBeLessThan(names.indexOf('README.md'))
    const readme = listing.entries.find((e) => e.name === 'README.md')
    expect(readme?.kind).toBe('file')
    expect(readme?.size).toBeGreaterThan(0)
  })

  it('truncates at the entry cap and says so', async () => {
    const capDir = path.join(root, 'many')
    await mkdir(capDir, { recursive: true })
    for (let i = 0; i < 12; i++) await writeFile(path.join(capDir, `f${i}.txt`), 'x')
    const listing = await listDirAt(root, 'many', { maxEntries: 10 })
    expect(listing.entries.length).toBe(10)
    expect(listing.truncated).toBe(true)
  })

  it('refuses to list a file', async () => {
    await expect(listDirAt(root, 'README.md')).rejects.toThrow('Not a directory.')
  })
})

describe('readFileAt', () => {
  it('reads text content with size', async () => {
    const read = await readFileAt(root, 'src/a.ts')
    expect(read.binary).toBe(false)
    if (!read.binary) {
      expect(read.content).toContain('export const a')
      expect(read.truncated).toBe(false)
    }
  })

  it('classifies a NUL-carrying file as binary and returns no bytes', async () => {
    const read = await readFileAt(root, 'blob.bin')
    expect(read.binary).toBe(true)
    if (read.binary) expect(read.size).toBe(4)
    expect('content' in read).toBe(false)
  })

  it('truncates an oversized text file with a flag', async () => {
    await writeFile(path.join(root, 'big.txt'), 'x'.repeat(100))
    const read = await readFileAt(root, 'big.txt', { maxBytes: 10 })
    expect(read.binary).toBe(false)
    if (!read.binary) {
      expect(read.content.length).toBe(10)
      expect(read.truncated).toBe(true)
      expect(read.size).toBe(100)
    }
  })

  it('refuses to read a directory', async () => {
    await expect(readFileAt(root, 'src')).rejects.toThrow('Not a file.')
  })
})

describe('parsePorcelainStatus', () => {
  it('parses modified, added, deleted and untracked records', () => {
    const raw = [' M src/a.ts', 'A  new.ts', ' D gone.ts', '?? fresh.ts'].join('\0') + '\0'
    const parsed = parsePorcelainStatus(raw)
    expect(parsed.entries).toEqual([
      { path: 'src/a.ts', x: ' ', y: 'M' },
      { path: 'new.ts', x: 'A', y: ' ' },
      { path: 'gone.ts', x: ' ', y: 'D' },
      { path: 'fresh.ts', x: '?', y: '?' },
    ])
    expect(parsed.truncated).toBe(false)
  })

  it('consumes the rename source as the next NUL record', () => {
    const raw = 'R  renamed.ts\0orig.ts\0 M other.ts\0'
    const parsed = parsePorcelainStatus(raw)
    expect(parsed.entries).toEqual([
      { path: 'renamed.ts', x: 'R', y: ' ', origPath: 'orig.ts' },
      { path: 'other.ts', x: ' ', y: 'M' },
    ])
  })

  it('truncates at the cap', () => {
    const raw = Array.from({ length: 5 }, (_, i) => ` M f${i}.ts`).join('\0') + '\0'
    const parsed = parsePorcelainStatus(raw, { maxEntries: 3 })
    expect(parsed.entries.length).toBe(3)
    expect(parsed.truncated).toBe(true)
  })

  it('round-trips against a real git status -z', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'clawboo-wsfs-git-'))
    try {
      await execGit(repo, ['init'])
      await execGit(repo, ['config', 'user.email', 'test@example.com'])
      await execGit(repo, ['config', 'user.name', 'test'])
      await writeFile(path.join(repo, 'tracked.txt'), 'one\n')
      await execGit(repo, ['add', '.'])
      await execGit(repo, ['commit', '-m', 'base'])
      await writeFile(path.join(repo, 'tracked.txt'), 'two\n')
      await writeFile(path.join(repo, 'fresh.txt'), 'new\n')
      const raw = await execGit(repo, ['status', '--porcelain', '-z', '--untracked-files=all'])
      const parsed = parsePorcelainStatus(raw)
      const byPath = new Map(parsed.entries.map((e) => [e.path, e]))
      expect(byPath.get('tracked.txt')?.y).toBe('M')
      expect(byPath.get('fresh.txt')?.x).toBe('?')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
