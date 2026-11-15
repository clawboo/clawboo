// A user per agent (CLAWBOO_AGENT_USERS), proven end to end inside a Linux
// container with real users. Bundled by run.sh and run in the container as the
// server user (`clawboo`, uid 10001). The pool is clawboo-a1, a2 and a3 (uids
// 20001 to 20003, each with a group of its own); the team groups are clawboo-t1
// and clawboo-t2.
//
// Agents A and B are on team T1, agent C on team T2. Each check runs a real
// process through the spawn seam as one agent, against what another agent's
// host made:
//   - each agent runs as its own user, with its team's group;
//   - A cannot list B's home, read B's runtime home, B's browser profile or
//     B's display folder, or connect to B's display socket;
//   - A cannot signal B's process;
//   - a file A writes in their team folder is read and changed by B, one A
//     makes private (0600) is not, and C (another team) reaches neither;
//   - stopping A's host stops A's processes and nobody else's;
//   - stopping the pool leaves no process of any pool user.
//
//   node pool-proof.cjs          the proof above
//   node pool-proof.cjs refuse   a pool user's home is open: the check refuses
//
// Each check prints PASS or FAIL; the exit code is the number of failures.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { agentMkdir, agentWriteFile } from '../../apps/web/server/lib/agentUser/agentFs'
import {
  releaseDeleted,
  releasesSettled,
  startAgentPool,
  stopAgentPool,
} from '../../apps/web/server/lib/agentUser/poolBoot'
import { runAssignmentPass } from '../../apps/web/server/lib/agentUser/poolAssignments'
import { peekAgentPool } from '../../apps/web/server/lib/agentUser/state'
import { profileDirFor } from '../../apps/web/server/lib/connectors/agentBrowsers'
import { getDb } from '../../apps/web/server/lib/db'
import { displayDirFor } from '../../apps/web/server/lib/desktop/displays'
import { buildChildEnv } from '../../apps/web/server/lib/runtimes/childEnv'
import { runtimeIdentityHomePath } from '../../apps/web/server/lib/runtimes/identityHome'
import { spawnAgentProcess } from '../../apps/web/server/lib/runtimes/spawner'
import { taskRunWorkdirFor } from '../../apps/web/server/lib/runtimes/teamWorkdir'

const mode = process.argv[2] ?? 'proof'
const DATA = process.env['CLAWBOO_HOME'] ?? '/home/clawboo/.clawboo'
const POOL_UIDS = [20001, 20002, 20003]
let failures = 0

function check(name: string, ok: boolean, detail: unknown): void {
  if (!ok) failures++
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(detail)}`}\n`,
  )
}

const log = {
  info: () => undefined,
  warn: (o: unknown, m?: string) =>
    process.stdout.write(`warn  ${m ? `${m} ${JSON.stringify(o)}` : JSON.stringify(o)}\n`),
  error: (o: unknown, m?: string) =>
    process.stdout.write(`error ${m ? `${m} ${JSON.stringify(o)}` : JSON.stringify(o)}\n`),
}

