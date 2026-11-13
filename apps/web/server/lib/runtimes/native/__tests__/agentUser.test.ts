// Clawboo Native with agents on their own OS user (CLAWBOO_AGENT_USER): the
// model loop stays in the server, but an approved command starts through the
// agent host, the file tools read, write and list through it, and the
// transcripts stay in the data folder.
//
// The host here is served in-process and runs as the test's own user, so the
// files are real; what each test proves is that the work went through the host.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startInProcessHost, type InProcessHost } from '../../../agentUser/__tests__/inProcessHost'
import { setActiveAgentHost } from '../../../agentUser/state'
import { runtimeIdentityHomePath } from '../../identityHome'
import { runApprovedCommand } from '../execRun'
import { buildFileTools } from '../fileTools'
import { loadSessionTranscript, saveSessionTranscript } from '../sessionStore'
import type { NeutralMessage } from '../providers/types'

const posix = process.platform !== 'win32'

let base: string
let cwd: string
let dataDir: string
let agentHome: string
let h: InProcessHost | null = null
let ops: string[]
let spawned: { command: string; args: readonly string[]; cwd?: string; group: boolean }[]

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-native-agent-')))
  cwd = path.join(base, 'work', 'teams', 'team-1')
  dataDir = path.join(base, 'data')
  agentHome = path.join(base, 'agent-home')
  for (const dir of [cwd, dataDir, agentHome]) fs.mkdirSync(dir, { recursive: true })
  vi.stubEnv('HOME', base)
  vi.stubEnv('CLAWBOO_HOME', dataDir)
  vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')

  h = startInProcessHost()
  const hello = await h.client.waitForHello()
  setActiveAgentHost({
    client: h.client,
    hello: { ...hello, home: agentHome },
    config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
  })
  ops = []
  spawned = []
  const request = h.client.request.bind(h.client)
  vi.spyOn(h.client, 'request').mockImplementation((req) => {
    ops.push(req.op)
    return request(req)
  })
  const spawn = h.client.spawn.bind(h.client)
  vi.spyOn(h.client, 'spawn').mockImplementation((opts) => {
    spawned.push({ command: opts.command, args: opts.args, cwd: opts.cwd, group: opts.group })
    return spawn(opts)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setActiveAgentHost(null)
  h?.client.close()
  h = null
  fs.rmSync(base, { recursive: true, force: true })
})

