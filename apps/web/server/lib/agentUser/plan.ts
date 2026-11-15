// `clawboo agent-user plan`: the commands an administrator runs once to set up
// the agent user. Clawboo never runs privileged commands itself; it prints them.
//
// The macOS commands follow `sysadminctl`'s own usage text on macOS 26: a role
// account needs a name starting with `_` and a UID from 450 to 499, so the plan
// picks one that is free on this computer.

import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export interface PlanInput {
  platform: NodeJS.Platform
  /** The user Clawboo runs as. */
  serverUser: string
  /** The agent user to create. */
  agentUser: string
  /** The agent user's home. */
  agentHome: string
  /** macOS: a free UID and GID in the role-account range. */
  roleId: number | null
  /** The Node that runs Clawboo, to warn when the agent user cannot reach it. */
  nodePath: string
  /** The server user's home. */
  serverHome: string
}

/** The defaults for this computer. */
export function planInputForThisComputer(agentUser?: string): PlanInput {
  const platform = process.platform
  const mac = platform === 'darwin'
  const name = agentUser?.trim() || (mac ? '_clawboo' : 'clawboo-agent')
  return {
    platform,
    serverUser: os.userInfo().username,
    agentUser: name,
    agentHome: mac ? '/var/clawboo-agent' : '/var/lib/clawboo-agent',
    roleId: mac ? freeRoleId() : null,
    nodePath: process.execPath,
    serverHome: os.homedir(),
  }
}

/** A UID and GID from 450 to 499 that no user or group uses (macOS). */
function freeRoleId(): number | null {
  const used = new Set<number>()
  for (const [kind, attr] of [
    ['/Users', 'UniqueID'],
    ['/Groups', 'PrimaryGroupID'],
  ] as const) {
    try {
      const out = execFileSync('dscl', ['.', '-list', kind, attr], {
        encoding: 'utf8',
        timeout: 10_000,
      })
      for (const line of out.split('\n')) {
        const n = Number(line.trim().split(/\s+/).pop())
        if (Number.isInteger(n)) used.add(n)
      }
    } catch {
      return null
    }
  }
  for (let id = 499; id >= 450; id--) if (!used.has(id)) return id
  return null
}

/** The plan, as text to print. */
export function agentUserPlan(p: PlanInput): string {
  if (p.platform === 'win32') {
    return [
      'Agent isolation (CLAWBOO_AGENT_USER) is not supported on Windows.',
      'Run Clawboo under WSL 2 or in a Linux container to use it.',
    ].join('\n')
  }
  const u = p.agentUser
  const home = p.agentHome
  const work = path.posix.join(home, 'work')
  const lines: string[] = [
    `# Agent isolation: run agents as the user ${u}, apart from ${p.serverUser}.`,
    '# Run these once, as an administrator. Clawboo never runs them itself.',
    '',
  ]
  if (p.platform === 'darwin') {
    const id = p.roleId ?? 499
    if (p.roleId === null) {
      lines.push(
        '# Could not list the used IDs. Pick a UID and GID from 450 to 499 that',
        '# `dscl . -list /Users UniqueID` and `dscl . -list /Groups PrimaryGroupID` do not show.',
      )
    }
    lines.push(
      '# 1. A role account with a group of its own (not staff), and no password.',
      `sudo dscl . -create /Groups/${u}`,
      `sudo dscl . -create /Groups/${u} PrimaryGroupID ${id}`,
      `sudo dscl . -create /Groups/${u} RealName "Clawboo agents"`,
      `sudo sysadminctl -addUser ${u} -fullName "Clawboo agents" -UID ${id} -GID ${id} -roleAccount -shell /bin/zsh -home ${home}`,
      `sudo install -d -o ${u} -g ${u} -m 700 ${home} ${work}`,
      '',
      `# 2. Let ${p.serverUser} start processes as ${u}, and nothing else.`,
      `printf '%s\\n' '${p.serverUser} ALL=(${u}) NOPASSWD: ALL' 'Defaults:${p.serverUser} !requiretty' | sudo tee /private/etc/sudoers.d/clawboo >/dev/null`,
      'sudo chmod 440 /private/etc/sudoers.d/clawboo',
      'sudo visudo -c',
      '',
      `# 3. Keep ${u} out of your files (macOS homes are readable by the staff group),`,
      `#    and give it no jobs of its own that would run after Clawboo stops its agents.`,
      `chmod 750 ${p.serverHome}`,
      `echo ${u} | sudo tee -a /usr/lib/cron/cron.deny /usr/lib/cron/at.deny >/dev/null`,
    )
  } else {
    lines.push(
      '# 1. A system user with a group of its own and no password.',
      `sudo useradd --system --user-group --create-home --home-dir ${home} --shell /bin/bash ${u}`,
      `sudo passwd -l ${u}`,
      `sudo install -d -o ${u} -g ${u} -m 700 ${home} ${work}`,
      '',
      `# 2. Let ${p.serverUser} start processes as ${u}, and nothing else.`,
      `printf '%s\\n' '${p.serverUser} ALL=(${u}) NOPASSWD: ALL' 'Defaults:${p.serverUser} !requiretty' | sudo tee /etc/sudoers.d/clawboo >/dev/null`,
      'sudo chmod 440 /etc/sudoers.d/clawboo',
      'sudo visudo -cf /etc/sudoers.d/clawboo',
      '',
      `# 3. Per-user limits, so a runaway agent cannot exhaust the computer, and no`,
      `#    jobs of its own that would run after Clawboo stops its agents.`,
      `printf '%s\\n' '${u} hard nproc 4096' '${u} hard nofile 65536' | sudo tee /etc/security/limits.d/clawboo-agent.conf >/dev/null`,
      `echo ${u} | sudo tee -a /etc/cron.deny /etc/at.deny >/dev/null`,
      '',
      `# 4. Keep ${u} out of your files.`,
      `chmod 750 ${p.serverHome}`,
    )
  }
  lines.push('')
  // The plan is for macOS and Linux, so their separator, whatever this host's.
  if (p.nodePath.startsWith(p.serverHome + path.posix.sep)) {
    lines.push(
      `# Node runs from ${p.nodePath}, inside your home, where ${u} cannot reach it.`,
      '# Install Node, Clawboo and each runtime (Claude Code, Codex, Hermes) where every',
      '# user can run them, such as /usr/local, /opt or Homebrew, and start Clawboo from there.',
      '',
    )
  }
  lines.push(
    '# Then check it, and start Clawboo with the setting:',
    `CLAWBOO_AGENT_USER=${u} clawboo agent-user check`,
    `CLAWBOO_AGENT_USER=${u} clawboo`,
    '',
    `# The agent user must belong to this Clawboo only: Clawboo stops every process`,
    `# ${u} runs when it starts and when it stops.`,
  )
  return lines.join('\n')
}