function makeDataFolder(): void {
  fs.mkdirSync(path.join(DATA, 'secrets'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(DATA, 'secrets', 'master.key'), 'k'.repeat(44), { mode: 0o600 })
  fs.writeFileSync(path.join(DATA, 'secrets', 'runtime-keys.json'), '{}', { mode: 0o600 })
  fs.writeFileSync(path.join(DATA, 'settings.json'), '{}', { mode: 0o600 })
}

/** Run a command as `agentId`'s user; resolve with what it printed. */
function runAs(
  agentId: string,
  command: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawnAgentProcess({
      kind: 'runtime',
      agentId,
      command,
      args,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: buildChildEnv({}),
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => resolve({ code: -1, out, err: err + e.message }))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

/** Live (not zombie) processes of the pool users. */
function poolProcesses(uids: number[] = POOL_UIDS): string[] {
  const r = spawnSync('ps', ['-u', uids.join(','), '-o', 'pid=,stat=,user=,comm='], {
    encoding: 'utf8',
  })
  return (r.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !/^\d+\s+Z/.test(s))
}

async function main(): Promise<void> {
  makeDataFolder()
  // Through the server's own connection (this folder has no packages of its own).
  const sql = getDb().$client
  const now = Date.now()
  for (const id of ['T1', 'T2']) {
    sql
      .prepare(
        'INSERT INTO teams (id, name, icon, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, id, 'x', '#000', now, now)
  }
  for (const [id, teamId, at] of [
    ['A', 'T1', 1],
    ['B', 'T1', 2],
    ['C', 'T2', 3],
  ] as const) {
    sql
      .prepare(
        "INSERT INTO agents (id, name, gateway_id, runtime, team_id, created_at, updated_at) VALUES (?, ?, ?, 'codex', ?, ?, ?)",
      )
      .run(id, id, id, teamId, at, at)
  }

  const report = await startAgentPool({
    log,
    accessToken: process.env['STUDIO_ACCESS_TOKEN'] ?? null,
    secretValues: [process.env['STUDIO_ACCESS_TOKEN'] ?? '', 'k'.repeat(44)].filter(Boolean),
    runtimeBinaries: [{ runtime: 'node', path: process.execPath }],
  })

  if (mode === 'refuse') {
    const failed = report.steps.find((s) => s.level === 'fail')
    check(
      'an agent user whose home another can list makes the check refuse',
      !report.ok && /another agent user's home/.test(failed?.message ?? ''),
      report.steps,
    )
    process.exit(failures)
  }

  check(
    'the pool check passes',
    report.ok,
    report.steps.filter((s) => s.level !== 'ok'),
  )
  if (!report.ok) process.exit(failures)

  // Each agent as its own user, with its team's group.
  for (const [agent, uid, gid] of [
    ['A', 20001, 21001],
    ['B', 20002, 21001],
    ['C', 20003, 21002],
  ] as const) {
    const r = await runAs(agent, 'id', ['-u'])
    const g = await runAs(agent, 'id', ['-g'])
    const all = await runAs(agent, 'id', ['-G'])
    const groups = all.out.trim().split(/\s+/).map(Number).sort()
    check(
      `agent ${agent} runs as uid ${uid} with its team's group ${gid} and its own, nothing else`,
      r.out.trim() === String(uid) &&
        g.out.trim() === String(gid) &&
        JSON.stringify(groups) === JSON.stringify([uid, gid].sort()),
      { uid: r.out, gid: g.out, groups: all.out, err: r.err },
    )
  }

  // B's own things, made through B's host.
  const bRuntime = runtimeIdentityHomePath('codex', 'B')
  await agentMkdir(bRuntime)
  await agentWriteFile(path.join(bRuntime, 'auth.json'), '{"tokens":{"access_token":"b-secret"}}')
  const bProfile = profileDirFor('playwright', 'B', true)
  await agentMkdir(path.join(bProfile, 'Default'))
  await agentWriteFile(path.join(bProfile, 'Default', 'Cookies'), 'b-cookie')
  const bDisplay = displayDirFor('B', true)
  await agentMkdir(bDisplay)
  await agentWriteFile(path.join(bDisplay, 'Xauthority'), 'b-cookie-for-x')
  const bHome = path.dirname(path.dirname(path.dirname(bRuntime)))

  const ls = await runAs('A', 'ls', [bHome])
  check("A cannot list B's home", ls.code !== 0 && /Permission denied/.test(ls.err), ls)
  for (const [what, file] of [
    ["B's runtime home", path.join(bRuntime, 'auth.json')],
    ["B's browser profile", path.join(bProfile, 'Default', 'Cookies')],
    ["B's display cookie", path.join(bDisplay, 'Xauthority')],
  ] as const) {
    const r = await runAs('A', 'cat', [file])
    check(`A cannot read ${what}`, r.code !== 0 && !r.out.includes('b-'), r)
  }
  const bOwn = await runAs('B', 'cat', [path.join(bRuntime, 'auth.json')])
  check('B reads its own runtime home', bOwn.code === 0 && bOwn.out.includes('b-secret'), bOwn)

  // B's display socket: a listener of B's in B's display folder.
  const sock = path.join(bDisplay, 'vnc.sock')
  const listener = spawnAgentProcess({
    kind: 'browser',
    agentId: 'B',
    command: process.execPath,
    args: [
      '-e',
      `require('net').createServer(s=>s.end('rfb')).listen(${JSON.stringify(sock)},()=>console.log('up'))`,
    ],
    env: buildChildEnv({}),
  })
  await new Promise<void>((resolve) => listener.stdout?.once('data', () => resolve()))
  const connectScript = `const s=require('net').connect(${JSON.stringify(sock)});s.on('data',d=>{console.log('got '+d);process.exit(0)});s.on('error',e=>{console.log(e.code);process.exit(1)})`
  const aConnect = await runAs('A', process.execPath, ['-e', connectScript])
  check(
    "A cannot connect to B's display socket",
    aConnect.code !== 0 && /EACCES/.test(aConnect.out),
    aConnect,
  )
  const bConnect = await runAs('B', process.execPath, ['-e', connectScript])
  check(
    'B connects to its own display socket',
    bConnect.code === 0 && /got rfb/.test(bConnect.out),
    bConnect,
  )

  // Signals.
  const sleeper = spawnAgentProcess({
    kind: 'runtime',
    agentId: 'B',
    command: 'sleep',
    args: ['60'],
    env: buildChildEnv({}),
  })
  await new Promise<void>((resolve) => sleeper.once('spawn', () => resolve()))
  const pid = sleeper.pid!
  const aKill = await runAs('A', 'kill', ['-0', String(pid)])
  check("A cannot signal B's process", aKill.code !== 0 && /not permitted/i.test(aKill.err), aKill)
  const bKill = await runAs('B', 'kill', ['-0', String(pid)])
  check('B signals its own process', bKill.code === 0, bKill)

  // The team folder of T1, shared by A and B through T1's group.
  const t1 = taskRunWorkdirFor('codex', 'T1', process.env, 'A')!
  await agentMkdir(t1)
  const st = fs.lstatSync(t1)
  check(
    "T1's folder is the server's, with T1's group, 2770",
    st.uid === 10001 && st.gid === 21001 && (st.mode & 0o7777) === 0o2770,
    { uid: st.uid, gid: st.gid, mode: (st.mode & 0o7777).toString(8) },
  )
  const acl = execFileSync('getfacl', ['-p', t1], { encoding: 'utf8' })
  check(
    "T1's folder passes T1's group on to everything made in it",
    /default:group:clawboo-t1:rwx/.test(acl),
    acl,
  )
  const write = await runAs(
    'A',
    'sh',
    [
      '-c',
      "umask 077; echo shared > notes.txt; node -e \"require('fs').writeFileSync('private.txt','p',{mode:0o600})\"",
    ],
    { cwd: t1 },
  )
  check('A writes in the team folder', write.code === 0, write)
  const bRead = await runAs('B', 'cat', [path.join(t1, 'notes.txt')])
  check(
    'B reads what A wrote in their team folder',
    bRead.code === 0 && bRead.out.trim() === 'shared',
    bRead,
  )
  const bAppend = await runAs('B', 'sh', [
    '-c',
    `echo more >> ${JSON.stringify(path.join(t1, 'notes.txt'))}`,
  ])
  check('B changes it', bAppend.code === 0, bAppend)
  const bPrivate = await runAs('B', 'cat', [path.join(t1, 'private.txt')])
  check('B cannot read a file A made private', bPrivate.code !== 0, bPrivate)
  const cList = await runAs('C', 'ls', [t1])
  check(
    "C (another team) cannot list T1's folder",
    cList.code !== 0 && /Permission denied/.test(cList.err),
    cList,
  )
  const cRead = await runAs('C', 'cat', [path.join(t1, 'notes.txt')])
  check("C cannot read T1's notes", cRead.code !== 0, cRead)
  const aHomeFromB = await runAs('B', 'ls', [
    path.dirname(path.dirname(path.dirname(runtimeIdentityHomePath('codex', 'A')))),
  ])
  check("B cannot list A's home, though they share a team", aHomeFromB.code !== 0, aHomeFromB)

  // A deleted agent's user is wiped before the next agent gets it, and a
  // deleted team's folder is gone before its group is handed out again.
  const t2 = taskRunWorkdirFor('codex', 'T2', process.env, 'C')!
  await agentMkdir(t2)
  const cRuntime = runtimeIdentityHomePath('codex', 'C')
  await agentMkdir(cRuntime)
  await agentWriteFile(path.join(cRuntime, 'auth.json'), 'c-secret')
  const cLeft = await runAs('C', 'sh', [
    '-c',
    `echo c-left > ${JSON.stringify(path.join(t2, 'team-notes.txt'))}; echo c-tmp > /tmp/c-left`,
  ])
  check('C leaves files in its home, its team folder and /tmp', cLeft.code === 0, cLeft)
  sql.prepare("DELETE FROM agents WHERE id = 'C'").run()
  sql.prepare("DELETE FROM teams WHERE id = 'T2'").run()
  await releaseDeleted()
  await releasesSettled()
  check("the deleted team's folder is gone", !fs.existsSync(t2), t2)
  const groupState = sql
    .prepare("SELECT state FROM team_os_groups WHERE group_name = 'clawboo-t2'")
    .get() as { state: string } | undefined
  check("the deleted team's group is free again", groupState?.state === 'free', groupState)
  sql
    .prepare(
      "INSERT INTO agents (id, name, gateway_id, runtime, team_id, created_at, updated_at) VALUES ('D', 'D', 'D', 'codex', NULL, 4, 4)",
    )
    .run()
  runAssignmentPass()
  const dId = await runAs('D', 'id', ['-u'])
  check("the next agent gets the deleted agent's user", dId.out.trim() === '20003', dId)
  const dOld = await runAs('D', 'cat', [path.join(cRuntime, 'auth.json')])
  check(
    "and none of the deleted agent's files",
    dOld.code !== 0 && !dOld.out.includes('c-secret'),
    dOld,
  )
  const dTmp = await runAs('D', 'cat', ['/tmp/c-left'])
  check('not even its files in /tmp', dTmp.code !== 0, dTmp)
  const dHome = await runAs('D', 'sh', ['-c', 'ls -A "$HOME"'])
  check('its home starts empty', dHome.code === 0 && dHome.out.trim() === '', dHome)

  // Stopping one agent's host stops that agent only.
  const aSleep = spawnAgentProcess({
    kind: 'runtime',
    agentId: 'A',
    command: 'sleep',
    args: ['60'],
    env: buildChildEnv({}),
  })
  await new Promise<void>((resolve) => aSleep.once('spawn', () => resolve()))
  const pool = peekAgentPool()!
  pool.close('clawboo-a1', 'proof')
  await pool.settled('clawboo-a1')
  await new Promise((r) => setTimeout(r, 300))
  check(
    "stopping A's host leaves no process of A",
    poolProcesses([20001]).length === 0,
    poolProcesses([20001]),
  )
  check(
    "and B's process runs on",
    poolProcesses([20002]).some((p) => / sleep$/.test(p)),
    poolProcesses([20002]),
  )

  stopAgentPool()
  await new Promise((r) => setTimeout(r, 300))
  check(
    'stopping the pool leaves no process of any pool user',
    poolProcesses().length === 0,
    poolProcesses(),
  )
  process.exit(failures)
}

main().catch((err: unknown) => {
  process.stdout.write(
    `FAIL  the pool proof threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  )
  process.exit(failures + 1)
})
