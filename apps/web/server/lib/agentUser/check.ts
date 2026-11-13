// The startup check for agent isolation (CLAWBOO_AGENT_USER).
//
// Before any run is accepted, the server proves from inside the agent host
// that the agent user cannot open the database, the vault, the key, the
// settings or the access token file, cannot see the server's own environment,
// and holds no hard link to any of them. If it cannot prove that, it does not
// start. Each refusal says what to change.
//
// Everything that touches the machine is passed in (`CheckDeps`), so each
// refusal is tested with a fake host and a fake switch; the container test runs
// the same code against real users.

import fs from 'node:fs'
import path from 'node:path'

import type { AgentHostClient } from './client'
import type { AgentUserConfig } from './config'
import type { HelloFrame, InodeRef } from './protocol'

export type CheckLevel = 'ok' | 'warn' | 'fail'

export interface CheckStep {
  step: number
  name: string
  level: CheckLevel
  message: string
}

export interface CheckReport {
  ok: boolean
  steps: CheckStep[]
  /** The running host when every step passed (or only warned). */
  client: AgentHostClient | null
  hello: HelloFrame | null
  /** The work folder in use, once known. */
  workDir: string | null
  /** Runtime binaries the agent user cannot execute: shown, not refused. */
  unavailableRuntimes: { runtime: string; path: string; reason: string }[]
}

export interface UserRecord {
  uid: number
  gid: number
}

export interface CheckDeps {
  platform: NodeJS.Platform
  serverUid: number
  serverPid: number
  /** The server user's home (its listing should fail for the agent). */
  serverHome: string
  /** `id -u` / `id -g` for a name; null when there is no such user. */
  lookupUser(name: string): UserRecord | null
  /** The access token in force, or null when the gate is off. */
  accessToken: string | null
  dataDir: string
  /** The database and its sidecars, the vault, the key, settings, the token file. */
  protectedFiles: string[]
  /** The operator's own logins, which must not be readable either. */
  operatorFiles: string[]
  /**
   * The work folder the agents will use, once the host's identity is known (it
   * defaults to `<agent home>/work`). `create`: the host makes it if missing.
   */
  workDirFor(hello: HelloFrame): { dir: string; create: boolean }
  /** Values that must not appear in what the agent user can see of this process. */
  secretValues: string[]
  /** Runtime binaries to check the agent user can execute. */
  runtimeBinaries: { runtime: string; path: string }[]
  /** Narrow the data folder and its private files (step 4). Returns paths it changed. */
  narrowDataDir(dataDir: string, files: string[]): string[]
  /** Folders above the data folder that someone other than the server user or root can write. */
  unsafeParents(dataDir: string): string[]
  /** After narrowing: why the data folder or a private file is not the server's
   *  alone (not owned by it, not 0700, a private file with another hard link),
   *  or null. */
  dataDirProblem(dataDir: string, files: string[]): string | null
  /** Start (sudo, doas) or reach (socket) the host. Throws with the switch's own words on failure. */
  startHost(config: AgentUserConfig): Promise<AgentHostClient>
  /** Socket mode: the folder and socket owner and mode check. Null when fine. */
  socketProblem(socketPath: string, agentUid: number): string | null
  /** Called when the check fails after the host started, to stop it. */
  stopHost?(client: AgentHostClient): void
}

const sudoersLines = (serverUser: string, agentUser: string): string =>
  [
    `  # /etc/sudoers.d/clawboo (check it with: sudo visudo -cf /etc/sudoers.d/clawboo)`,
    `  ${serverUser} ALL=(${agentUser}) NOPASSWD: ALL`,
    `  Defaults:${serverUser} !requiretty`,
  ].join('\n')

