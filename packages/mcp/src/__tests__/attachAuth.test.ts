// The attach-scope signature: the primitive the loopback identity story now
// rests on. Every property here is one a runtime editing its own config would
// need to break.

import { describe, expect, it } from 'vitest'

import {
  signAttachAccess,
  signAttachProvenance,
  signAttachScope,
  verifyAttachAccess,
  verifyAttachProvenance,
  verifyAttachScope,
} from '../attachAuth'
import { buildAttachConfig, MCP_SERVER_NAMES, mcpHttpUrl } from '../config'

const SECRET = 'a'.repeat(64)

describe('signAttachScope / verifyAttachScope', () => {
  it('round-trips the scope it signed', () => {
    const scope = { teamId: 'T', agentId: 'A', delegate: true }
    expect(verifyAttachScope(SECRET, scope, signAttachScope(SECRET, scope))).toBe(true)
  })

  it('any changed field breaks verification — including the delegate PRIVILEGE', () => {
    const scope = { teamId: 'T', agentId: 'A', delegate: false }
    const sig = signAttachScope(SECRET, scope)
    expect(verifyAttachScope(SECRET, { ...scope, agentId: 'victim' }, sig)).toBe(false)
    expect(verifyAttachScope(SECRET, { ...scope, teamId: 'other' }, sig)).toBe(false)
    expect(verifyAttachScope(SECRET, { ...scope, delegate: true }, sig)).toBe(false)
  })

  it('fields cannot BLEED into each other', () => {
    // Without a separator, {teamId:'ab', agentId:'c'} and {teamId:'a', agentId:'bc'}
    // would canonicalise identically and one signature would cover both identities.
    const sig = signAttachScope(SECRET, { teamId: 'ab', agentId: 'c' })
    expect(verifyAttachScope(SECRET, { teamId: 'a', agentId: 'bc' }, sig)).toBe(false)
  })

  it('a different secret verifies nothing', () => {
    const scope = { teamId: 'T', agentId: 'A' }
    expect(verifyAttachScope('b'.repeat(64), scope, signAttachScope(SECRET, scope))).toBe(false)
  })

  it('malformed signatures are false, never a throw', () => {
    const scope = { teamId: 'T' }
    for (const bad of ['', 'zz', 'deadbeef', 'not hex', signAttachScope(SECRET, scope).slice(2)]) {
      expect(verifyAttachScope(SECRET, scope, bad)).toBe(false)
    }
  })

  it('is deterministic, so attach configs stay byte-stable across rewrites', () => {
    // The codex driver's auth-seeding uses mtime freshness on files in the run
    // home; a signature that changed per write would churn every config.
    const scope = { teamId: 'T', agentId: 'A' }
    expect(signAttachScope(SECRET, scope)).toBe(signAttachScope(SECRET, scope))
  })
})

describe('mcpHttpUrl signing', () => {
  it('a signed tasks URL replayed as a teamchat+delegate URL cannot verify', () => {
    // Cross-server replay: lift the sig off the tasks URL, present it with
    // delegate=1 on teamchat. Tasks signs delegate:false by construction, so the
    // replay claims a scope the signature does not cover.
    const url = new URL(
      mcpHttpUrl('http://x', 'tasks', { teamId: 'T', agentId: 'A', attachSecret: SECRET }),
    )
    const sig = url.searchParams.get('scopeSig')!
    expect(sig).toBeTruthy()
    expect(verifyAttachScope(SECRET, { teamId: 'T', agentId: 'A', delegate: true }, sig)).toBe(
      false,
    )
  })

  it('never leaks the secret into the URL', () => {
    const secret = 'f0e1d2c3'.repeat(8)
    for (const server of ['tasks', 'memory', 'teamchat'] as const) {
      const url = mcpHttpUrl('http://x', server, {
        teamId: 'T',
        agentId: 'A',
        attachSecret: secret,
      })
      expect(url).not.toContain(secret)
      expect(url).toContain('scopeSig=')
    }
  })

  it('an unscoped URL carries no signature at all', () => {
    expect(mcpHttpUrl('http://x', 'tools')).not.toContain('scopeSig')
    expect(mcpHttpUrl('http://x', 'tasks')).not.toContain('scopeSig')
  })
})

