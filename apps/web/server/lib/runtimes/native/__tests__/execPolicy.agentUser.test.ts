// What `run_command` looks at before a person is asked, with agents on their
// own OS user (CLAWBOO_AGENT_USER), and a named pipe at the program's path in
// either mode.
//
// Every look at a program is this server's own file access on a path the model
// chose. With agents on their own user the agent can write its home and its
// work folder, so a program there is refused by name, the agent host says first
// what the agent user can execute, and the program must be owned by root or the
// server's own user and writable by neither group nor others. A named pipe
// swapped in before the open must never hold the open.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDb, listPendingApprovals, resolveApproval, type ClawbooDb } from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startInProcessHost, type InProcessHost } from '../../../agentUser/__tests__/inProcessHost'
import { setActiveAgentHost } from '../../../agentUser/state'
import { inspectResolvedProgram, resolveAgentProgram } from '../execPolicy'
import { buildExecTool } from '../execTool'

const posix = process.platform !== 'win32'
/** Every file a test makes is owned by root when the tests run as root. */
const notRoot = posix && process.getuid?.() !== 0

/** Files this test makes now read as another user's: the server "runs as" someone else. */
function serverRunsAsSomeoneElse(): void {
  // `getuid` is optional in Node's types (Windows has none), so name it plainly.
  vi.spyOn(process as { getuid: () => number }, 'getuid').mockReturnValue(424242)
}

let base: string
let work: string
let agentHome: string
let bin: string
let db: ClawbooDb
let h: InProcessHost | null = null
let ops: string[]
let spawned: string[]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function executable(file: string, body = '#!/bin/echo\n'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  fs.chmodSync(file, 0o755)
  return file
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-exec-agent-')))
  work = path.join(base, 'work')
  agentHome = path.join(base, 'agent-home')
  bin = path.join(base, 'bin')
  for (const dir of [work, agentHome, bin, path.join(base, 'data')]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  vi.stubEnv('HOME', base)
  vi.stubEnv('CLAWBOO_HOME', path.join(base, 'data'))
  vi.stubEnv('CLAWBOO_WORK_DIR', work)
  db = createDb(':memory:')
  ops = []
  spawned = []
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setActiveAgentHost(null)
  h?.client.close()
  h = null
  db.$client.close()
  fs.rmSync(base, { recursive: true, force: true })
})

async function agentMode(): Promise<void> {
  vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
  h = startInProcessHost()
  const hello = await h.client.waitForHello()
  setActiveAgentHost({
    client: h.client,
    hello: { ...hello, home: agentHome },
    config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
  })
  const request = h.client.request.bind(h.client)
  vi.spyOn(h.client, 'request').mockImplementation((req) => {
    ops.push(req.op)
    return request(req)
  })
  const spawn = h.client.spawn.bind(h.client)
  vi.spyOn(h.client, 'spawn').mockImplementation((opts) => {
    spawned.push(opts.command)
    return spawn(opts)
  })
}

/**
 * Ask to run `argv` and give it a moment. A refusal comes back at once; a
 * command that got as far as a card is still waiting, and is stopped.
 */
async function ask(argv: string[]): Promise<{ output: string; isError: boolean } | 'asked'> {
  const tool = buildExecTool({ db, agentId: 'boo-1', cwd: work, enabled: true })[0]
  if (!tool) throw new Error('no run_command tool')
  const ac = new AbortController()
  const run = tool.run({ argv }, { signal: ac.signal })
  const out = await Promise.race([run, sleep(1_500).then(() => 'asked' as const)])
  ac.abort()
  await run
  return out
}

/** A named pipe: an open for reading without O_NONBLOCK waits for a writer. */
function fifo(file: string): string {
  execFileSync('mkfifo', ['-m', '755', file])
  return file
}

/** `inspectResolvedProgram`, or 'hung' when its open did not come back. */
async function inspectOrHang(file: string) {
  const out = await Promise.race([inspectResolvedProgram(file), sleep(2_000).then(() => 'hung')])
  // Release an open still waiting, so no thread stays blocked after the test.
  if (out === 'hung') fs.closeSync(fs.openSync(file, 'w'))
  return out
}