/** Run steps 1 to 9 of the check, in order, stopping at the first failure. */
export async function runAgentUserCheck(
  config: AgentUserConfig,
  deps: CheckDeps,
  opts: { serverUser: string } = { serverUser: 'the user Clawboo runs as' },
): Promise<CheckReport> {
  const steps: CheckStep[] = []
  const report: CheckReport = {
    ok: false,
    steps,
    client: null,
    hello: null,
    workDir: null,
    unavailableRuntimes: [],
  }
  const pass = (step: number, name: string, message: string): void => {
    steps.push({ step, name, level: 'ok', message })
  }
  const warn = (step: number, name: string, message: string): void => {
    steps.push({ step, name, level: 'warn', message })
  }
  const fail = (step: number, name: string, message: string): CheckReport => {
    steps.push({ step, name, level: 'fail', message })
    if (report.client) {
      deps.stopHost?.(report.client)
      report.client = null
    }
    return report
  }
  const u = `CLAWBOO_AGENT_USER=${config.user}`

  // 1. Platform.
  if (deps.platform === 'win32') {
    return fail(
      1,
      'platform',
      'CLAWBOO_AGENT_USER is not supported on Windows. Unset it, or run Clawboo under WSL 2 or in a Linux container.',
    )
  }
  pass(1, 'platform', deps.platform)

  // 2. The user.
  const rec = deps.lookupUser(config.user)
  if (!rec) {
    return fail(
      2,
      'user',
      `${u}: no such user. Create it with the commands from \`clawboo agent-user plan\`.`,
    )
  }
  if (rec.uid === deps.serverUid) {
    return fail(2, 'user', `${u} is the user Clawboo runs as. Agents need a user of their own.`)
  }
  if (rec.uid === 0) return fail(2, 'user', `${u} is root. Agents need an unprivileged user.`)
  pass(2, 'user', `uid ${rec.uid}`)

  // 3. An access token.
  if (!deps.accessToken) {
    return fail(
      3,
      'access token',
      "Agent isolation needs an access token. Without one, any program on this computer, the agents included, can use Clawboo's API. Set STUDIO_ACCESS_TOKEN, or leave it unset to use the per-install token.",
    )
  }
  pass(3, 'access token', 'set')

  // 4. The data folder.
  const parents = deps.unsafeParents(deps.dataDir)
  if (parents.length > 0) {
    return fail(
      4,
      'data folder',
      `${parents[0]} can be changed by users other than the one Clawboo runs as, so the data folder inside it (${deps.dataDir}) cannot be protected. Move CLAWBOO_HOME somewhere only this user and root can change.`,
    )
  }
  const narrowed = deps.narrowDataDir(deps.dataDir, deps.protectedFiles)
  const ownership = deps.dataDirProblem(deps.dataDir, deps.protectedFiles)
  if (ownership) return fail(4, 'data folder', ownership)
  pass(4, 'data folder', narrowed.length > 0 ? `narrowed: ${narrowed.join(', ')}` : 'private')

  // 5. The switch. 6. Identity.
  if (config.socket) {
    const problem = deps.socketProblem(config.socket, rec.uid)
    if (problem) return fail(5, 'host socket', problem)
  }
  let client: AgentHostClient
  try {
    client = await deps.startHost(config)
    report.client = client
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    if (config.socket) {
      return fail(5, 'host socket', `Could not reach the agent host on ${config.socket}: ${why}`)
    }
    return fail(
      5,
      'switch',
      `Could not start the agent host as ${config.user} with ${config.switch} (${why}). ` +
        `Clawboo needs one ${config.switch} rule, written once by an administrator:\n${sudoersLines(opts.serverUser, config.user)}`,
    )
  }
  let hello: HelloFrame
  try {
    hello = await client.waitForHello()
  } catch (err) {
    // sudo and doas fail after they start (a missing rule, a password prompt
    // refused by -n), so their failure shows here rather than at the start.
    const why = errMsg(err)
    if (config.socket) {
      return fail(5, 'host socket', `The agent host did not answer on ${config.socket}: ${why}`)
    }
    return fail(
      5,
      'switch',
      `Could not start the agent host as ${config.user} with ${config.switch} (${why}). ` +
        `Clawboo needs one ${config.switch} rule, written once by an administrator:\n${sudoersLines(opts.serverUser, config.user)}`,
    )
  }
  pass(5, config.socket ? 'host socket' : 'switch', config.socket ? config.socket : config.switch)
  if (hello.uid !== rec.uid || hello.gid !== rec.gid) {
    return fail(
      6,
      'identity',
      `The agent host runs as uid ${hello.uid} gid ${hello.gid}, but ${config.user} is uid ${rec.uid} gid ${rec.gid}. Check the ${config.socket ? 'launcher' : config.switch} configuration.`,
    )
  }
  if (hello.uid === deps.serverUid || hello.uid === 0) {
    return fail(
      6,
      'identity',
      `The agent host runs as uid ${hello.uid}, which is not a separate unprivileged user.`,
    )
  }
  report.hello = hello
  pass(6, 'identity', `${hello.user} (uid ${hello.uid}), home ${hello.home}`)

  // The work folder: made by the host when it is the default under the agent's
  // home; one named by CLAWBOO_WORK_DIR must already be the agent's (checked below).
  const work = deps.workDirFor(hello)
  report.workDir = work.dir
  if (work.create) {
    try {
      await client.request({ op: 'fs.mkdir', path: work.dir, mode: 0o700 })
    } catch (err) {
      return fail(
        7,
        'work folder',
        `The agent user could not create the work folder ${work.dir}: ${errMsg(err)}`,
      )
    }
  }

  // 7. Canaries, as the agent user.
  const mustFail = [
    ...deps.protectedFiles.map((p) => ({ path: p, mode: 'read' as const })),
    { path: deps.dataDir, mode: 'list' as const },
    ...deps.operatorFiles.map((p) => ({ path: p, mode: 'read' as const })),
  ]
  const shouldFail = [{ path: deps.serverHome, mode: 'list' as const }]
  const mustPass = [{ path: work.dir, mode: 'write' as const }]
  let probe
  try {
    probe = await client.request({ op: 'probe', checks: [...mustFail, ...shouldFail, ...mustPass] })
  } catch (err) {
    return fail(7, 'canaries', `The agent host could not run the checks: ${errMsg(err)}`)
  }
  const results = Array.isArray(probe.results) ? probe.results : []
  const resultFor = (p: string, mode: string): { ok: boolean; code?: string } | undefined =>
    results.find((r) => r && r.path === p && r.mode === mode)
  for (const c of mustFail) {
    const r = resultFor(c.path, c.mode)
    // A missing answer counts as readable: the host is on the agents' side, and
    // silence must not pass for proof.
    if (!r || r.ok) {
      const fix = c.mode === 'list' ? `chmod 700 ${c.path}` : `chmod 600 ${c.path}`
      return fail(
        7,
        'canaries',
        `The agent user can read ${c.path}. Run \`${fix}\` (or \`chmod 700\` on its folder) and start Clawboo again.`,
      )
    }
  }
  for (const c of shouldFail) {
    const r = resultFor(c.path, c.mode)
    if (!r || r.ok) {
      warn(
        7,
        'home folder',
        `Agents can read any file in ${c.path} that other users can read, such as source code. Run \`chmod 750 ${c.path}\` (or 700).`,
      )
    }
  }
  for (const c of mustPass) {
    const r = resultFor(c.path, c.mode)
    if (!r || !r.ok) {
      return fail(
        7,
        'work folder',
        `The agent user cannot create files in the work folder ${c.path} (${r?.code ?? 'no answer'}). It must be owned by ${config.user}: run \`install -d -o ${config.user} -m 700 ${c.path}\` as an administrator.`,
      )
    }
  }

  // What the agent user can see of this process.
  let view
  try {
    view = await client.request({ op: 'procView', pid: deps.serverPid })
  } catch (err) {
    return fail(
      7,
      'process view',
      `The agent host could not look at the server process: ${errMsg(err)}`,
    )
  }
  if (deps.platform === 'linux' && (!view.environ || view.environ.ok !== false)) {
    return fail(
      7,
      'process view',
      `The agent user can read this server's environment (/proc/${deps.serverPid}/environ). Agents must run as a different user from the server.`,
    )
  }
  const visible = [view.environ?.text, view.cmdline?.text, view.psEnv?.text].filter(
    (t): t is string => typeof t === 'string',
  )
  const leaked = deps.secretValues.filter(
    (s) => s.length >= 8 && visible.some((t) => t.includes(s)),
  )
  if (leaked.length > 0) {
    return fail(
      7,
      'process view',
      `The agent user can see ${leaked.length === 1 ? 'a secret' : `${leaked.length} secrets`} in this server's command line or environment. Pass secrets in files or in the environment of a server running as another user, never as command-line arguments.`,
    )
  }

  // Hard links to protected files planted under the work folder while agents
  // still ran as the server's user.
  const targets: InodeRef[] = []
  for (const p of deps.protectedFiles) {
    try {
      const st = fs.statSync(p, { bigint: true })
      targets.push({ dev: String(st.dev), ino: String(st.ino) })
    } catch {
      /* not there: nothing to link to */
    }
  }
  // Always searched, even with no private file yet: besides hard links to the
  // private files, a setuid or setgid file someone else owns would run as that
  // someone for an agent (one an agent made while it ran as the server's user).
  {
    let found
    try {
      found = await client.request(
        { op: 'inodes', root: work.dir, targets, maxEntries: 2_000_000 },
        { timeoutMs: 300_000 },
      )
    } catch (err) {
      return fail(
        7,
        'hard links',
        `The agent host could not search the work folder: ${errMsg(err)}`,
      )
    }
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((m): m is string => typeof m === 'string') : []
    const matches = strings(found.matches)
    if (matches.length > 0) {
      return fail(
        7,
        'hard links',
        `${matches[0]} is a hard link to one of Clawboo's private files. Remove it (as an administrator) and start Clawboo again.`,
      )
    }
    const privileged = strings(found.privileged)
    if (privileged.length > 0) {
      return fail(
        7,
        'setuid files',
        `${privileged[0]} is a setuid or setgid file that would give an agent another user's or group's rights. Remove it, or run \`chmod ug-s\` on it as an administrator, and start Clawboo again.`,
      )
    }
    // A folder the search could not enter may hold either kind, and
    // no_new_privs does nothing for a hard link: refused whatever the host says.
    const unreadable = strings(found.unreadable)
    if (unreadable.length > 0) {
      return fail(
        7,
        'hard links',
        `${config.user} cannot search ${unreadable[0]} in the work folder, so it could not be checked for hard links to Clawboo's private files or setuid files. Let ${config.user} read and enter it (\`chmod u+rx\` as its owner), or move it out of the work folder, and start Clawboo again.`,
      )
    }
    if (found.truncated) {
      // A setuid file past the end of the search would still work for an
      // agent, unless the host runs with no_new_privs.
      if (found.noNewPrivs !== true) {
        return fail(
          7,
          'setuid files',
          `The work folder ${work.dir} is too large to search completely for setuid files. Remove task checkouts you no longer need from it${deps.platform === 'linux' ? ', or install setpriv (util-linux) so the agent host runs with no_new_privs,' : ''} and start Clawboo again.`,
        )
      }
      warn(
        7,
        'hard links',
        `The work folder ${work.dir} is too large to search completely for hard links.`,
      )
    }
  }
  pass(
    7,
    'canaries',
    'the agent user cannot read the data folder, the vault, the key, settings or the token',
  )

  // 8. No way for the agent user to become anyone else: actually tried, as the
  // agent user, and sudo's listing read as well. A sudoers default can hide the
  // listing while the rules still work, and a rule for one command (a shell as
  // the server user) shows only in the listing.
  let priv
  try {
    priv = await client.request(
      { op: 'privCheck', serverUser: opts.serverUser },
      { timeoutMs: 60_000 },
    )
  } catch (err) {
    return fail(8, 'agent privileges', `The agent host could not run the checks: ${errMsg(err)}`)
  }
  const attempts = Array.isArray(priv.attempts) ? priv.attempts : []
  if (attempts.length === 0) {
    return fail(8, 'agent privileges', 'The agent host sent no answer to the checks.')
  }
  const escalation = attempts.find((a) => a && a.succeeded === true)
  if (escalation) {
    return fail(
      8,
      'agent privileges',
      `${escalation.what === 'sudo -l' ? `${config.user} has sudo rules it can use without a password` : `${config.user} can run \`${String(escalation.what)}\``}. The agent user must not be able to become any other user: remove its sudo and doas rules (\`sudo -l -U ${config.user}\` lists sudo's).`,
    )
  }
  if (priv.crontab === 'allowed') {
    warn(
      8,
      'scheduled jobs',
      `${config.user} may schedule its own jobs with crontab, which would run after Clawboo stops its agents. Add ${config.user} to /etc/cron.deny and /etc/at.deny.`,
    )
  }
  pass(8, 'agent privileges', 'none')

  // 9. Runtime binaries: shown, not refused.
  if (deps.runtimeBinaries.length > 0) {
    try {
      const res = await client.request({
        op: 'canExec',
        paths: deps.runtimeBinaries.map((b) => b.path),
      })
      const out = Array.isArray(res.results) ? res.results : []
      for (const b of deps.runtimeBinaries) {
        const r = out.find((x) => x && x.path === b.path)
        if (r && r.ok) continue
        const reason = `${b.path} is not available to ${config.user} (${r?.code ?? 'no answer'}). Install it where every user can run it, such as /usr/local or /opt.`
        report.unavailableRuntimes.push({ runtime: b.runtime, path: b.path, reason })
        warn(9, 'runtime binaries', `${b.runtime}: ${reason}`)
      }
    } catch (err) {
      warn(9, 'runtime binaries', `could not check: ${errMsg(err)}`)
    }
  }
  if (report.unavailableRuntimes.length === 0) pass(9, 'runtime binaries', 'available')

  report.ok = true
  return report
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Real implementations of the machine-touching deps ────────────────────

/**
 * Give the data folder 0700 and each private file in it 0600 when wider.
 * Only files the server owns are changed. Returns the paths it changed.
 */
export function narrowDataDir(dataDir: string, files: string[]): string[] {
  const changed: string[] = []
  // A first start: the folder is made here, private from the start, so the
  // checks below have the folder the server is about to use.
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  } catch {
    /* reported by the ownership check that follows */
  }
  const narrow = (p: string, mode: number): void => {
    try {
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) return
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return
      if ((st.mode & 0o777 & ~mode) !== 0) {
        fs.chmodSync(p, mode)
        changed.push(p)
      }
    } catch {
      /* missing: nothing to narrow */
    }
  }
  narrow(dataDir, 0o700)
  const dirs = new Set<string>()
  for (const f of files) {
    const dir = path.dirname(f)
    if (dir !== dataDir && dir.startsWith(dataDir + path.sep)) dirs.add(dir)
  }
  for (const d of dirs) narrow(d, 0o700)
  for (const f of files) narrow(f, 0o600)
  return changed
}

