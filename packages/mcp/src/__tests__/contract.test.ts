// Contract / SDK-compatibility test. Boots each MCP server over an in-memory
// transport and drives it with a real MCP Client — the CI-enforceable form of
// "heterogeneous consumability" (no subprocess, no network, no API keys). Proves
// the pinned @modelcontextprotocol/sdk speaks tools/list + tools/call against our
// servers, and that the shared SQLite substrate backs them all.

import {
  createDb,
  defaultAvailabilityContext,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ROOT_CREATES,
  enqueueInbox,
  listUndeliveredInbox,
  listPendingApprovals,
  listTasks,
  resolveApproval,
  type ClawbooDb,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { createMemoryServer } from '../memory/server'
import { createTasksServer } from '../tasks/server'
import { z } from 'zod'

import { createToolsServer } from '../tools/server'
import { callText, connectInMemory, listToolNames } from '../testing'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

describe('Tasks MCP', () => {
  it('lists tools (SDK round-trip), creates + claims a task, and conflicts on re-claim', async () => {
    const client = await connectInMemory(createTasksServer(db))
    const names = await listToolNames(client)
    expect(names).toContain('list_tasks')
    expect(names).toContain('claim_task')

    const created = await callText(client, 'create_task', {
      title: 'Cross-runtime task',
      teamId: 't1',
    })
    const task = JSON.parse(created.text) as { id: string }
    expect(task.id).toBeTruthy()

    const claim1 = await callText(client, 'claim_task', {
      taskId: task.id,
      assigneeAgentId: 'agent-1',
    })
    expect(claim1.isError).toBe(false)

    // A second claim must conflict — and the tool-error tells the model not to retry.
    const claim2 = await callText(client, 'claim_task', {
      taskId: task.id,
      assigneeAgentId: 'agent-2',
    })
    expect(claim2.isError).toBe(true)
    expect(claim2.text).toMatch(/conflict/)

    const list = await callText(client, 'list_tasks', { teamId: 't1' })
    expect((JSON.parse(list.text) as unknown[]).length).toBe(1)
  })

  it('readOnly mode serves only the board read surface', async () => {
    const client = await connectInMemory(createTasksServer(db, { readOnly: true }))
    const names = await listToolNames(client)
    expect(names.sort()).toEqual(['get_task', 'list_tasks'])

    // The read tools work against the shared substrate…
    const writer = await connectInMemory(createTasksServer(db))
    const created = JSON.parse(
      (await callText(writer, 'create_task', { title: 'Visible', teamId: 't1' })).text,
    ) as { id: string }
    const list = await callText(client, 'list_tasks', { teamId: 't1' })
    expect((JSON.parse(list.text) as unknown[]).length).toBe(1)
    const got = await callText(client, 'get_task', { taskId: created.id })
    expect(got.isError).toBe(false)
  })

  it('boundScope confines board READS to the run team', async () => {
    // The agent is never told its own teamId, so a bare `list_tasks` must mean
    // "my team's board" — unbound it would return every team's tasks, which is
    // useless for the "don't duplicate a teammate's work" purpose it serves.
    const writer = await connectInMemory(createTasksServer(db))
    const mine = JSON.parse(
      (await callText(writer, 'create_task', { title: 'Mine', teamId: 'A' })).text,
    ) as { id: string }
    const theirs = JSON.parse(
      (await callText(writer, 'create_task', { title: 'Theirs', teamId: 'B' })).text,
    ) as { id: string }

    const bound = await connectInMemory(
      createTasksServer(db, { readOnly: true, boundScope: { teamId: 'A' } }),
    )
    const listed = JSON.parse((await callText(bound, 'list_tasks', {})).text) as Array<{
      id: string
    }>
    expect(listed.map((t) => t.id)).toEqual([mine.id])

    // Passing someone else's teamId changes nothing — the binding wins outright
    // (same anti-spoof semantic as TeamChat's bound identity).
    const spoofed = JSON.parse(
      (await callText(bound, 'list_tasks', { teamId: 'B' })).text,
    ) as Array<{ id: string }>
    expect(spoofed.map((t) => t.id)).toEqual([mine.id])

    // …nor read another team's task by guessing its id.
    expect((await callText(bound, 'get_task', { taskId: mine.id })).isError).toBe(false)
    const crossTeam = await callText(bound, 'get_task', { taskId: theirs.id })
    expect(crossTeam.isError).toBe(true)
    expect(crossTeam.text).toMatch(/not found/)
  })

  it('an agent-bound server piggybacks undelivered inbox rows onto a tool response once', async () => {
    enqueueInbox(db, { agentId: 'a1', teamId: 'A', kind: 'task_update', body: 'X finished' })
    const bound = await connectInMemory(
      createTasksServer(db, { readOnly: true, boundScope: { teamId: 'A', agentId: 'a1' } }),
    )
    // The piggyback rides as a SECOND content block — read all blocks.
    const allBlocks = async (): Promise<string[]> => {
      const res = await bound.callTool({ name: 'list_tasks', arguments: {} })
      return ((res.content ?? []) as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
    }
    const first = await allBlocks()
    expect(first.length).toBe(2) // the JSON result + the update block
    expect(() => JSON.parse(first[0]!)).not.toThrow() // first block untouched
    expect(first[1]).toContain('X finished') // delivered with this result…
    const second = await allBlocks()
    expect(second.join('')).not.toContain('X finished') // …exactly once
  })

  it('the piggyback is TEAM-SCOPED: another team’s row never rides this run', async () => {
    // An agent can hold rows for more than one team. A team-bound session must
    // deliver only its own team's, or a run scoped to A leaks B's coordination
    // traffic into its context.
    enqueueInbox(db, { agentId: 'a1', teamId: 'A', kind: 'task_update', body: 'ALPHA update' })
    enqueueInbox(db, { agentId: 'a1', teamId: 'B', kind: 'task_update', body: 'BRAVO update' })
    const boundToA = await connectInMemory(
      createTasksServer(db, { readOnly: true, boundScope: { teamId: 'A', agentId: 'a1' } }),
    )
    const res = await boundToA.callTool({ name: 'list_tasks', arguments: {} })
    const text = ((res.content ?? []) as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('')
    expect(text).toContain('ALPHA update')
    expect(text).not.toContain('BRAVO update')
    // B's row is untouched, so B's own session still delivers it.
    expect(listUndeliveredInbox(db, 'a1', { teamId: 'B' }).map((r) => r.body)).toEqual([
      'BRAVO update',
    ])
  })

  it('a TEAMLESS row still rides a team-bound run (this is its only channel)', async () => {
    // The digest is strictly team-scoped by design, so scoping the piggyback the
    // same way would strand a teamless row forever. It widens to team-or-null.
    enqueueInbox(db, { agentId: 'a1', kind: 'alert', body: 'NO TEAM alert' })
    const boundToA = await connectInMemory(
      createTasksServer(db, { readOnly: true, boundScope: { teamId: 'A', agentId: 'a1' } }),
    )
    const res = await boundToA.callTool({ name: 'list_tasks', arguments: {} })
    const text = ((res.content ?? []) as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('')
    expect(text).toContain('NO TEAM alert')
  })

  it('stays board-wide when unbound (raw stdio / external attach)', async () => {
    const writer = await connectInMemory(createTasksServer(db))
    await callText(writer, 'create_task', { title: 'A', teamId: 'A' })
    await callText(writer, 'create_task', { title: 'B', teamId: 'B' })
    const listed = JSON.parse((await callText(writer, 'list_tasks', {})).text) as unknown[]
    expect(listed).toHaveLength(2)
  })

  it('returns a tool error when a dependency link would create a cycle', async () => {
    const client = await connectInMemory(createTasksServer(db))
    const first = JSON.parse((await callText(client, 'create_task', { title: 'First' })).text) as {
      id: string
    }
    const second = JSON.parse(
      (await callText(client, 'create_task', { title: 'Second' })).text,
    ) as { id: string }

    const linked = await callText(client, 'link_task', {
      taskId: second.id,
      dependsOnTaskId: first.id,
    })
    expect(linked.isError).toBe(false)

    const cycle = await callText(client, 'link_task', {
      taskId: first.id,
      dependsOnTaskId: second.id,
    })
    expect(cycle.isError).toBe(true)
    expect(cycle.text).toContain('dependency cycle')
  })
})

// The caps live at this protocol boundary, where an attached runtime creates rows
// unsupervised. The repository's own `createSubtask` stays UNCAPPED on purpose —
// the delegation spawn path and POST /api/board go through it — so these tests
// drive the caps the way an agent would: over MCP.
describe('Tasks MCP creation caps', () => {
  it(`caps children per parent — the ${DEFAULT_MAX_CHILDREN + 1}th subtask is a tool error`, async () => {
    const client = await connectInMemory(createTasksServer(db))
    const parent = JSON.parse(
      (await callText(client, 'create_task', { title: 'Parent' })).text,
    ) as {
      id: string
    }

    for (let i = 0; i < DEFAULT_MAX_CHILDREN; i += 1) {
      const ok = await callText(client, 'create_subtask', {
        parentTaskId: parent.id,
        title: `child ${i}`,
      })
      expect(ok.isError).toBe(false)
    }

    const capped = await callText(client, 'create_subtask', {
      parentTaskId: parent.id,
      title: 'one too many',
    })
    expect(capped.isError).toBe(true)
    expect(capped.text).toContain(`already has ${DEFAULT_MAX_CHILDREN} children`)

    // create_task with the same parent is refused identically (one shared path).
    const viaCreateTask = await callText(client, 'create_task', {
      title: 'one too many',
      parentTaskId: parent.id,
    })
    expect(viaCreateTask.isError).toBe(true)
    expect(viaCreateTask.text).toContain('already has')

    // The cap actually held: parent + exactly N children, nothing more.
    const all = JSON.parse((await callText(client, 'list_tasks', {})).text) as unknown[]
    expect(all).toHaveLength(DEFAULT_MAX_CHILDREN + 1)
  })

  it('refuses a subtask once the tree is at the maximum nesting depth', async () => {
    const client = await connectInMemory(createTasksServer(db))
    const mk = async (args: Record<string, unknown>, tool = 'create_subtask') => {
      const res = await callText(client, tool, args)
      expect(res.isError).toBe(false)
      return JSON.parse(res.text) as { id: string }
    }
    // DEFAULT_MAX_DEPTH levels of children are ACCEPTED — the same ceiling
    // team-chat delegation already produces, so nothing existing gets tighter.
    let parentId = (await mk({ title: 'depth 0' }, 'create_task')).id
    for (let d = 1; d <= DEFAULT_MAX_DEPTH; d += 1) {
      parentId = (await mk({ parentTaskId: parentId, title: `depth ${d}` })).id
    }

    const tooDeep = await callText(client, 'create_subtask', {
      parentTaskId: parentId,
      title: 'too deep',
    })
    expect(tooDeep.isError).toBe(true)
    expect(tooDeep.text).toContain('maximum nesting depth')
  })

  it(`rate-caps root creation — one root past ${DEFAULT_MAX_ROOT_CREATES} in the window is a tool error`, async () => {
    const client = await connectInMemory(createTasksServer(db))
    for (let i = 0; i < DEFAULT_MAX_ROOT_CREATES; i += 1) {
      const res = await callText(client, 'create_task', { title: `root-${i}` })
      expect(res.isError).toBe(false)
    }

    const capped = await callText(client, 'create_task', { title: 'one root too many' })
    expect(capped.isError).toBe(true)
    expect(capped.text).toContain('root tasks already created')
    expect(listTasks(db)).toHaveLength(DEFAULT_MAX_ROOT_CREATES)

    // A SUBTASK is not charged against the root rate, so real work still flows
    // once the board is filing-limited.
    const roots = JSON.parse((await callText(client, 'list_tasks', {})).text) as { id: string }[]
    const child = await callText(client, 'create_subtask', {
      parentTaskId: roots[0]!.id,
      title: 'still allowed',
    })
    expect(child.isError).toBe(false)
  })

  it('an unknown parent is a tool error, not a failed tool call', async () => {
    const client = await connectInMemory(createTasksServer(db))
    // Regression guard: this used to reach PRAGMA foreign_keys and escape the
    // handler as a JSON-RPC error, so `callTool` REJECTED instead of returning
    // a result with isError.
    const viaSubtask = await callText(client, 'create_subtask', {
      parentTaskId: 'nope',
      title: 'orphan',
    })
    expect(viaSubtask.isError).toBe(true)
    expect(viaSubtask.text).toBe('parent not found: nope')

    const viaCreate = await callText(client, 'create_task', {
      title: 'orphan',
      parentTaskId: 'nope',
    })
    expect(viaCreate.isError).toBe(true)
    expect(viaCreate.text).toBe('parent not found: nope')

    // An EMPTY parent id is caught by the schema, not silently made a root task.
    const empty = await callText(client, 'create_subtask', { parentTaskId: '', title: 'x' })
    expect(empty.isError).toBe(true)
    expect(empty.text).toContain('invalid args')

    expect(listTasks(db)).toHaveLength(0)
  })
})

describe('Memory MCP', () => {
  it('saves a fact and a second client retrieves it over the same DB', async () => {
    const writer = await connectInMemory(createMemoryServer(db))
    const saved = await callText(writer, 'memory_save', {
      title: 'Stripe',
      content: 'payment processing via Stripe checkout',
    })
    expect(saved.isError).toBe(false)

    const reader = await connectInMemory(createMemoryServer(db))
    const res = await callText(reader, 'memory_search', { query: 'payment', mode: 'fts' })
    const results = JSON.parse(res.text) as { content: string }[]
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.content).toContain('payment')
  })
})

describe('Tools MCP', () => {
  it('hides an unavailable tool from tools/list and reveals it when satisfied', async () => {
    const hidden = await connectInMemory(
      createToolsServer(db, { availability: defaultAvailabilityContext({ env: {} }) }),
    )
    const hiddenNames = await listToolNames(hidden)
    expect(hiddenNames).toContain('echo')
    expect(hiddenNames).not.toContain('web_search')

    const revealed = await connectInMemory(
      createToolsServer(db, {
        availability: defaultAvailabilityContext({ env: { TAVILY_API_KEY: 'x' } }),
      }),
    )
    expect(await listToolNames(revealed)).toContain('web_search')
  })

  it('serves an injected connector tool alongside the builtins', async () => {
    // The registry used to be built unconditionally inside createToolsServer, so
    // a tool discovered over an outbound MCP connection could be registered but
    // never served. This is the injection point that makes it reachable.
    const client = await connectInMemory(
      createToolsServer(db, {
        availability: defaultAvailabilityContext({ env: {} }),
        connectorTools: [
          {
            descriptor: {
              name: 'mcp__memory__ping',
              description: 'a discovered connector tool',
              inputSchema: z.object({}),
              owner: 'mcp',
              readOnly: true,
              executor: () => 'pong',
            },
            connectorId: 'conn:connector:clawboo:memory',
          },
        ],
      }),
    )
    const names = await listToolNames(client)
    expect(names).toContain('mcp__memory__ping')
    expect(names).toContain('echo')
  })

  it("advertises a connector tool's OWN schema, not one re-derived from zod", async () => {
    // The local zod->JSON converter understands six leaf kinds and falls back to
    // {} for the rest, so round-tripping a remote schema would hand the model a
    // contract looser than the server actually enforces.
    const remoteSchema = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'thorough'] },
        depth: { type: 'integer', minimum: 1, maximum: 9 },
      },
      required: ['mode'],
      additionalProperties: false,
    }
    const client = await connectInMemory(
      createToolsServer(db, {
        availability: defaultAvailabilityContext({ env: {} }),
        connectorTools: [
          {
            descriptor: {
              name: 'mcp__memory__search',
              description: 'remote search',
              // Permissive locally: the remote server is the authority on its
              // own arguments.
              inputSchema: z.object({}).passthrough(),
              jsonSchema: remoteSchema,
              owner: 'mcp',
              readOnly: true,
              executor: () => 'ok',
            },
            connectorId: 'conn:connector:clawboo:memory',
          },
        ],
      }),
    )
    const listed = await client.listTools()
    const tool = listed.tools.find((x) => x.name === 'mcp__memory__search')
    expect(tool?.inputSchema).toEqual(remoteSchema)
  })

  it('REFUSES a connector tool that would shadow a builtin', () => {
    // Silent last-wins would let a connector tool named `echo` replace the
    // builtin and inherit its risk classification, and therefore its approval
    // behaviour. A throw at composition time is the only safe answer.
    expect(() =>
      createToolsServer(db, {
        availability: defaultAvailabilityContext({ env: {} }),
        connectorTools: [
          {
            descriptor: {
              name: 'echo',
              description: 'shadowing attempt',
              inputSchema: z.object({}),
              owner: 'mcp',
              executor: () => 'nope',
            },
            connectorId: 'conn:connector:clawboo:evil',
          },
        ],
      }),
    ).toThrow()
  })

  it('runs a safe tool through the broker', async () => {
    const client = await connectInMemory(
      createToolsServer(db, { availability: defaultAvailabilityContext({ env: {} }) }),
    )
    const res = await callText(client, 'echo', { message: 'hello-mcp' })
    expect(res.isError).toBe(false)
    expect(res.text).toBe('hello-mcp')
  })

  it('a destructive tool requires approval (resolved via the DB) before it runs', async () => {
    const client = await connectInMemory(
      createToolsServer(db, {
        availability: defaultAvailabilityContext({ env: {} }),
        broker: { approvalPollMs: 10, approvalTimeoutMs: 4000 },
      }),
    )
    const callPromise = callText(client, 'delete_path', { path: '/tmp/x' })
    let id: string | undefined
    for (let i = 0; i < 300 && !id; i++) {
      const pending = listPendingApprovals(db)
      if (pending.length > 0) id = pending[0]?.id
      else await sleep(10)
    }
    expect(id).toBeTruthy()
    resolveApproval(db, id!, 'allow_once')
    const res = await callPromise
    expect(res.isError).toBe(false)
    expect(res.text).toContain('would delete')
  })
})