describe('the team-run claim on the Tasks URL', () => {
  const teamRunScope = { teamId: 'T', agentId: 'A', delegate: true, attachSecret: SECRET }

  it('marks a run the team engine drives, inside the signature', () => {
    const url = new URL(mcpHttpUrl('http://x', 'tasks', teamRunScope))
    expect(url.searchParams.get('teamRun')).toBe('1')
    const sig = url.searchParams.get('scopeSig')!
    expect(verifyAttachScope(SECRET, { teamId: 'T', agentId: 'A', teamRun: true }, sig)).toBe(true)
    // Stripped of the claim, the signature no longer matches what the URL says.
    expect(verifyAttachScope(SECRET, { teamId: 'T', agentId: 'A' }, sig)).toBe(false)
  })

  it('is absent from every other run, whose signature is unchanged', () => {
    const url = new URL(
      mcpHttpUrl('http://x', 'tasks', { teamId: 'T', agentId: 'A', attachSecret: SECRET }),
    )
    expect(url.searchParams.has('teamRun')).toBe(false)
    expect(url.searchParams.get('scopeSig')).toBe(
      signAttachScope(SECRET, { teamId: 'T', agentId: 'A', delegate: false }),
    )
  })

  it('cannot be replayed as the TeamChat delegate signature, nor the reverse', () => {
    const tasksSig = new URL(mcpHttpUrl('http://x', 'tasks', teamRunScope)).searchParams.get(
      'scopeSig',
    )!
    const teamchatSig = new URL(mcpHttpUrl('http://x', 'teamchat', teamRunScope)).searchParams.get(
      'scopeSig',
    )!
    expect(tasksSig).not.toBe(teamchatSig)
    expect(verifyAttachScope(SECRET, { teamId: 'T', agentId: 'A', delegate: true }, tasksSig)).toBe(
      false,
    )
    expect(
      verifyAttachScope(SECRET, { teamId: 'T', agentId: 'A', teamRun: true }, teamchatSig),
    ).toBe(false)
  })

  it('rides the Memory and Tools URLs too, so no URL a team run holds signs a plain scope', () => {
    const plain = signAttachScope(SECRET, { teamId: 'T', agentId: 'A', delegate: false })
    for (const server of ['memory', 'tools'] as const) {
      const url = new URL(mcpHttpUrl('http://x', server, teamRunScope))
      expect(url.searchParams.get('teamRun')).toBe('1')
      expect(url.searchParams.get('scopeSig')).not.toBe(plain)
    }
    // TeamChat carries its own `delegate=1` claim instead.
    expect(
      new URL(mcpHttpUrl('http://x', 'teamchat', teamRunScope)).searchParams.has('teamRun'),
    ).toBe(false)
  })
})