/**
 * Folders from the data folder up to `/` that a user other than this one (or
 * root) could change: one of them could have the data folder swapped out from
 * under the server. Group-writable counts (the group's other members can), and
 * so does a sticky world-writable folder such as `/tmp`, which is no place for
 * private data shared with nobody.
 */
export function unsafeParents(dataDir: string): string[] {
  const out: string[] = []
  const me = typeof process.getuid === 'function' ? process.getuid() : -1
  let cur = path.resolve(dataDir)
  for (;;) {
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
    try {
      const st = fs.statSync(cur)
      const ownerOk = st.uid === me || st.uid === 0
      const othersWrite = (st.mode & 0o002) !== 0
      const groupWrite = (st.mode & 0o020) !== 0
      if (!ownerOk || othersWrite || groupWrite) out.push(cur)
    } catch {
      /* unreadable parent: nothing to judge */
    }
  }
  return out
}

/**
 * The data folder, by its real path, must be a folder owned by this process's
 * user with mode 0700, and no private file may have a second hard link (a name
 * elsewhere, possibly in agent space, for the same file). Null when it holds.
 */
export function dataDirProblem(dataDir: string, files: string[]): string | null {
  const me = typeof process.getuid === 'function' ? process.getuid() : -1
  let real: string
  try {
    real = fs.realpathSync(dataDir)
  } catch {
    return `The data folder ${dataDir} cannot be read.`
  }
  const st = fs.statSync(real)
  if (!st.isDirectory()) return `The data folder ${dataDir} is not a folder.`
  if (st.uid !== me) {
    return `The data folder ${real} belongs to uid ${st.uid}, not the user Clawboo runs as. Give it to that user (\`chown -R\`).`
  }
  if ((st.mode & 0o777) !== 0o700) {
    return `The data folder ${real} has mode ${(st.mode & 0o777).toString(8)}. Run \`chmod 700 ${real}\`.`
  }
  for (const f of files) {
    let fst: fs.Stats
    try {
      fst = fs.lstatSync(f)
    } catch {
      continue
    }
    if (fst.isSymbolicLink()) return `${f} is a link. Clawboo's private files must be plain files.`
    if (fst.isFile() && fst.nlink > 1) {
      return `${f} has another hard link somewhere, which could give another user its contents. Find it with \`find / -samefile ${f}\`, remove it, and start Clawboo again.`
    }
  }
  return null
}