export interface PoolPlanInput {
  platform: NodeJS.Platform
  serverUser: string
  serverHome: string
  nodePath: string
  /** How many agent users, and team groups, to make. */
  users: number
  teams: number
  /** The first uid (and private gid) of the pool, and the first team gid. */
  firstUid: number
  firstTeamGid: number
}

/** `clawboo agent-user plan --pool <n> --teams <m>`: a user per agent. */
export function agentPoolPlan(p: PoolPlanInput): string {
  if (p.platform !== 'linux') {
    return [
      'A user per agent (CLAWBOO_AGENT_USERS) runs on Linux for now.',
      'On this computer use one agent user for every agent: `clawboo agent-user plan`.',
    ].join('\n')
  }
  const users = Array.from({ length: p.users }, (_, i) => `clawboo-a${i + 1}`)
  const teams = Array.from({ length: p.teams }, (_, i) => `clawboo-t${i + 1}`)
  const s = p.serverUser
  const runAs =
    teams.length > 0 ? `(${users.join(', ')} : ${teams.join(', ')})` : `(${users.join(', ')})`
  const lines: string[] = [
    `# A user per agent: ${p.users} agent users and ${p.teams} team groups, apart from ${s}.`,
    '# Run these once, as an administrator. Clawboo never runs them itself.',
    '',
    '# 1. Each agent user with a group of its own, a private home and no password.',
    'sudo install -d -m 755 /var/lib/clawboo-agents',
  ]
  users.forEach((u, i) => {
    const id = p.firstUid + i
    lines.push(
      `sudo groupadd -g ${id} ${u} && sudo useradd -u ${id} -g ${id} -m -d /var/lib/clawboo-agents/${u} -s /bin/bash ${u} && sudo passwd -l ${u} && sudo chmod 700 /var/lib/clawboo-agents/${u}`,
    )
  })
  lines.push(
    '',
    "# 2. The team groups. Nobody but the server is ever a member: an agent gets its team's group only while it is on that team.",
  )
  teams.forEach((t, i) => lines.push(`sudo groupadd -g ${p.firstTeamGid + i} ${t}`))
  lines.push(
    '',
    `# 3. ${s} makes the team folders, so it is in every one of these groups. Log in again afterwards.`,
    `sudo usermod -aG ${[...users, ...teams].join(',')} ${s}`,
    '',
    `# 4. Let ${s} start processes as each agent user, with a team's group, and nothing else.`,
    '#    The users are written out: sudo takes a team group only then, not through an alias.',
    `printf '%s\\n' '${s} ALL=${runAs} NOPASSWD: ALL' 'Defaults:${s} !requiretty' | sudo tee /etc/sudoers.d/clawboo >/dev/null`,
    'sudo chmod 440 /etc/sudoers.d/clawboo',
    'sudo visudo -cf /etc/sudoers.d/clawboo',
    '',
    "# 5. The work folder, the server's; setfacl for the team folders; limits; no jobs of their own.",
    `sudo install -d -o ${s} -g ${s} -m 711 /var/lib/clawboo-work`,
    'sudo apt-get install -y acl   # or: sudo dnf install -y acl',
    ...users.map(
      (u) =>
        `printf '%s\\n' '${u} hard nproc 4096' '${u} hard nofile 65536' | sudo tee /etc/security/limits.d/${u}.conf >/dev/null`,
    ),
    `printf '%s\\n' ${users.join(' ')} | sudo tee -a /etc/cron.deny /etc/at.deny >/dev/null`,
    `chmod 750 ${p.serverHome}`,
    '',
  )
  if (p.nodePath.startsWith(p.serverHome + path.posix.sep)) {
    lines.push(
      `# Node runs from ${p.nodePath}, inside your home, where the agent users cannot reach it.`,
      '# Install Node, Clawboo and each runtime where every user can run them, such as /usr/local or /opt.',
      '',
    )
  }
  const env = `CLAWBOO_AGENT_USERS=${users.join(',')}${teams.length > 0 ? ` CLAWBOO_AGENT_GROUPS=${teams.join(',')}` : ''} CLAWBOO_WORK_DIR=/var/lib/clawboo-work`
  lines.push(
    '# Then check it, and start Clawboo with the settings:',
    `${env} clawboo agent-user check`,
    `${env} clawboo`,
    '',
    '# Each agent gets a user when it is created and keeps it. With no user free, a new agent waits',
    '# (its runs say so) until you add users or delete an agent. These users belong to this Clawboo',
    '# only: it stops every process they run when it starts and when it stops.',
  )
  return lines.join('\n')
}
