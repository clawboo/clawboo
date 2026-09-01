// The size ceiling, driven through a real MCP client against a real server.
//
// The unit tests cover the view and the store. What only an end-to-end test can
// show is that the ceiling fires at the seam every runtime crosses, that the
// handle it mints is redeemable in the same session, and that the tool which
// recovers a truncated result is never itself truncated.

import { createDb, type ClawbooDb, type ToolDescriptor } from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createToolsServer } from '../tools/server'
import { callText, connectInMemory, listToolNames } from '../testing'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

/** A connector tool that returns however many bytes the caller asks for. */
const bigTool = (bytes: number): { descriptor: ToolDescriptor; connectorId: string } => ({
  connectorId: 'conn:connector:clawboo-native:mcp:test',
  descriptor: {
    name: 'big_result',
    description: 'Returns a large payload.',
    inputSchema: z.object({}),
    jsonSchema: { type: 'object', properties: {} },
    risk: 'safe',
    readOnly: true,
    executor: () => 'B'.repeat(bytes),
  } as unknown as ToolDescriptor,
})

const handleIn = (text: string): string | undefined => /handle (tr_[0-9a-f]+)/.exec(text)?.[1]

describe('tool result ceiling, end to end', () => {
  it('serves read_tool_result on every session', async () => {
    // It has to be present BEFORE a result is truncated, or the notice names a
    // tool the model cannot call.
    const client = await connectInMemory(createToolsServer(db))
    expect(await listToolNames(client)).toContain('read_tool_result')
  })

  it('leaves a result under the budget completely untouched', async () => {
    const client = await connectInMemory(createToolsServer(db, { toolResultBudgetBytes: 4000 }))
    const r = await callText(client, 'echo', { message: 'hello' })
    expect(r.text).toBe('hello')
    expect(r.text).not.toContain('clawboo:')
  })

  it('tells the model an unknown handle is gone, not empty', async () => {
    // Reporting "nothing there" about bytes that expired is how a model concludes
    // the mailbox was empty when it was merely unreachable.
    const client = await connectInMemory(createToolsServer(db))
    const r = await callText(client, 'read_tool_result', { handle: 'tr_0000000000000000' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('may have expired')
  })

  it('bounds an oversized result and hands back a redeemable handle', async () => {
    const server = createToolsServer(db, {
      toolResultBudgetBytes: 2000,
      connectorTools: [bigTool(60000)],
    })
    const client = await connectInMemory(server)

    const r = await callText(client, 'big_result', {})
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(2000)
    expect(r.text).toContain('60000 bytes total')

    // The handle in the notice must actually work, in this same session.
    const handle = handleIn(r.text)
    expect(handle).toBeDefined()
    const page = await callText(client, 'read_tool_result', { handle, offset: 0, limit: 1000 })
    expect(page.isError).toBe(false)
    expect(page.text).toContain('B'.repeat(100))
  })

  it('pages to the end of a stored result', async () => {
    const server = createToolsServer(db, {
      toolResultBudgetBytes: 2000,
      connectorTools: [bigTool(9000)],
    })
    const client = await connectInMemory(server)
    const handle = handleIn((await callText(client, 'big_result', {})).text)

    // Driven the way a model would drive it: follow the offset the previous page
    // reported until the result says it has ended. A page is clamped to the
    // context budget however large a limit is asked for, so this also proves the
    // cursor terminates rather than looping on a clamp.
    let offset = 0
    let pages = 0
    let ended = false
    while (pages < 20) {
      const page = await callText(client, 'read_tool_result', { handle, offset, limit: 5000 })
      pages++
      if (page.text.includes('This is the end of the result.')) {
        ended = true
        break
      }
      const next = /"offset":(\d+)/.exec(page.text)?.[1]
      expect(next).toBeDefined()
      const parsed = Number(next)
      // Every page must advance, or a model following the cursor spins forever.
      expect(parsed).toBeGreaterThan(offset)
      offset = parsed
    }
    expect(ended).toBe(true)
  })

  it('never truncates its own recovery path', async () => {
    // A page that came back trimmed would need a second handle to recover, and
    // that one a third.
    const server = createToolsServer(db, {
      toolResultBudgetBytes: 500,
      connectorTools: [bigTool(40000)],
    })
    const client = await connectInMemory(server)
    const handle = handleIn((await callText(client, 'big_result', {})).text)
    const page = await callText(client, 'read_tool_result', { handle, offset: 0, limit: 20000 })
    expect(page.text).not.toContain('You are reading the beginning and the end only')
  })
})
