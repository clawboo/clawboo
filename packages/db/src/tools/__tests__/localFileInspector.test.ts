// The broker refuses a call whose `url` argument would open a file on this
// computer.
//
// A browser connector opens whatever URL it is handed, and reading a file is
// not a network request, so the dashboard block cannot see it. Checked against
// the pinned connectors driving Chrome 156: chrome-devtools-mcp 1.7.0 opened
// file: URLs and put the file's text in its snapshot, and playwright-mcp 0.0.79
// refuses file: but opened view-source:file:, which shows the file just the
// same. URLs are read the way a URL parser reads them, and Windows paths the way
// Chrome on Windows reads them.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createDb, type ClawbooDb } from '../../db'
import { upsertGrant } from '../../grants/repository'
import { defaultAvailabilityContext } from '../availability'
import { executeBrokeredCall } from '../broker'
import { runInspectors } from '../inspectors'
import { ToolRegistry } from '../registry'
import type { ToolCallContext, ToolDescriptor } from '../types'

const ctx = { availability: defaultAvailabilityContext({ env: {} }) } as ToolCallContext

const navigate: ToolDescriptor = {
  name: 'mcp__chrome_devtools__navigate_page',
  description: 'navigate',
  inputSchema: z.object({}).passthrough(),
  owner: 'mcp',
  risk: 'external',
  executor: () => 'ok',
}

const outcome = (args: Record<string, unknown>) =>
  runInspectors({ name: navigate.name, args }, navigate, ctx)

const refused = async (args: Record<string, unknown>): Promise<boolean> => {
  const out = await outcome(args)
  return out.decision === 'deny' && out.reason.startsWith('local-file:')
}

describe('a url argument that opens a local file', () => {
  it.each([
    'file:///Users/me/.clawboo/access-token',
    'FILE:///etc/passwd',
    'file:/etc/passwd',
    'file:etc/passwd',
    'file://localhost/etc/passwd',
    'file:///C:/Users/me/.clawboo/access-token',
    // view-source: shows the file it wraps, and any page's source is in the
    // snapshot already, so every view-source: address is refused.
    'view-source:file:///etc/passwd',
    'VIEW-SOURCE:https://example.com/',
  ])('refuses %j', async (url) => {
    expect(await refused({ url })).toBe(true)
  })

  // A URL parser skips leading spaces and control characters and drops every
  // tab and line break, so each of these is a file URL to the browser.
  it.each([
    ['a leading space', ' file:///etc/passwd'],
    ['a leading control character', '\u0001file:///etc/passwd'],
    ['a tab inside the scheme', 'fi\tle:///etc/passwd'],
    ['a line break inside the scheme', 'view-\nsource:file:///etc/passwd'],
  ])('refuses one with %s', async (_label, url) => {
    expect(await refused({ url })).toBe(true)
  })

  // Chrome on Windows turns a drive letter or two leading slashes into a file
  // URL before it navigates, which neither connector checks for.
  it.each([
    'C:\\Users\\me\\.clawboo\\access-token',
    'c:/Users/me/.clawboo/access-token',
    'C|/Users/me',
    'C:',
    '\\\\server\\share\\notes.txt',
    '//server/share/notes.txt',
    '\\/server/share',
  ])('refuses the Windows path %j', async (url) => {
    expect(await refused({ url })).toBe(true)
  })

  it('looks at a url in nested arguments, whatever its letter case', async () => {
    expect(await refused({ action: 'new', tabs: [{ url: 'file:///etc/passwd' }] })).toBe(true)
    expect(await refused({ URL: 'file:///etc/passwd' })).toBe(true)
  })

  it.each([
    'https://example.com/',
    'http://127.0.0.1:3000/',
    'about:blank',
    'localhost:3000',
    'example.com/file:///etc/passwd',
    'https://example.com/?next=file:///etc/passwd',
  ])('lets %j through', async (url) => {
    // Not denied by any inspector. The chain still asks first for an external
    // tool, so `require_approval` is the expected outcome, not `allow`.
    expect((await outcome({ url })).decision).not.toBe('deny')
  })

  it('reads only url arguments, so text typed into a page may say anything', async () => {
    for (const args of [
      { text: 'file:///etc/passwd' },
      { text: 'C:\\temp\\out.txt' },
      { value: '// a comment typed into an editor' },
      { type: 'url' },
    ]) {
      expect((await outcome(args)).decision, JSON.stringify(args)).not.toBe('deny')
    }
  })
})

describe('a granted browser tool cannot open a local file', () => {
  let dir: string
  let db: ClawbooDb
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-local-file-inspector-'))
    db = createDb(path.join(dir, 'test.db'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is refused before it runs, whatever the grant allows', async () => {
    const CONNECTOR = 'conn:connector:clawboo:mcp:playwright'
    upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
      mode: 'admin',
      approvalPolicy: 'never',
    })
    let ran = false
    const tool: ToolDescriptor = {
      ...navigate,
      name: 'mcp__playwright__browser_navigate',
      executor: () => {
        ran = true
        return 'ok'
      },
    }
    const registry = new ToolRegistry()
    registry.register(tool)

    const res = await executeBrokeredCall(
      db,
      { name: tool.name, args: { url: 'view-source:file:///Users/me/.clawboo/access-token' } },
      { ...ctx, agentId: 'a1', connectorId: CONNECTOR },
      { registry },
    )
    expect(res.ok).toBe(false)
    expect(res.denied).toBe('local-file:agents may not open files on this computer')
    expect(ran).toBe(false)
  })
})