describe("the run's own task on the Tasks URL", () => {
  const onTask = {
    teamId: 'T',
    agentId: 'A',
    delegate: true,
    boundTaskId: 'task-1',
    attachSecret: SECRET,
  }

  it('rides the Tasks URL inside its signature, so it can be neither moved nor stripped', () => {
    const url = new URL(mcpHttpUrl('http://x', 'tasks', onTask))
    expect(url.searchParams.get('scopeTaskId')).toBe('task-1')
    const sig = url.searchParams.get('scopeSig')!
    const claim = { teamId: 'T', agentId: 'A', teamRun: true }
    expect(verifyAttachScope(SECRET, { ...claim, boundTaskId: 'task-1' }, sig)).toBe(true)
    expect(verifyAttachScope(SECRET, { ...claim, boundTaskId: 'task-2' }, sig)).toBe(false)
    expect(verifyAttachScope(SECRET, claim, sig)).toBe(false)
  })

  /** What the code before the bound task (c7d062ce) minted for the same run:
   *  pinned, so "unchanged" is checked against the old code, not the new. */
  const BEFORE = {
    tasks:
      'http://x/api/mcp/tasks?scopeTeamId=T&scopeAgentId=A&teamRun=1&scopeSig=76862723e094032fe21326e43ed2ee2acb31b0121a340f96918b0426819002f5&attachToken=9e22050f1ed0c614bf696bededd7b238b569056a9cf79f632e4c260c05dc53c6',
    memory:
      'http://x/api/mcp/memory?scopeTeamId=T&scopeAgentId=A&teamRun=1&scopeSig=76862723e094032fe21326e43ed2ee2acb31b0121a340f96918b0426819002f5&attachToken=9e22050f1ed0c614bf696bededd7b238b569056a9cf79f632e4c260c05dc53c6',
    tools:
      'http://x/api/mcp/tools?scopeTeamId=T&scopeAgentId=A&teamRun=1&scopeSig=76862723e094032fe21326e43ed2ee2acb31b0121a340f96918b0426819002f5&attachToken=9e22050f1ed0c614bf696bededd7b238b569056a9cf79f632e4c260c05dc53c6',
    teamchat:
      'http://x/api/mcp/teamchat?roomTeamId=T&postAuthorAgentId=A&delegate=1&scopeSig=4c83478a053c745ca5d1027514a5a843698b4a42b894903bfc03cfa7da7a7113&attachToken=9e22050f1ed0c614bf696bededd7b238b569056a9cf79f632e4c260c05dc53c6',
  }

  it('stays off every other URL, whose bytes are what they were before it', () => {
    for (const server of ['memory', 'tools', 'teamchat'] as const)
      expect(mcpHttpUrl('http://x', server, onTask)).toBe(BEFORE[server])
  })

  it('is not the memory provenance task id, and does not turn on memory provenance', () => {
    const memory = new URL(mcpHttpUrl('http://x', 'memory', onTask))
    expect(memory.searchParams.has('provTaskId')).toBe(false)
    expect(memory.searchParams.has('provSig')).toBe(false)
    // The executor's provenance stamp binds no task for the Tasks tools.
    const stamped = new URL(
      mcpHttpUrl('http://x', 'tasks', {
        teamId: 'T',
        agentId: 'A',
        taskId: 'task-9',
        attachSecret: SECRET,
      }),
    )
    expect(stamped.searchParams.has('scopeTaskId')).toBe(false)
    expect(stamped.searchParams.get('scopeSig')).toBe(
      signAttachScope(SECRET, { teamId: 'T', agentId: 'A', delegate: false }),
    )
  })

  it('leaves the Tasks URL of a run with no task byte-identical to before', () => {
    const withoutTask = { ...onTask, boundTaskId: undefined }
    expect(mcpHttpUrl('http://x', 'tasks', withoutTask)).toBe(BEFORE.tasks)
  })
})

describe('signAttachAccess / verifyAttachAccess (the control-plane access token)', () => {
  it('round-trips, and is deterministic so configs stay byte-stable', () => {
    const token = signAttachAccess(SECRET)
    expect(verifyAttachAccess(SECRET, token)).toBe(true)
    expect(signAttachAccess(SECRET)).toBe(token)
  })

  it('a different secret verifies nothing', () => {
    expect(verifyAttachAccess('b'.repeat(64), signAttachAccess(SECRET))).toBe(false)
  })

  it('malformed tokens are false, never a throw', () => {
    for (const bad of ['', 'zz', 'deadbeef', 'not hex', signAttachAccess(SECRET).slice(2)]) {
      expect(verifyAttachAccess(SECRET, bad)).toBe(false)
    }
  })

  it('is its own domain: never a scope or provenance signature, nor the reverse', () => {
    // The empty scope is the closest a scope signature gets to "no fields", so it
    // is the one that would collide if the domains were shared.
    const emptyScopeSig = signAttachScope(SECRET, {})
    const emptyProvSig = signAttachProvenance(SECRET, {})
    expect(verifyAttachAccess(SECRET, emptyScopeSig)).toBe(false)
    expect(verifyAttachAccess(SECRET, emptyProvSig)).toBe(false)
    expect(verifyAttachScope(SECRET, {}, signAttachAccess(SECRET))).toBe(false)
    expect(verifyAttachProvenance(SECRET, {}, signAttachAccess(SECRET))).toBe(false)
  })
})

