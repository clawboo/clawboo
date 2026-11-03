import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { server } from '../../__vitest__/mswServer'
import { fetchTeamVerifyCommand, saveTeamVerifyCommand } from '../teamVerifyCommand'

describe('fetchTeamVerifyCommand', () => {
  it('returns the stored command', async () => {
    server.use(
      http.get('/api/team-verify-command/:teamId', ({ params }) =>
        HttpResponse.json({ command: params.teamId === 't1' ? 'npm test' : '' }),
      ),
    )
    expect(await fetchTeamVerifyCommand('t1')).toBe('npm test')
  })

  it('returns an empty string when none is set', async () => {
    server.use(
      http.get('/api/team-verify-command/:teamId', () => HttpResponse.json({ command: '' })),
    )
    expect(await fetchTeamVerifyCommand('t1')).toBe('')
  })

  it('returns null when the read fails, so a failure never reads as unset', async () => {
    server.use(
      http.get('/api/team-verify-command/:teamId', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )
    expect(await fetchTeamVerifyCommand('t1')).toBeNull()
  })

  it('encodes the team id in the path', async () => {
    let seen = ''
    server.use(
      http.get('/api/team-verify-command/:teamId', ({ request }) => {
        seen = new URL(request.url).pathname
        return HttpResponse.json({ command: '' })
      }),
    )
    await fetchTeamVerifyCommand('a/b')
    expect(seen).toBe('/api/team-verify-command/a%2Fb')
  })
})

describe('saveTeamVerifyCommand', () => {
  it('PUTs { command } and returns the stored command', async () => {
    let body: unknown = null
    server.use(
      http.put('/api/team-verify-command/:teamId', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ command: 'pnpm test' })
      }),
    )
    expect(await saveTeamVerifyCommand('t1', '  pnpm test  ')).toBe('pnpm test')
    expect(body).toEqual({ command: '  pnpm test  ' })
  })

  it('returns an empty string when the command was cleared', async () => {
    server.use(
      http.put('/api/team-verify-command/:teamId', () => HttpResponse.json({ command: '' })),
    )
    expect(await saveTeamVerifyCommand('t1', '')).toBe('')
  })

  it('returns null when the server refuses the save', async () => {
    server.use(
      http.put('/api/team-verify-command/:teamId', () =>
        HttpResponse.json({ error: 'team not found' }, { status: 404 }),
      ),
    )
    expect(await saveTeamVerifyCommand('gone', 'npm test')).toBeNull()
  })

  it('makes a read wait for a save of the same team still in flight', async () => {
    let stored = 'npm test'
    let releasePut: () => void = () => {}
    const putArrived = new Promise<void>((arrived) => {
      server.use(
        http.get('/api/team-verify-command/:teamId', () => HttpResponse.json({ command: stored })),
        http.put('/api/team-verify-command/:teamId', async ({ request }) => {
          const body = (await request.json()) as { command: string }
          arrived()
          await new Promise<void>((release) => (releasePut = release))
          stored = body.command
          return HttpResponse.json({ command: stored })
        }),
      )
    })
    const save = saveTeamVerifyCommand('t1', 'pnpm test')
    await putArrived
    const read = fetchTeamVerifyCommand('t1')
    // Land the save well after the read was sent: a read that did not wait
    // would be answered with the old command first.
    setTimeout(releasePut, 50)
    expect(await save).toBe('pnpm test')
    expect(await read).toBe('pnpm test')
  })
})
