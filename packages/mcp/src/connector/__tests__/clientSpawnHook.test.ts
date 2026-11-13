// The stdio connector over a process the CALLER started (the `spawn` hook).
//
// A caller that starts connectors as another OS user cannot let the SDK spawn
// them, and cannot signal them by pid either. These run a real MCP server
// through the hook, both as a plain child and behind a stand-in for a process
// started elsewhere (no pid until it reports 'spawn', no ChildProcess class),
// and check that the connection is the same one the SDK path gives.

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ConnectorHandshakeError,
  connectStdioConnector,
  type ChildProcessLike,
  type ConnectorProcessSpawn,
} from '../client'

function serverSource(sdk: (s: string) => string): string {
  return `
const { Server } = require(${JSON.stringify(sdk('server/index.js'))})
const { StdioServerTransport } = require(${JSON.stringify(sdk('server/stdio.js'))})
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdk('types.js'))})
const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
const SCHEMA = { type: 'object', properties: {} }
server.setRequestHandler(ListToolsRequestSchema, (req) => {
  if (!req.params || !req.params.cursor) {
    return { tools: [{ name: 'first', description: 'page one', inputSchema: SCHEMA }], nextCursor: 'p2' }
  }
  return {
    tools: [
      { name: 'where', description: 'its cwd', inputSchema: SCHEMA },
      { name: 'env', description: 'its env', inputSchema: SCHEMA },
      { name: 'die', description: 'exits', inputSchema: SCHEMA },
    ],
  }
})
server.setRequestHandler(CallToolRequestSchema, (req) => {
  const n = req.params.name
  if (n === 'where') return { content: [{ type: 'text', text: process.cwd() }] }
  if (n === 'env') return { content: [{ type: 'text', text: JSON.stringify(process.env) }] }
  if (n === 'die') setTimeout(() => process.exit(0), 10)
  return { content: [{ type: 'text', text: 'ok:' + n }] }
})
server.connect(new StdioServerTransport())
`
}

/**
 * A process started somewhere else, as the caller sees it: an emitter with
 * the three streams, a `kill` that asks for a signal, and a pid that only
 * exists once it reports 'spawn'. Not a ChildProcess, so nothing in the
 * transport may lean on ChildProcess-only members.
 */
class ElsewhereProcess extends EventEmitter {
  pid: number | undefined = undefined
  readonly stdin: NodeJS.WritableStream | null
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  readonly signals: string[] = []

  constructor(private readonly child: ChildProcess) {
    super()
    this.stdin = child.stdin
    this.stdout = child.stdout
    this.stderr = child.stderr
    child.on('spawn', () => {
      setTimeout(() => {
        this.pid = child.pid
        this.emit('spawn')
      }, 30)
    })
    child.on('error', (err) => this.emit('error', err))
    child.on('exit', (code, signal) => this.emit('exit', code, signal))
    child.on('close', (code, signal) => this.emit('close', code, signal))
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.signals.push(String(signal))
    return this.child.kill(signal)
  }
}

const startLocal = (
  command: string,
  args: string[],
  opts: { cwd?: string; env: Record<string, string> },
) =>
  spawn(command, args, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

function closed(p: ChildProcessLike): Promise<void> {
  return new Promise((resolve) => {
    p.once('close', () => resolve())
  })
}

describe('connectStdioConnector with a spawn hook', () => {
  let dir: string
  let server: string
  let failing: string

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clawboo-connector-hook-')))
    server = path.join(dir, 'server.cjs')
    failing = path.join(dir, 'failing.cjs')
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    writeFileSync(
      server,
      serverSource((s) => req.resolve(`@modelcontextprotocol/sdk/${s}`)),
    )
    writeFileSync(
      failing,
      `process.stderr.write('bad config: no profile folder\\n'); process.exit(3)\n`,
    )
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts the server through the hook and speaks MCP over the process it returned', async () => {
    const calls: { command: string; args: string[]; cwd?: string; env: Record<string, string> }[] =
      []
    let started: ElsewhereProcess | null = null
    const hook: ConnectorProcessSpawn = (command, args, opts) => {
      calls.push({ command, args, ...opts })
      started = new ElsewhereProcess(startLocal(command, args, opts))
      return started
    }
    const spawnedPids: number[] = []
    const session = await connectStdioConnector({
      command: process.execPath,
      args: [server],
      cwd: dir,
      env: { CONNECTOR_SETTING: 'on' },
      spawn: hook,
      onSpawn: (pid) => spawnedPids.push(pid),
      handshakeTimeoutMs: 20_000,
    })
    try {
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ command: process.execPath, args: [server], cwd: dir })
      // Composed as the SDK composes it: its defaults under the spec's own.
      expect(calls[0]!.env['CONNECTOR_SETTING']).toBe('on')
      expect(calls[0]!.env['PATH']).toBe(process.env['PATH'])

      // The pid is the hook process's, reported once it exists.
      expect(session.pid).toBe(started!.pid)
      expect(spawnedPids).toEqual([started!.pid])

      // Paged, called and flattened by the same session code as the SDK path.
      expect((await session.listTools()).map((t) => t.name)).toEqual([
        'first',
        'where',
        'env',
        'die',
      ])
      expect(await session.callTool('first', {})).toEqual({ text: 'ok:first', isError: false })
      expect((await session.callTool('where', {})).text).toBe(dir)
      const env = JSON.parse((await session.callTool('env', {})).text) as Record<string, string>
      expect(env['CONNECTOR_SETTING']).toBe('on')
    } finally {
      const done = started ? closed(started) : Promise.resolve()
      await session.close()
      await done
    }
    // Ending stdin was enough for a well-behaved server: no signal was needed.
    expect(started!.signals).toEqual([])
    expect(session.pid).toBeNull()
  }, 30_000)

  it('reports a server that exits on its own through onClose', async () => {
    let child: ChildProcess | null = null
    const session = await connectStdioConnector({
      command: process.execPath,
      args: [server],
      env: {},
      spawn: (command, args, opts) => {
        child = startLocal(command, args, opts)
        return child
      },
      handshakeTimeoutMs: 20_000,
    })
    const closedOnce = new Promise<void>((resolve) => session.onClose(resolve))
    await session.callTool('die', {})
    await closedOnce
    expect(child!.exitCode).toBe(0)
    await session.close()
  }, 30_000)

  it('fails the connect, with the server’s last words, when the process dies before the handshake', async () => {
    let child: ChildProcess | null = null
    const err = await connectStdioConnector({
      command: process.execPath,
      args: [failing],
      env: {},
      spawn: (command, args, opts) => {
        child = startLocal(command, args, opts)
        return child
      },
      handshakeTimeoutMs: 20_000,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConnectorHandshakeError)
    expect((err as Error).message).toContain('bad config: no profile folder')
    expect(child).not.toBeNull()
  }, 30_000)

  it('turns a hook that throws into a handshake failure with no pid', async () => {
    const err = await connectStdioConnector({
      command: process.execPath,
      args: [server],
      env: {},
      spawn: () => {
        throw new Error('the agent host is not running')
      },
      handshakeTimeoutMs: 5_000,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConnectorHandshakeError)
    expect((err as ConnectorHandshakeError).pid).toBeNull()
    expect((err as Error).message).toContain('the agent host is not running')
  })
})
