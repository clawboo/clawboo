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
    const scope = { server: 'tasks', teamId: 'T', agentId: 'A', delegate: true } as const
    expect(verifyAttachScope(SECRET, scope, signAttachScope(SECRET, scope))).toBe(true)
  })

  it('any changed field breaks verification — including the delegate PRIVILEGE', () => {
    const scope = { server: 'tasks', teamId: 'T', agentId: 'A', delegate: false } as const
    const sig = signAttachScope(SECRET, scope)
    expect(verifyAttachScope(SECRET, { ...scope, agentId: 'victim' }, sig)).toBe(false)
    expect(verifyAttachScope(SECRET, { ...scope, teamId: 'other' }, sig)).toBe(false)
    expect(verifyAttachScope(SECRET, { ...scope, delegate: true }, sig)).toBe(false)
  })

  it('fields cannot BLEED into each other', () => {
    // Without a separator, {teamId:'ab', agentId:'c'} and {teamId:'a', agentId:'bc'}
    // would canonicalise identically and one signature would cover both identities.
    const sig = signAttachScope(SECRET, { server: 'tasks', teamId: 'ab', agentId: 'c' })
    expect(verifyAttachScope(SECRET, { server: 'tasks', teamId: 'a', agentId: 'bc' }, sig)).toBe(
      false,
    )
  })

  it('a different secret verifies nothing', () => {
    const scope = { server: 'tasks', teamId: 'T', agentId: 'A' } as const
    expect(verifyAttachScope('b'.repeat(64), scope, signAttachScope(SECRET, scope))).toBe(false)
  })

  it('malformed signatures are false, never a throw', () => {
    const scope = { server: 'tasks', teamId: 'T' } as const
    for (const bad of ['', 'zz', 'deadbeef', 'not hex', signAttachScope(SECRET, scope).slice(2)]) {
      expect(verifyAttachScope(SECRET, scope, bad)).toBe(false)
    }
  })

  it('is deterministic, so attach configs stay byte-stable across rewrites', () => {
    // The codex driver's auth-seeding uses mtime freshness on files in the run
    // home; a signature that changed per write would churn every config.
    const scope = { server: 'tasks', teamId: 'T', agentId: 'A' } as const
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
    expect(
      verifyAttachScope(
        SECRET,
        { server: 'teamchat', teamId: 'T', agentId: 'A', delegate: true },
        sig,
      ),
    ).toBe(false)
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

describe('the server a signature is for', () => {
  const scopes = [
    ['a person’s chat', { teamId: null, agentId: 'A', chatRun: true, chatRunTeamId: 'T' }],
    ['a team run', { teamId: 'T', agentId: 'A', delegate: true }],
    ['a board task run', { teamId: 'T', agentId: 'A' }],
  ] as const

  it.each(scopes)('%s: a URL signs for its own server and no other', (_name, scope) => {
    const signed = { ...scope, attachSecret: SECRET }
    const sigs = MCP_SERVER_NAMES.map(
      (server) =>
        new URL(mcpHttpUrl('http://x', server, signed)).searchParams.get('scopeSig') as string,
    )
    // No two URLs of one run carry the same signature, so none can stand in for another.
    expect(new Set(sigs).size).toBe(MCP_SERVER_NAMES.length)
  })

  it('the same claim, signed for one server, does not verify for another', () => {
    const claim = { agentId: 'A', chatRun: true, delegate: false } as const
    for (const server of MCP_SERVER_NAMES) {
      const sig = signAttachScope(SECRET, { ...claim, server })
      for (const other of MCP_SERVER_NAMES)
        expect(verifyAttachScope(SECRET, { ...claim, server: other }, sig), server + other).toBe(
          other === server,
        )
    }
  })

  it('a chat’s Memory signature does not open Tasks with no team hold', () => {
    const memorySig = new URL(
      mcpHttpUrl('http://x', 'memory', {
        teamId: null,
        agentId: 'A',
        chatRun: true,
        chatRunTeamId: 'T',
        attachSecret: SECRET,
      }),
    ).searchParams.get('scopeSig') as string
    // What the Tasks mount reads off `scopeAgentId=A&chatRun=1`.
    expect(
      verifyAttachScope(
        SECRET,
        { server: 'tasks', teamId: null, agentId: 'A', tenantId: null, chatRun: true },
        memorySig,
      ),
    ).toBe(false)
  })
})

describe('the chat-run claim', () => {
  const chatScope = {
    teamId: null,
    agentId: 'A',
    chatRun: true,
    chatRunTeamId: 'T',
    attachSecret: SECRET,
  }

  it('holds the Tasks URL to the agent’s team, inside the signature', () => {
    const url = new URL(mcpHttpUrl('http://x', 'tasks', chatScope))
    expect(url.searchParams.get('chatRun')).toBe('1')
    expect(url.searchParams.get('scopeTeamId')).toBe('T')
    const sig = url.searchParams.get('scopeSig')!
    const claim = { server: 'tasks', teamId: 'T', agentId: 'A' } as const
    expect(verifyAttachScope(SECRET, { ...claim, chatRun: true }, sig)).toBe(true)
    // Stripped of the claim, it does not read as an agent with the writes back.
    expect(verifyAttachScope(SECRET, claim, sig)).toBe(false)
  })

  it('leaves the chat’s Memory scope with no team', () => {
    const url = new URL(mcpHttpUrl('http://x', 'memory', chatScope))
    expect(url.searchParams.has('scopeTeamId')).toBe(false)
    expect(url.searchParams.get('chatRun')).toBe('1')
  })

  it('signs no URL a chat run holds as a plain agent scope', () => {
    for (const server of MCP_SERVER_NAMES) {
      const sig = new URL(
        mcpHttpUrl('http://x', server, { ...chatScope, chatRunTeamId: null }),
      ).searchParams.get('scopeSig')!
      expect(verifyAttachScope(SECRET, { server, agentId: 'A' }, sig), server).toBe(false)
    }
  })
})

describe('the team-run claim on the Tasks URL', () => {
  const teamRunScope = { teamId: 'T', agentId: 'A', delegate: true, attachSecret: SECRET }

  it('marks a run the team engine drives, inside the signature', () => {
    const url = new URL(mcpHttpUrl('http://x', 'tasks', teamRunScope))
    expect(url.searchParams.get('teamRun')).toBe('1')
    const sig = url.searchParams.get('scopeSig')!
    const claim = { server: 'tasks', teamId: 'T', agentId: 'A' } as const
    expect(verifyAttachScope(SECRET, { ...claim, teamRun: true }, sig)).toBe(true)
    // Stripped of the claim, the signature no longer matches what the URL says.
    expect(verifyAttachScope(SECRET, claim, sig)).toBe(false)
  })

  it('is absent from every other run, whose signature is unchanged', () => {
    const url = new URL(
      mcpHttpUrl('http://x', 'tasks', { teamId: 'T', agentId: 'A', attachSecret: SECRET }),
    )
    expect(url.searchParams.has('teamRun')).toBe(false)
    expect(url.searchParams.get('scopeSig')).toBe(
      signAttachScope(SECRET, { server: 'tasks', teamId: 'T', agentId: 'A', delegate: false }),
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
    const claim = { teamId: 'T', agentId: 'A' } as const
    expect(
      verifyAttachScope(SECRET, { ...claim, server: 'teamchat', delegate: true }, tasksSig),
    ).toBe(false)
    expect(
      verifyAttachScope(SECRET, { ...claim, server: 'tasks', teamRun: true }, teamchatSig),
    ).toBe(false)
  })

  it('rides the Memory and Tools URLs too, so no URL a team run holds signs a plain scope', () => {
    for (const server of ['memory', 'tools'] as const) {
      const plain = signAttachScope(SECRET, { server, teamId: 'T', agentId: 'A', delegate: false })
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
    const claim = { server: 'tasks', teamId: 'T', agentId: 'A', teamRun: true } as const
    expect(verifyAttachScope(SECRET, { ...claim, boundTaskId: 'task-1' }, sig)).toBe(true)
    expect(verifyAttachScope(SECRET, { ...claim, boundTaskId: 'task-2' }, sig)).toBe(false)
    expect(verifyAttachScope(SECRET, claim, sig)).toBe(false)
  })

  /** What a run with no bound task mints. Worked out from the canonical form and pinned,
   *  so "unchanged" is checked against the form, not against the code. */
  const BEFORE = {
    tasks:
      'http://x/api/mcp/tasks?scopeTeamId=T&scopeAgentId=A&teamRun=1&scopeSig=b8f4f4e56e9b4bdb6cbf61fdcbb582acfb8501e41753383c2e664e755dcf5aba&attachToken=9e22050f1ed0c614bf696bededd7b238b569056a9cf79f632e4c260c05dc53c6',
    memory:
      'http://x/api/mcp/memory?scopeTeamId=T&scopeAgentId=A&teamRun=1&scopeSig=49476de4fdd5d6f04b30a8f699a7b297e0188840a2cc96803736ba79a1864c41&attachToken=9e22050f1ed0c614bf696bededd7b238b569056a9cf79f632e4c260c05dc53c6',
    tools:
      'http://x/api/mcp/tools?scopeTeamId=T&scopeAgentId=A&teamRun=1&scopeSig=4e2a1051e06f75a4b7cc64cc893a22db89cfd71d39d023965bd5d33aec33cdd7&attachToken=9e22050f1ed0c614bf696bededd7b238b569056a9cf79f632e4c260c05dc53c6',
    teamchat:
      'http://x/api/mcp/teamchat?roomTeamId=T&postAuthorAgentId=A&delegate=1&scopeSig=91ba41c0979e5378a3d11f4eb376c28ca2c9dfe73746cc875fb3ef7d18a958f0&attachToken=9e22050f1ed0c614bf696bededd7b238b569056a9cf79f632e4c260c05dc53c6',
  }

  it('stays off the Memory and TeamChat URLs, whose bytes are what they were before it', () => {
    for (const server of ['memory', 'teamchat'] as const)
      expect(mcpHttpUrl('http://x', server, onTask)).toBe(BEFORE[server])
  })

  it('rides the Tools URL too, signed, so an approval can name the task', () => {
    const url = new URL(mcpHttpUrl('http://x', 'tools', onTask))
    expect(url.searchParams.get('scopeTaskId')).toBe('task-1')
    const sig = url.searchParams.get('scopeSig')!
    const claim = { server: 'tools', teamId: 'T', agentId: 'A', teamRun: true } as const
    expect(verifyAttachScope(SECRET, { ...claim, boundTaskId: 'task-1' }, sig)).toBe(true)
    expect(verifyAttachScope(SECRET, { ...claim, boundTaskId: 'task-2' }, sig)).toBe(false)
    expect(verifyAttachScope(SECRET, claim, sig)).toBe(false)
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
      signAttachScope(SECRET, { server: 'tasks', teamId: 'T', agentId: 'A', delegate: false }),
    )
  })

  it('leaves the Tasks and Tools URLs of a run with no task byte-identical to before', () => {
    const withoutTask = { ...onTask, boundTaskId: undefined }
    expect(mcpHttpUrl('http://x', 'tasks', withoutTask)).toBe(BEFORE.tasks)
    expect(mcpHttpUrl('http://x', 'tools', withoutTask)).toBe(BEFORE.tools)
  })
})

describe("the run's id on the Tasks URL", () => {
  const onRun = {
    teamId: 'T',
    agentId: 'A',
    delegate: true,
    boundTaskId: 'task-1',
    boundExecutionId: 'exec-1',
    attachSecret: SECRET,
  }
  const claim = {
    server: 'tasks',
    teamId: 'T',
    agentId: 'A',
    teamRun: true,
    boundTaskId: 'task-1',
  } as const

  /** Worked out by hand from the canonical form and pinned, so a change to how a scope
   *  signs fails here. */
  const SIGNED_BEFORE = [
    [
      { server: 'tasks', teamId: 'T', agentId: 'A' },
      '5d21ee0edfeeb84fbc52946fbe0955c8230a5e7edab9f1253da0abb0385527ee',
    ],
    [
      { server: 'teamchat', teamId: 'T', agentId: 'A', delegate: true },
      '91ba41c0979e5378a3d11f4eb376c28ca2c9dfe73746cc875fb3ef7d18a958f0',
    ],
    [
      { server: 'tasks', teamId: 'T', agentId: 'A', teamRun: true },
      'b8f4f4e56e9b4bdb6cbf61fdcbb582acfb8501e41753383c2e664e755dcf5aba',
    ],
    [
      { server: 'tasks', teamId: 'T', agentId: 'A', teamRun: true, boundTaskId: 'task-1' },
      '7bde63c764b8544125b91168c9e89864217d48d94ab29f2ea4424ccfb85eb800',
    ],
  ] as const

  it('signs every scope that carries no run id to the same bytes as before', () => {
    for (const [scope, sig] of SIGNED_BEFORE) expect(signAttachScope(SECRET, scope)).toBe(sig)
  })

  it('is covered by the signature: it can be neither moved, stripped nor added', () => {
    const url = new URL(mcpHttpUrl('http://x', 'tasks', onRun))
    expect(url.searchParams.get('scopeExecutionId')).toBe('exec-1')
    const sig = url.searchParams.get('scopeSig')!
    expect(verifyAttachScope(SECRET, { ...claim, boundExecutionId: 'exec-1' }, sig)).toBe(true)
    expect(verifyAttachScope(SECRET, { ...claim, boundExecutionId: 'exec-2' }, sig)).toBe(false)
    expect(verifyAttachScope(SECRET, claim, sig)).toBe(false)
  })

  it('cannot pass for a bound task, or the reverse', () => {
    const scope = { server: 'tasks', teamId: 'T', agentId: 'A' } as const
    const sig = signAttachScope(SECRET, { ...scope, boundExecutionId: 'x' })
    expect(verifyAttachScope(SECRET, { ...scope, boundTaskId: 'x' }, sig)).toBe(false)
  })

  it('rides no other URL, so their bytes do not change from run to run', () => {
    for (const server of ['memory', 'tools', 'teamchat'] as const) {
      const without = { ...onRun, boundExecutionId: undefined }
      expect(mcpHttpUrl('http://x', server, onRun)).toBe(mcpHttpUrl('http://x', server, without))
    }
  })

  it('leaves the Tasks URL of a run with no id byte-identical to its old form', () => {
    expect(mcpHttpUrl('http://x', 'tasks', { ...onRun, boundExecutionId: null })).toBe(
      mcpHttpUrl('http://x', 'tasks', { ...onRun, boundExecutionId: undefined }),
    )
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
    const emptyScopeSig = signAttachScope(SECRET, { server: 'tasks' })
    const emptyProvSig = signAttachProvenance(SECRET, {})
    expect(verifyAttachAccess(SECRET, emptyScopeSig)).toBe(false)
    expect(verifyAttachAccess(SECRET, emptyProvSig)).toBe(false)
    expect(verifyAttachScope(SECRET, { server: 'tasks' }, signAttachAccess(SECRET))).toBe(false)
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

  it('a scoped URL keeps its scope signature beside the token', () => {
    const scope = { teamId: 'T', agentId: 'A', attachSecret: SECRET }
    const url = new URL(mcpHttpUrl('http://x', 'tasks', scope))
    expect(url.searchParams.get('scopeSig')).toBe(
      signAttachScope(SECRET, { teamId: 'T', agentId: 'A', server: 'tasks', delegate: false }),
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
    const scope = { server: 'memory', agentId: 'A' } as const
    const scopeSig = signAttachScope(SECRET, scope)
    expect(verifyAttachProvenance(SECRET, { agentId: 'A' }, scopeSig)).toBe(false)
    expect(verifyAttachScope(SECRET, scope, signAttachProvenance(SECRET, { agentId: 'A' }))).toBe(
      false,
    )
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
