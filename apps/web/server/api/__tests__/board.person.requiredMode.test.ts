// Behind a sign-in proxy in `required` mode, a person's write needs a verified person:
// the dashboard's fetch metadata alone is not enough, and a signed token is, from a
// script as well as the dashboard. An agent that reads the access token file and sends
// the same headers still has no token the proxy signed. Over real HTTP, in the server's
// order: identity lane, identity middleware, routes.

import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import {
  askQuestion,
  claimTask,
  createTask,
  getTask,
  listTaskQuestions,
  openAgentWakeCard,
  readAgentWakeGate,
  readTeamAlwaysAllow,
} from '@clawboo/db'
import express from 'express'
import { SignJWT, type JWK } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/teamChat/boardDispatch', () => ({ requestTaskDispatch: () => undefined }))

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const { attachIdentity } = await import('../../lib/auth')
const { createAssertionVerifier } = await import('../../lib/proxyIdentity/verifier')
const { createProxyIdentityLane } = await import('../../lib/proxyIdentity/lane')
const { boardAgentWakesPOST, boardQuestionAnswerPOST, boardReopenPOST } =
  await import('../boardPerson')
const { teamAgentWakesPUT } = await import('../teamAgentWakes')

const ed = generateKeyPairSync('ed25519')
const config = {
  mode: 'required' as const,
  header: 'clawboo-identity',
  issuer: 'https://proxy.example.com',
  audience: 'clawboo',
  binding: 'request' as const,
  maxLifetimeSeconds: 60,
  nameClaim: 'name',
  roleClaim: 'role',
  keys: {
    source: 'public-key' as const,
    jwks: { keys: [ed.publicKey.export({ format: 'jwk' }) as JWK] },
  },
  accountSubjects: 'never' as const,
}

let n = 0
async function assertion(method: string, urlPath: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  n += 1
  return new SignJWT({ name: 'Ada', role: 'admin', htm: method, htu: urlPath })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('https://proxy.example.com')
    .setAudience('clawboo')
    .setSubject('user-42')
    .setIssuedAt(now)
    .setExpirationTime(now + 30)
    .setJti(`person-${n}-${Math.random()}`)
    .sign(ed.privateKey)
}

const DASHBOARD = {
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'content-type': 'application/json',
}

describe('a person’s writes in `required` mode', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let server: http.Server
  let base: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-person-required-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    const lane = createProxyIdentityLane(config, createAssertionVerifier(config), {
      isRuntimeRequest: () => false,
    })
    const app = express()
    app.use(express.json())
    app.use(lane.http)
    app.use(attachIdentity)
    app.post('/api/board/questions/:questionId/answer', (req, res) => {
      void boardQuestionAnswerPOST(req, res)
    })
    app.post('/api/board/:taskId/reopen', (req, res) => {
      void boardReopenPOST(req, res)
    })
    app.post('/api/board/agent-wakes/:jobTaskId', boardAgentWakesPOST)
    app.put('/api/team-agent-wakes/:teamId', teamAgentWakesPUT)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  function asked(): { taskId: string; questionId: string } {
    const db = getDb()
    const t = createTask(db, { title: 'Ask', status: 'todo' })
    claimTask(db, t.id, 'a1')
    const r = askQuestion(db, {
      taskId: t.id,
      agentId: 'a1',
      kind: 'confirm',
      payload: { prompt: 'Go?' },
    })
    if (!r.ok) throw new Error('ask failed')
    return { taskId: t.id, questionId: r.question.id }
  }

  it('refuses an answer with the dashboard’s headers and no verified person', async () => {
    const { taskId, questionId } = asked()
    const res = await fetch(`${base}/api/board/questions/${questionId}/answer`, {
      method: 'POST',
      headers: DASHBOARD,
      body: JSON.stringify({ answer: { confirmed: true } }),
    })
    expect(res.status).toBe(401)
    expect(listTaskQuestions(getDb(), taskId)[0]?.status).toBe('pending')
  })

  it('takes a verified person from a script: the signed token is what vouches', async () => {
    const { taskId, questionId } = asked()
    const urlPath = `/api/board/questions/${questionId}/answer`
    const res = await fetch(`${base}${urlPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'clawboo-identity': await assertion('POST', urlPath),
      },
      body: JSON.stringify({ answer: { confirmed: true } }),
    })
    expect(res.status).toBe(200)
    expect(listTaskQuestions(getDb(), taskId)[0]?.status).toBe('answered')
  })

  it('records the verified person when both hold', async () => {
    const { taskId, questionId } = asked()
    const urlPath = `/api/board/questions/${questionId}/answer`
    const res = await fetch(`${base}${urlPath}`, {
      method: 'POST',
      headers: { ...DASHBOARD, 'clawboo-identity': await assertion('POST', urlPath) },
      body: JSON.stringify({ answer: { confirmed: true } }),
    })
    expect(res.status).toBe(200)
    const q = listTaskQuestions(getDb(), taskId)[0]
    expect(JSON.parse(q?.answeredBy ?? '{}')).toEqual({ id: 'user-42', name: 'Ada', role: 'admin' })
  })

  it('refuses an answer about agents waking each other with no verified person', async () => {
    const db = getDb()
    const t = createTask(db, { title: 'Parked', status: 'todo' })
    openAgentWakeCard(db, { taskId: t.id, kind: 'ask', fromAgentId: 'a', toAgentId: 'b' })
    const res = await fetch(`${base}/api/board/agent-wakes/${t.id}`, {
      method: 'POST',
      headers: DASHBOARD,
      body: JSON.stringify({ decision: 'job' }),
    })
    expect(res.status).toBe(401)
    expect(readAgentWakeGate(db, t.id)?.decision).toBeNull()
    expect(readAgentWakeGate(db, t.id)?.cardKind).toBe('ask')
  })

  it('refuses the team’s setting with no verified person', async () => {
    const res = await fetch(`${base}/api/team-agent-wakes/some-team`, {
      method: 'PUT',
      headers: DASHBOARD,
      body: JSON.stringify({ always: true }),
    })
    expect(res.status).toBe(401)
    expect(readTeamAlwaysAllow(getDb(), 'some-team')).toBe(false)
  })

  it('refuses a Reopen with no verified person too', async () => {
    const db = getDb()
    const t = createTask(db, { title: 'Done', status: 'todo' })
    claimTask(db, t.id, 'a1')
    const res = await fetch(`${base}/api/board/${t.id}/reopen`, {
      method: 'POST',
      headers: DASHBOARD,
      body: '{}',
    })
    expect(res.status).toBe(401)
    expect(getTask(db, t.id)?.status).toBe('in_progress')
  })
})
