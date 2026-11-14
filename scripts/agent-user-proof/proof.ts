// Agent isolation, proven end to end inside a Linux container with two real
// users. Bundled by run.sh and run in the container as the server user
// (`clawboo`, uid 10001); the agent user is `clawboo-agent` (uid 10002).
//
//   node proof.cjs sudo     the agent host started through sudo
//   node proof.cjs socket   the agent host started by clawboo-launch (run.sh
//                           starts this under the launcher, as root, with
//                           --security-opt no-new-privileges)
//   node proof.cjs refuse   the sudoers rule is gone: the check must refuse
//   node proof.cjs socket-hardlink   under the launcher, with a hard link to the
//                           database planted in the work folder: must refuse
//   node proof.cjs socket-hostdeath  under the launcher; run.sh kills the host,
//                           and the server must exit
//
// Each check prints PASS or FAIL with what it saw; the exit code is the number
// of failures.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { startAgentUser, stopAgentUser } from '../../apps/web/server/lib/agentUser/boot'
import { agentStat } from '../../apps/web/server/lib/agentUser/agentFs'
import {
  exportTaskBranch,
  runAgentGit,
  syncMirror,
} from '../../apps/web/server/lib/agentUser/mirror'
import { peekAgentHost } from '../../apps/web/server/lib/agentUser/state'
import { buildChildEnv } from '../../apps/web/server/lib/runtimes/childEnv'
import { spawnAgentProcess } from '../../apps/web/server/lib/runtimes/spawner'
import { extraProofs } from './proofPaths'

const mode = process.argv[2] ?? 'sudo'
const AGENT_UID = 10002
const DATA = process.env['CLAWBOO_HOME'] ?? '/home/clawboo/.clawboo'
const FAKE = process.env['PROOF_FAKE_RUNTIME'] ?? '/proof/fake-runtime.sh'
let failures = 0

export function check(name: string, ok: boolean, detail: unknown): void {
  if (!ok) failures++
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(detail)}`}\n`,
  )
}

const log = {
  info: () => undefined,
  warn: (o: unknown, m?: string) => process.stdout.write(`warn  ${m ?? JSON.stringify(o)}\n`),
  error: (o: unknown, m?: string) => process.stdout.write(`error ${m ?? JSON.stringify(o)}\n`),
}

/** Clawboo's private files, as a real install has them. */
function makeDataFolder(): { db: string; key: string; vault: string } {
  fs.mkdirSync(path.join(DATA, 'secrets'), { recursive: true, mode: 0o700 })
  const db = path.join(DATA, 'clawboo.db')
  if (!fs.existsSync(db))
    execFileSync('sqlite3', [db, 'create table t(x); insert into t values (1);'])
  const key = path.join(DATA, 'secrets', 'master.key')
  fs.writeFileSync(key, 'a'.repeat(44), { mode: 0o600 })
  const vault = path.join(DATA, 'secrets', 'runtime-keys.json')
  fs.writeFileSync(vault, '{}', { mode: 0o600 })
  fs.writeFileSync(path.join(DATA, 'settings.json'), '{}', { mode: 0o600 })
  // Wider than it should be: the check narrows it.
  fs.chmodSync(db, 0o644)
  // State a runtime left in the data folder before isolation, with a planted
  // link to the key, for the one-time copy.
  const home = path.join(DATA, 'runtimes', 'hermes', 'a1')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'MEMORY.md'), 'remember')
  fs.rmSync(path.join(home, 'key-link'), { force: true })
  fs.symlinkSync(key, path.join(home, 'key-link'))
  return { db, key, vault }
}

