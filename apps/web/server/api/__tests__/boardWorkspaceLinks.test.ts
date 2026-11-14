// An agent owns its worktree, so it can plant a link there to any file the
// server can read, such as the vault key in Clawboo's own data folder. Every
// route that reads agent-written files back to the dashboard is asked for one
// here, over HTTP, against a real task worktree: the artifact preview, the
// Computer tab's file read, and the task drawer's detail. None may answer with
// the linked file's bytes.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTask } from '@clawboo/db'
import { SOR_FILES } from '@clawboo/worktrees'

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}

const CANARY = 'vault-key-canary-3f9a1c'

let home: string
let repo: string
let prevHome: string | undefined
let prevClawbooHome: string | undefined
let server: http.Server
let base: string
let taskId: string

const { getDb, resetDb } = await import('../../lib/db')
const { provisionTaskWorkspace } = await import('../../lib/worktrees')
const { apiRouter } = await import('../index')

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-links-home-'))
  prevHome = process.env['HOME']
  prevClawbooHome = process.env['CLAWBOO_HOME']
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  const secrets = path.join(home, '.clawboo', 'secrets')
  await mkdir(secrets, { recursive: true })
  const key = path.join(secrets, 'master.key')
  await writeFile(key, CANARY)

  repo = await mkdtemp(path.join(os.tmpdir(), 'clawboo-links-repo-'))
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['config', 'user.name', 'test'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(repo, 'README.md'), '# repo\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '--no-verify', '-m', 'init'])

  taskId = createTask(getDb(), { title: 'Build the page', status: 'todo' }).id
  const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
  if (!prov.ok) throw new Error(`provision failed: ${prov.reason}`)
  const wt = prov.worktree.worktreePath

  // The links an agent could plant: a file, a folder above a file, and one of
  // the task files the drawer shows.
  await symlink(key, path.join(wt, 'leak.txt'))
  await symlink(secrets, path.join(wt, 'site'))
  await rm(path.join(wt, SOR_FILES.task))
  await symlink(key, path.join(wt, SOR_FILES.task))

  const app = express()
  app.set('case sensitive routing', true)
  app.use(apiRouter)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board/${taskId}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  resetDb()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevClawbooHome
  await rm(home, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

async function get(sub: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}${sub}`, { redirect: 'manual' })
  return { status: res.status, body: await res.text() }
}

describe('a link planted in a worktree is never served', () => {
  it('the artifact preview refuses it, as a file and through a folder', async () => {
    for (const sub of ['/preview/leak.txt', '/preview/site/master.key']) {
      const r = await get(sub)
      expect(r.status, sub).toBe(400)
      expect(r.body, sub).not.toContain(CANARY)
    }
  })

  it("the Computer tab's file read refuses it, as a file and through a folder", async () => {
    for (const rel of ['leak.txt', 'site/master.key']) {
      const r = await get(`/workspace/file?path=${encodeURIComponent(rel)}`)
      expect(r.status, rel).toBe(400)
      expect(r.body, rel).not.toContain(CANARY)
    }
  })

  it('the task drawer leaves a linked task file out and shows the rest', async () => {
    const r = await get('/workspace/detail')
    expect(r.status).toBe(200)
    expect(r.body).not.toContain(CANARY)
    const detail = JSON.parse(r.body) as { sorFiles?: Record<string, string> }
    expect(detail.sorFiles?.[SOR_FILES.task]).toBeUndefined()
    expect(detail.sorFiles?.[SOR_FILES.progress]).toEqual(expect.any(String))
  })
})
