// Every real agent spawn path, run in the container with the real code: the
// spawn driver (Codex `exec`, Hermes), the Claude Code CLI hook, Native's
// approved command and file tools, the verify gate, and an MCP stdio
// connector with local reach. Each must run as the agent user and fail to
// read the database, the key and the vault.

import fs from 'node:fs'
import path from 'node:path'

import { connectStdioConnector } from '../../packages/mcp/src/index'

import { agentReadFile } from '../../apps/web/server/lib/agentUser/agentFs'
import { buildChildEnv } from '../../apps/web/server/lib/runtimes/childEnv'
import { spawnTrackedClaudeProcess } from '../../apps/web/server/lib/runtimes/claudeCodeDriver'
import { runApprovedCommand } from '../../apps/web/server/lib/runtimes/native/execRun'
import { buildFileTools } from '../../apps/web/server/lib/runtimes/native/fileTools'
import { spawnAgentProcess } from '../../apps/web/server/lib/runtimes/spawner'
import { createSpawnDriver } from '../../apps/web/server/lib/runtimes/subprocess'
import { runDeterministicGate } from '../../apps/web/server/lib/verification/deterministicGate'

export interface ProofContext {
  check: (name: string, ok: boolean, detail: unknown) => void
  probeEnv: Record<string, string>
  team: string
  fake: string
  agentUid: number
}

function verdict(ctx: ProofContext, name: string, raw: string): void {
  let seen: Record<string, unknown> | null = null
  try {
    seen = JSON.parse(raw.trim().split('\n').pop() ?? '') as Record<string, unknown>
  } catch {
    /* reported below */
  }
  ctx.check(
    `${name}: runs as the agent user and cannot read the database, the key or the vault`,
    seen?.['uid'] === ctx.agentUid &&
      seen?.['db'] === 'EACCES' &&
      seen?.['key'] === 'EACCES' &&
      seen?.['vault'] === 'EACCES',
    raw,
  )
}

export async function extraProofs(ctx: ProofContext): Promise<void> {
  // The spawn driver: what Codex `exec` and Hermes run through.
  {
    const lines: string[] = []
    const driver = createSpawnDriver<string>({
      resolve: async () => ({ command: ctx.fake, args: [], cwd: ctx.team, env: ctx.probeEnv }),
      parseLine: (line) => [line],
      onClose: () => ['<closed>'],
    } as never)
    await new Promise<void>((resolve) => {
      driver.onEvent((ev) => {
        if (ev === '<closed>') resolve()
        else lines.push(ev)
      })
      void driver.start()
    })
    verdict(ctx, 'the spawn driver (Codex exec, Hermes)', lines.join('\n'))
  }

  // The Claude Code CLI, through the Agent SDK's spawn hook.
  {
    const child = spawnTrackedClaudeProcess(
      { command: ctx.fake, args: [], cwd: ctx.team, env: buildChildEnv(ctx.probeEnv) },
      () => undefined,
    )
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stdin?.end()
    await new Promise((r) => child.once('close', r))
    verdict(ctx, 'the Claude Code CLI hook', out)
  }

  // Clawboo Native: an approved command, and the file tools.
  {
    const res = await runApprovedCommand({
      argv: [ctx.fake],
      cwd: ctx.team,
      signal: new AbortController().signal,
      env: buildChildEnv(ctx.probeEnv) as Record<string, string>,
    })
    verdict(ctx, "Native's approved command", res.output)

    const tools = buildFileTools(ctx.team)
    const write = tools.find((t) => t.name === 'write_file')!
    const read = tools.find((t) => t.name === 'read_file')!
    const wrote = await write.run({ path: 'note.txt', content: 'from native' })
    const back = await read.run({ path: 'note.txt' })
    ctx.check(
      "Native's file tools work in the agent's folder",
      !wrote.isError && back.output.includes('from native'),
      {
        wrote,
        back,
      },
    )
    let ownedByServer = true
    try {
      fs.statSync(path.join(ctx.team, 'note.txt'))
    } catch {
      ownedByServer = false
    }
    ctx.check(
      "the server cannot see the file Native's tools wrote (it is the agent's)",
      !ownedByServer,
      null,
    )
    const escape = await read.run({
      path: '../../../../../home/clawboo/.clawboo/secrets/master.key',
    })
    ctx.check("Native's file tools refuse a path out of the folder", escape.isError, escape)
  }

  // The verify gate's command.
  {
    const result = await runDeterministicGate({
      worktreePath: ctx.team,
      verifyCommand: `${ctx.fake} > gate.json`,
      evidence: false,
      env: buildChildEnv(ctx.probeEnv) as Record<string, string>,
    } as never)
    const out = (await agentReadFile(path.join(ctx.team, 'gate.json')))?.toString() ?? ''
    verdict(ctx, "the verify gate's command", out || JSON.stringify(result))
  }

  // An MCP stdio connector with local reach, through the seam.
  {
    const session = await connectStdioConnector({
      command: process.execPath,
      args: [process.env['PROOF_FAKE_MCP'] ?? '/proof/fake-mcp.mjs'],
      env: { ...ctx.probeEnv, PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      spawn: (command, args, opts) =>
        spawnAgentProcess({
          kind: 'connector',
          command,
          args,
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          env: opts.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
    } as never)
    const res = (await session.callTool('whoami', {})) as unknown
    await session.close()
    const text = JSON.stringify(res)
    const inner =
      /\{\\"uid\\":(\d+),\\"db\\":\\"(\w+)\\",\\"key\\":\\"(\w+)\\",\\"vault\\":\\"(\w+)\\"/.exec(
        text,
      )
    ctx.check(
      'a connector with local reach: runs as the agent user and cannot read the database, the key or the vault',
      !!inner &&
        Number(inner[1]) === ctx.agentUid &&
        inner[2] === 'EACCES' &&
        inner[3] === 'EACCES' &&
        inner[4] === 'EACCES',
      text,
    )
  }
}