describe.runIf(posix)('an approved command with agents on their own user', () => {
  it('starts through the agent host, in the run folder, as a group leader', async () => {
    const res = await runApprovedCommand({
      argv: ['/bin/sh', '-c', 'pwd; printf "%s" "$FOO"'],
      cwd,
      signal: new AbortController().signal,
      env: { PATH: '/usr/bin:/bin', FOO: 'hosted' },
    })
    expect(spawned).toEqual([
      { command: '/bin/sh', args: ['-c', 'pwd; printf "%s" "$FOO"'], cwd, group: true },
    ])
    expect(res).toMatchObject({ exitCode: 0, output: `${cwd}\nhosted` })
  })

  it('a Stop is a tree kill through the host', async () => {
    const ac = new AbortController()
    const run = runApprovedCommand({
      argv: ['sleep', '30'],
      cwd,
      signal: ac.signal,
      env: { PATH: '/usr/bin:/bin' },
    })
    for (let i = 0; i < 100 && spawned.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(spawned).toHaveLength(1)
    // Let the host start it, so the Stop meets a running process.
    await new Promise((r) => setTimeout(r, 50))
    ac.abort()
    const res = await run
    expect(res.stoppedBy).toBe('abort')
    expect(ops).toContain('killTree')
  })

  it('an abort before the spawn starts nothing', async () => {
    const ac = new AbortController()
    ac.abort()
    const res = await runApprovedCommand({ argv: ['touch', 'x'], cwd, signal: ac.signal })
    expect(res.stoppedBy).toBe('abort')
    expect(spawned).toHaveLength(0)
    expect(fs.existsSync(path.join(cwd, 'x'))).toBe(false)
  })
})

describe.runIf(posix)('the file tools with agents on their own user', () => {
  const tool = (name: string) => {
    const t = buildFileTools(cwd).find((x) => x.name === name)
    if (!t) throw new Error(`missing tool ${name}`)
    return t
  }

  it('write, read and list through the agent host', async () => {
    const write = await tool('write_file').run({ path: 'docs/notes.md', content: 'hello' })
    expect(write).toEqual({ output: 'wrote docs/notes.md', isError: false })
    expect(fs.readFileSync(path.join(cwd, 'docs', 'notes.md'), 'utf8')).toBe('hello')
    expect(ops).toEqual(expect.arrayContaining(['fs.stat', 'fs.mkdir', 'fs.write']))

    ops.length = 0
    expect(await tool('read_file').run({ path: 'docs/notes.md' })).toEqual({
      output: 'hello',
      isError: false,
    })
    expect(ops).toEqual(['fs.stat', 'fs.read'])

    ops.length = 0
    const list = await tool('list_files').run({})
    expect(list).toEqual({ output: 'dir  docs', isError: false })
    expect(ops).toEqual(['fs.stat', 'fs.list'])
  })

  it('keeps the jail by name, and asks the host nothing for a path outside it', async () => {
    for (const bad of ['../escape.txt', '/etc/passwd', 'docs/../../escape.txt']) {
      expect((await tool('write_file').run({ path: bad, content: 'x' })).isError).toBe(true)
      expect((await tool('read_file').run({ path: bad })).isError).toBe(true)
      expect((await tool('list_files').run({ path: bad })).isError).toBe(true)
    }
    expect(ops).toEqual([])
    expect(fs.existsSync(path.join(base, 'work', 'teams', 'escape.txt'))).toBe(false)
  })

  it('never follows a link at the name', async () => {
    const secret = path.join(base, 'secret.txt')
    fs.writeFileSync(secret, 'secret')
    fs.symlinkSync(secret, path.join(cwd, 'planted.txt'))
    const read = await tool('read_file').run({ path: 'planted.txt' })
    expect(read.isError).toBe(true)
    expect(read.output).not.toContain('secret')
    expect((await tool('write_file').run({ path: 'planted.txt', content: 'x' })).isError).toBe(true)
    expect(fs.readFileSync(secret, 'utf8')).toBe('secret')
  })

  it('an overwrite keeps the file mode, so a script stays executable', async () => {
    const script = path.join(cwd, 'init.sh')
    fs.writeFileSync(script, '#!/bin/sh\n')
    fs.chmodSync(script, 0o755)
    await tool('write_file').run({ path: 'init.sh', content: '#!/bin/sh\necho hi\n' })
    expect(fs.statSync(script).mode & 0o777).toBe(0o755)
    expect(fs.readFileSync(script, 'utf8')).toBe('#!/bin/sh\necho hi\n')
  })

  it('cuts a long file at the same cap as the local read', async () => {
    fs.writeFileSync(path.join(cwd, 'big.txt'), 'a'.repeat(70 * 1024))
    const read = await tool('read_file').run({ path: 'big.txt' })
    expect(read.isError).toBe(false)
    expect(read.output).toBe(`${'a'.repeat(64 * 1024)}\n…[truncated at ${64 * 1024} bytes]`)
  })

  it('a missing file or folder is a tool error', async () => {
    expect((await tool('read_file').run({ path: 'missing.txt' })).output).toMatch(/ENOENT/)
    expect((await tool('list_files').run({ path: 'missing' })).output).toMatch(/ENOENT/)
  })

  it("in a task's folder, reads reach its team folder through the host, and writes stay", async () => {
    // `cwd` is the team folder here; the run starts in a task folder inside it.
    const taskDir = path.join(cwd, 'tasks', 'task-1')
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(cwd, 'shared.md'), 'team notes')
    const tools = buildFileTools(taskDir, { readRoot: cwd })
    const run = (name: string, args: Record<string, unknown>) =>
      tools.find((x) => x.name === name)!.run(args)

    expect(await run('read_file', { path: '../../shared.md' })).toEqual({
      output: 'team notes',
      isError: false,
    })
    expect(ops).toEqual(['fs.stat', 'fs.read'])
    ops.length = 0
    expect(await run('list_files', { path: '../..' })).toEqual({
      output: 'dir  tasks\nfile shared.md',
      isError: false,
    })
    expect(ops).toEqual(['fs.stat', 'fs.list'])

    // A write may not leave the task's folder, and the host is not asked.
    ops.length = 0
    expect((await run('write_file', { path: '../../shared.md', content: 'x' })).isError).toBe(true)
    expect(ops).toEqual([])
    expect(fs.readFileSync(path.join(cwd, 'shared.md'), 'utf8')).toBe('team notes')
    // Nor may a read leave the team folder.
    expect((await run('read_file', { path: '../../../escape.txt' })).isError).toBe(true)
    expect(ops).toEqual([])
  })
})

describe.runIf(posix)('Native transcripts with agents on their own user', () => {
  const messages: NeutralMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

  it('stay in the data folder, at the place they have without the setting', async () => {
    const homeDir = runtimeIdentityHomePath('native', 'a1')
    expect(homeDir).toBe(path.join(agentHome, 'runtimes', 'native', 'a1'))

    await saveSessionTranscript(homeDir, 'native-s1', messages)
    const kept = path.join(dataDir, 'runtimes', 'native', 'a1', 'sessions', 'native-s1.json')
    expect(JSON.parse(fs.readFileSync(kept, 'utf8'))).toMatchObject({ messages })
    expect(fs.existsSync(path.join(homeDir, 'sessions'))).toBe(false)
    expect(await loadSessionTranscript(homeDir, 'native-s1')).toEqual(messages)
    expect(ops).toEqual([])

    // The same file, found with the setting off.
    vi.stubEnv('CLAWBOO_AGENT_USER', '')
    expect(
      await loadSessionTranscript(path.join(dataDir, 'runtimes', 'native', 'a1'), 'native-s1'),
    ).toEqual(messages)
  })

  it('a home that is not a runtime home keeps no transcript', async () => {
    const elsewhere = path.join(base, 'work', 'teams', 'team-1')
    await saveSessionTranscript(elsewhere, 'native-s2', messages)
    expect(fs.existsSync(path.join(elsewhere, 'sessions'))).toBe(false)
    expect(await loadSessionTranscript(elsewhere, 'native-s2')).toBeNull()
  })
})