/** Run a command as the agent user through the seam; resolve with its stdout. */
function runAsAgent(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawnAgentProcess({
      kind: 'runtime',
      command,
      args,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: buildChildEnv(opts.env ?? {}),
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => resolve({ code: -1, out, err: err + e.message }))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

/** The agent user's live processes (a killed one not yet reaped is a zombie, not alive). */
function agentProcesses(): string[] {
  const r = spawnSync('ps', ['-u', String(AGENT_UID), '-o', 'pid=,stat=,comm='], {
    encoding: 'utf8',
  })
  return (r.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !/^\d+\s+Z/.test(s))
}

async function main(): Promise<void> {
  const files = makeDataFolder()
  const probeEnv = {
    PROOF_DB: files.db,
    PROOF_KEY: files.key,
    PROOF_VAULT: files.vault,
    PROOF_DATA: DATA,
  }

  const report = await startAgentUser({
    log,
    accessToken: process.env['STUDIO_ACCESS_TOKEN'] ?? null,
    secretValues: [process.env['STUDIO_ACCESS_TOKEN'] ?? '', 'a'.repeat(44)].filter(Boolean),
    runtimeBinaries: [{ runtime: 'node', path: process.execPath }],
  })

  if (mode === 'socket-hardlink') {
    const failed = report.steps.find((s) => s.level === 'fail')
    // Seen from either side: the database has a second link (step 4), or a
    // file in the work folder is one (step 7).
    check(
      'a hard link to the database in the work folder makes the check refuse',
      !report.ok &&
        (failed?.step === 4 || failed?.step === 7) &&
        /hard link/.test(failed?.message ?? ''),
      report.steps,
    )
    process.exit(failures)
  }

  if (mode === 'refuse') {
    const failed = report.steps.find((s) => s.level === 'fail')
    check(
      'without the sudoers rule the check refuses at step 5',
      !report.ok && failed?.step === 5,
      report.steps,
    )
    check(
      'the refusal prints the sudoers lines to add',
      !!failed?.message.includes('clawboo ALL=(clawboo-agent) NOPASSWD: ALL'),
      failed?.message,
    )
    process.exit(failures)
  }

  check('the startup check passes', report.ok, report.steps)
  if (!report.ok) process.exit(failures + 1)
  if (mode === 'socket-hostdeath') {
    process.stdout.write('READY\n')
    // The watchdog exits this process once run.sh kills the host.
    await new Promise(() => undefined)
  }
  const host = peekAgentHost()!
  check('the agent host runs as clawboo-agent', host.hello.uid === AGENT_UID, host.hello)
  check(
    'the data folder and the database were narrowed',
    (fs.statSync(DATA).mode & 0o777) === 0o700 && (fs.statSync(files.db).mode & 0o777) === 0o600,
    {
      data: (fs.statSync(DATA).mode & 0o777).toString(8),
      db: (fs.statSync(files.db).mode & 0o777).toString(8),
    },
  )
  const work = process.env['CLAWBOO_WORK_DIR'] ?? ''
  check('the work folder is the agent user one', work.length > 0, work)
  check('the server itself cannot read the work folder', !canList(work), work)

  // A runtime, through the seam, from a team folder.
  const team = path.join(work, 'teams', 'team-1')
  await (await import('../../apps/web/server/lib/agentUser/agentFs')).agentMkdir(team)
  const st = await agentStat(team)
  check('a team folder is owned by the agent user', st?.uid === AGENT_UID, st)
  const r = await runAsAgent(FAKE, [], { cwd: team, env: probeEnv })
  const seen = parse(r.out)
  check('a runtime runs as the agent user', seen?.uid === AGENT_UID, r)
  check(
    'it cannot read the database, the key or the vault',
    seen?.db === 'EACCES' && seen?.key === 'EACCES' && seen?.vault === 'EACCES',
    seen,
  )
  check('it cannot list the data folder', seen?.dataList === 'EACCES', seen)

  // The issue's reproduction, from the team folder.
  const repro = await runAsAgent(
    '/bin/sh',
    [
      '-c',
      `ls ../.. >/dev/null 2>&1; ls ${DATA} 2>&1; head -c 8 ${files.key} 2>&1; sqlite3 ${files.db} 'select * from t' 2>&1; echo done`,
    ],
    { cwd: team },
  )
  check(
    "the issue's reproduction fails on every step",
    /Permission denied/.test(repro.out) &&
      !repro.out.includes('aaaaaaaa') &&
      !/^1$/m.test(repro.out),
    repro.out,
  )

  // No agent process can gain another user through a setuid program.
  const nnp = await runAsAgent('/bin/sh', ['-c', 'grep NoNewPrivs /proc/self/status'])
  check('agent processes run with no_new_privs', /NoNewPrivs:\s*1/.test(nnp.out), nnp.out)

  // The server's environment is not visible to the agent user.
  const env = await runAsAgent('/bin/sh', [
    '-c',
    `cat /proc/${process.pid}/environ 2>&1 | head -c 200`,
  ])
  check(
    '/proc/<server pid>/environ is unreadable to the agent',
    /Permission denied/.test(env.out),
    env.out,
  )

  // Agents keep their tools: HTTP on loopback works across users.
  const server = http.createServer((req, res) => {
    res.writeHead(req.headers['authorization'] === 'Bearer attach-token' ? 200 : 401)
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const reach = await runAsAgent(process.execPath, [
    '-e',
    `fetch('http://127.0.0.1:${port}/api/mcp/tasks',{headers:{authorization:'Bearer attach-token'}}).then(r=>console.log(r.status)).catch(e=>console.log(e.message))`,
  ])
  server.close()
  check(
    'the agent user reaches a loopback HTTP server (the MCP spine)',
    reach.out.trim() === '200',
    reach,
  )

  // Task checkouts through an agent-owned mirror.
  const repo = '/home/clawboo/repo'
  fs.mkdirSync(repo, { recursive: true })
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'p',
    GIT_AUTHOR_EMAIL: 'p@example.com',
    GIT_COMMITTER_NAME: 'p',
    GIT_COMMITTER_EMAIL: 'p@example.com',
  }
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv })
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  execFileSync('git', ['-C', repo, 'add', '.'], { env: gitEnv })
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'a'], { env: gitEnv })
  const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const mirror = await syncMirror(repo, base)
  const mst = await agentStat(mirror)
  check('the mirror is owned by the agent user', mst?.uid === AGENT_UID, mst)
  const wt = path.join(work, 'worktrees', 'p', 'task-1')
  await runAgentGit(['-C', mirror, 'worktree', 'add', '--quiet', '-b', 'clawboo/task-1', wt, base])
  const commit = await runAsAgent(
    '/bin/sh',
    [
      '-c',
      'echo b > b.txt && git add . && git -c user.name=a -c user.email=a@example.com commit -q -m b && git rev-parse HEAD',
    ],
    { cwd: wt },
  )
  const tip = await exportTaskBranch(repo, 'clawboo/task-1', base)
  check(
    'the task branch comes out of the mirror into the user repository',
    tip === commit.out.trim(),
    { tip, commit },
  )
  check(
    "the user repository's own .git is not the agent's",
    !execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).includes(wt),
    wt,
  )

  // Every real spawn path (drivers, Native, the verify gate, connectors).
  await extraProofs({ check, probeEnv, team, fake: FAKE, agentUid: AGENT_UID })

  // Stopping: every agent process goes. Under the launcher that is the
  // launcher's job, which run.sh checks after this process exits.
  void runAsAgent('/bin/sh', ['-c', 'sleep 300 & sleep 300; wait'])
  if (mode === 'socket') {
    await new Promise((r) => setTimeout(r, 500))
    check(
      'agent processes are running before the stop',
      agentProcesses().length > 0,
      agentProcesses(),
    )
    process.exit(failures)
  }
  await new Promise((r) => setTimeout(r, 500))
  check(
    'agent processes are running before the stop',
    agentProcesses().length > 0,
    agentProcesses(),
  )
  stopAgentUser()
  await new Promise((r) => setTimeout(r, 1_000))
  check('no agent process survives the stop', agentProcesses().length === 0, agentProcesses())

  process.exit(failures)
}

function canList(dir: string): boolean {
  try {
    fs.readdirSync(dir)
    return true
  } catch {
    return false
  }
}

function parse(out: string): Record<string, unknown> | null {
  try {
    return JSON.parse(out.trim().split('\n').pop() ?? '') as Record<string, unknown>
  } catch {
    return null
  }
}

main().catch((err: unknown) => {
  process.stdout.write(
    `FAIL  the proof crashed: ${err instanceof Error ? err.stack : String(err)}\n`,
  )
  process.exit(failures + 1)
})