describe.runIf(posix)('a named pipe at the program path', () => {
  it('never holds the open, with agent isolation off', async () => {
    const out = await inspectOrHang(fifo(path.join(bin, 'tool')))
    expect(out).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('never holds the open, with agent isolation on', async () => {
    await agentMode()
    const out = await inspectOrHang(fifo(path.join(bin, 'tool')))
    expect(out).toMatchObject({ ok: false })
  })
})

describe.runIf(posix)('run_command with agents on their own user', () => {
  it('refuses a program in the work folder by name, without looking at it', async () => {
    await agentMode()
    const program = executable(path.join(work, 'teams', 't1', 'tool'))
    const out = await ask([program])
    expect(out).toMatchObject({ isError: true, output: expect.stringMatching(/own folders/) })
    expect(listPendingApprovals(db)).toEqual([])
    expect(ops).not.toContain('canExec')
  })

  it("refuses a program in the agent user's home", async () => {
    await agentMode()
    const out = await ask([executable(path.join(agentHome, 'bin', 'tool'))])
    expect(out).toMatchObject({ isError: true, output: expect.stringMatching(/own folders/) })
    expect(listPendingApprovals(db)).toEqual([])
  })

  it.runIf(notRoot)('refuses a program owned by another user', async () => {
    await agentMode()
    serverRunsAsSomeoneElse()
    const program = executable(path.join(bin, 'mytool'))
    const out = await ask([program])
    expect(out).toMatchObject({ isError: true, output: expect.stringMatching(/another user/) })
    expect(listPendingApprovals(db)).toEqual([])
    expect(ops).toContain('canExec')
  })

  it.each([
    ['its group', 0o775],
    ['others', 0o757],
  ])('refuses a program %s may change', async (_who, mode) => {
    await agentMode()
    const program = executable(path.join(bin, 'mytool'))
    fs.chmodSync(program, mode)
    const out = await ask([program])
    expect(out).toMatchObject({ isError: true, output: expect.stringMatching(/may change it/) })
    expect(listPendingApprovals(db)).toEqual([])
  })

  it("puts a program the server's own user installed in front of a person", async () => {
    // The one-person Mac: Homebrew's programs belong to the person, who is the
    // user Clawboo runs as.
    await agentMode()
    expect(await ask([executable(path.join(bin, 'mytool'))])).toBe('asked')
  })

  it('asks the agent host first, then a person, and runs through the host', async () => {
    await agentMode()
    const tool = buildExecTool({ db, agentId: 'boo-1', cwd: work, enabled: true })[0]
    const run = tool?.run({ argv: ['/bin/echo', 'hi'] }, { signal: new AbortController().signal })
    let card: string | undefined
    for (let i = 0; i < 200 && !card; i++) {
      card = listPendingApprovals(db)[0]?.id
      if (!card) await sleep(25)
    }
    expect(ops).toContain('canExec')
    resolveApproval(db, card ?? '', 'allow_once')
    const out = await run
    expect(out).toMatchObject({ isError: false, output: expect.stringContaining('hi') })
    expect(spawned).toEqual([fs.realpathSync('/bin/echo')])
  })
})

describe.runIf(posix)('the program checks with agents on their own user', () => {
  it('a bare name skips a copy others may change earlier in PATH', async () => {
    await agentMode()
    fs.chmodSync(executable(path.join(bin, 'echo')), 0o777)
    expect(await resolveAgentProgram('echo', `${bin}:/bin`)).toEqual({
      ok: true,
      resolved: fs.realpathSync('/bin/echo'),
    })
  })

  it('the open takes no link at the path', async () => {
    await agentMode()
    const link = path.join(bin, 'lnk')
    fs.symlinkSync('/bin/echo', link)
    expect(await inspectResolvedProgram(link)).toMatchObject({ ok: false, code: 'not-found' })
  })

  it.runIf(notRoot)('the open refuses a file owned by another user', async () => {
    await agentMode()
    serverRunsAsSomeoneElse()
    const program = executable(path.join(bin, 'mytool'))
    expect(await inspectResolvedProgram(program)).toMatchObject({
      ok: false,
      code: 'not-trusted-owner',
    })
  })

  it('the open refuses a file its group may change', async () => {
    await agentMode()
    const program = executable(path.join(bin, 'mytool'))
    fs.chmodSync(program, 0o775)
    expect(await inspectResolvedProgram(program)).toMatchObject({
      ok: false,
      code: 'not-trusted-owner',
    })
  })

  it("the open accepts a file the server's own user owns", async () => {
    await agentMode()
    const program = executable(path.join(bin, 'mytool'))
    expect(await inspectResolvedProgram(program)).toMatchObject({ ok: true, resolved: program })
  })

  it('a path in agent space is refused before the open', async () => {
    await agentMode()
    const program = path.join(work, 'teams', 't1', 'missing')
    expect(await inspectResolvedProgram(program)).toMatchObject({ ok: false, code: 'agent-space' })
  })
})