describe('mcpHttpUrl access token', () => {
  it('rides every server URL minted with a secret, scoped or not', () => {
    for (const server of MCP_SERVER_NAMES) {
      for (const scope of [
        { attachSecret: SECRET },
        { teamId: 'T', agentId: 'A', attachSecret: SECRET },
      ]) {
        const token = new URL(mcpHttpUrl('http://x', server, scope)).searchParams.get('attachToken')
        expect(token, `${server} ${JSON.stringify(scope)}`).toBe(signAttachAccess(SECRET))
      }
    }
  })

  it('an unscoped URL carries the token alone, with no signature over nothing', () => {
    // OpenClaw's process-wide URL and the verification critic's are this shape.
    for (const server of MCP_SERVER_NAMES) {
      const url = new URL(mcpHttpUrl('http://x', server, { attachSecret: SECRET }))
      expect([...url.searchParams.keys()]).toEqual(['attachToken'])
    }
  })

  it('a scoped URL keeps its scope signature exactly as before', () => {
    const scope = { teamId: 'T', agentId: 'A', attachSecret: SECRET }
    const url = new URL(mcpHttpUrl('http://x', 'tasks', scope))
    expect(url.searchParams.get('scopeSig')).toBe(
      signAttachScope(SECRET, { ...scope, delegate: false }),
    )
  })

  it('no secret, no token: pure URL construction stays secret-free', () => {
    expect(mcpHttpUrl('http://x', 'tasks', { teamId: 'T' })).not.toContain('attachToken')
    expect(mcpHttpUrl('http://x', 'tools')).not.toContain('attachToken')
  })

  it('never leaks the secret itself', () => {
    const secret = 'f0e1d2c3'.repeat(8)
    for (const server of MCP_SERVER_NAMES) {
      expect(mcpHttpUrl('http://x', server, { attachSecret: secret })).not.toContain(secret)
    }
  })

  it('the Claude Code snippet quotes the URL, so its query survives a shell', () => {
    // Unquoted, zsh globs on `?` ("no matches found") and every shell splits a
    // scoped URL at its first `&`.
    const { snippet } = buildAttachConfig({
      runtime: 'claude-code',
      server: 'memory',
      transport: 'http',
      httpBaseUrl: 'http://127.0.0.1:18790',
      scope: { teamId: 'T', agentId: 'A', attachSecret: SECRET },
    })
    const url = mcpHttpUrl('http://127.0.0.1:18790', 'memory', {
      teamId: 'T',
      agentId: 'A',
      attachSecret: SECRET,
    })
    expect(snippet).toBe(`claude mcp add --transport http clawboo-memory '${url}'`)
  })
})

describe('signAttachProvenance / verifyAttachProvenance', () => {
  const prov = { agentId: 'A', runtime: 'codex', taskId: 't1', sessionKey: 's' }

  it('round-trips, and any changed stamp breaks it', () => {
    const sig = signAttachProvenance(SECRET, prov)
    expect(verifyAttachProvenance(SECRET, prov, sig)).toBe(true)
    expect(verifyAttachProvenance(SECRET, { ...prov, taskId: 't2' }, sig)).toBe(false)
    expect(verifyAttachProvenance(SECRET, { ...prov, agentId: 'B' }, sig)).toBe(false)
    expect(verifyAttachProvenance(SECRET, { ...prov, runtime: 'hermes' }, sig)).toBe(false)
  })

  it('is a different domain from the scope signature', () => {
    // Same id in the same position must not produce the same bytes.
    const scopeSig = signAttachScope(SECRET, { agentId: 'A' })
    expect(verifyAttachProvenance(SECRET, { agentId: 'A' }, scopeSig)).toBe(false)
    expect(
      verifyAttachScope(SECRET, { agentId: 'A' }, signAttachProvenance(SECRET, { agentId: 'A' })),
    ).toBe(false)
  })

  it('the Memory URL signs its stamps only when there are stamps and a secret', () => {
    const signed = mcpHttpUrl('http://x', 'memory', {
      agentId: 'A',
      taskId: 't1',
      attachSecret: SECRET,
    })
    expect(signed).toContain('provSig=')
    expect(mcpHttpUrl('http://x', 'memory', { agentId: 'A', attachSecret: SECRET })).not.toContain(
      'provSig',
    )
    expect(mcpHttpUrl('http://x', 'memory', { agentId: 'A', taskId: 't1' })).not.toContain(
      'provSig',
    )
    expect(
      mcpHttpUrl('http://x', 'tasks', { agentId: 'A', taskId: 't1', attachSecret: SECRET }),
    ).not.toContain('provSig')
  })
})
