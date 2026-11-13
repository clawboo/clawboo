import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildFileTools, resolveJailed, resolveJailedOnDisk } from '../fileTools'

describe('native file tools (cwd jail)', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-ft-'))
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  const toolByName = (name: string) => {
    const tool = buildFileTools(cwd).find((t) => t.name === name)
    if (!tool) throw new Error(`missing tool ${name}`)
    return tool
  }

  it('write_file + read_file round-trip inside the jail (nested dirs created)', async () => {
    const write = await toolByName('write_file').run({ path: 'docs/notes.md', content: 'hello' })
    expect(write.isError).toBe(false)
    expect(await readFile(path.join(cwd, 'docs/notes.md'), 'utf8')).toBe('hello')
    const read = await toolByName('read_file').run({ path: 'docs/notes.md' })
    expect(read).toEqual({ output: 'hello', isError: false })
  })

  it('list_files lists the workspace root by default', async () => {
    await writeFile(path.join(cwd, 'a.txt'), 'x')
    const out = await toolByName('list_files').run({})
    expect(out.isError).toBe(false)
    expect(out.output).toContain('file a.txt')
  })

  it('rejects traversal and absolute paths', async () => {
    for (const bad of [
      '../escape.txt',
      '../../etc/passwd',
      '/etc/passwd',
      'docs/../../escape.txt',
    ]) {
      const out = await toolByName('write_file').run({ path: bad, content: 'nope' })
      expect(out.isError).toBe(true)
    }
    expect(resolveJailed(cwd, '../x')).toBeNull()
    expect(resolveJailed(cwd, '/abs')).toBeNull()
    expect(resolveJailed(cwd, 'ok/inside.txt')).toBe(path.join(cwd, 'ok/inside.txt'))
  })

  it('no cwd means no file tools', () => {
    expect(buildFileTools(null)).toEqual([])
  })

  it('read_file on a missing file is a tool error, not a crash', async () => {
    const out = await toolByName('read_file').run({ path: 'missing.txt' })
    expect(out.isError).toBe(true)
  })

  describe.skipIf(process.platform === 'win32')('symlinks (a shared team folder)', () => {
    let outside: string
    beforeEach(async () => {
      outside = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-ft-out-'))
      await writeFile(path.join(outside, 'secret.txt'), 'keep out')
    })
    afterEach(async () => {
      await rm(outside, { recursive: true, force: true })
    })

    it('read_file refuses a symlink, even one planted by another agent', async () => {
      await symlink(path.join(outside, 'secret.txt'), path.join(cwd, 'link.txt'))
      const out = await toolByName('read_file').run({ path: 'link.txt' })
      expect(out.isError).toBe(true)
      expect(out.output).not.toContain('keep out')
    })

    it('write_file refuses to write through a symlinked folder that leads outside', async () => {
      await symlink(outside, path.join(cwd, 'escape'))
      const out = await toolByName('write_file').run({ path: 'escape/new.txt', content: 'x' })
      expect(out.isError).toBe(true)
      await expect(readFile(path.join(outside, 'new.txt'), 'utf8')).rejects.toThrow()
    })

    it('write_file refuses to overwrite a file through a symlink', async () => {
      await symlink(path.join(outside, 'secret.txt'), path.join(cwd, 'link.txt'))
      const out = await toolByName('write_file').run({ path: 'link.txt', content: 'gone' })
      expect(out.isError).toBe(true)
      expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('keep out')
    })

    it('list_files refuses a symlinked folder that leads outside', async () => {
      await symlink(outside, path.join(cwd, 'escape'))
      const out = await toolByName('list_files').run({ path: 'escape' })
      expect(out.isError).toBe(true)
      expect(out.output).not.toContain('secret.txt')
    })

    it('still allows real files and folders, new ones included', async () => {
      await mkdir(path.join(cwd, 'docs'))
      expect(await resolveJailedOnDisk(cwd, 'docs/new/deep.md')).toBe(
        path.join(cwd, 'docs/new/deep.md'),
      )
      expect(await resolveJailedOnDisk(cwd, '.')).toBe(path.resolve(cwd))
    })
  })
})

// A run in a task's own folder writes there, and may still read the team folder
// that holds it: the team's shared files and the other tasks' folders.
describe('native file tools in a task folder (team folder readable)', () => {
  let team: string
  let task: string

  beforeEach(async () => {
    team = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-ft-team-'))
    task = path.join(team, 'tasks', 'task-1')
    await mkdir(task, { recursive: true })
    await mkdir(path.join(team, 'tasks', 'task-2'), { recursive: true })
    await writeFile(path.join(team, 'shared.md'), 'team notes')
    await writeFile(path.join(team, 'tasks', 'task-2', 'research.md'), 'from task 2')
  })
  afterEach(async () => {
    await rm(team, { recursive: true, force: true })
  })

  const tool = (name: string, readRoot: string | null = team) => {
    const t = buildFileTools(task, { readRoot }).find((x) => x.name === name)
    if (!t) throw new Error(`missing tool ${name}`)
    return t
  }

  it("reads the team's shared files and another task's folder, from the task folder", async () => {
    expect(await tool('read_file').run({ path: '../../shared.md' })).toEqual({
      output: 'team notes',
      isError: false,
    })
    expect(await tool('read_file').run({ path: '../task-2/research.md' })).toEqual({
      output: 'from task 2',
      isError: false,
    })
    const listed = await tool('list_files').run({ path: '../..' })
    expect(listed.output).toContain('file shared.md')
    expect(listed.output).toContain('dir  tasks')
  })

  it('writes only in the task folder', async () => {
    const out = await tool('write_file').run({ path: '../../shared.md', content: 'overwrite' })
    expect(out.isError).toBe(true)
    expect(await readFile(path.join(team, 'shared.md'), 'utf8')).toBe('team notes')
    const ok = await tool('write_file').run({ path: 'report.md', content: 'done' })
    expect(ok.isError).toBe(false)
    expect(await readFile(path.join(task, 'report.md'), 'utf8')).toBe('done')
  })

  it('reads nothing above the team folder', async () => {
    const out = await tool('read_file').run({ path: '../../../outside.md' })
    expect(out.isError).toBe(true)
  })

  it('ignores a read folder that does not hold the working folder', async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-ft-other-'))
    try {
      const out = await tool('read_file', other).run({ path: '../../shared.md' })
      expect(out.isError).toBe(true)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})
