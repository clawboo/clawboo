import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildFileTools, resolveJailed } from '../fileTools'

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
})
