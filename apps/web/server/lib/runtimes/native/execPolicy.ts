// What a native Boo is allowed to ask to run, before a human is asked about it.
//
// THE PROMISE THIS TIER MAKES IS NARROW AND IT IS THE WHOLE POINT: the approval
// card shows the command, and what the card shows is what runs. Everything here
// exists to keep that sentence true. A command whose effect cannot be read off
// the card is refused before an approval row is ever written, because a prompt
// that a person cannot actually evaluate is worse than no prompt: they click it,
// and now they believe they decided something.
//
// WHY INTERPRETERS ARE REFUSED, and why that is not the same as a sandbox.
// This tier takes an argv ARRAY rather than a command string, on the reasoning
// that it therefore needs no shell tokenizer. That reasoning is circular on its
// own: `['sh', 'build.sh']` needs no tokenizer from us because bash does the
// tokenizing, and the same Boo can write `build.sh` with `write_file` seconds
// earlier. One approval would buy arbitrary, unreadable shell. So the argv form
// only means what it says if an interpreter cannot be argv[0].
//
// THE LIST BELOW IS A SPEED BUMP, NOT A BOUNDARY, and it must never be described
// as one. A basename denylist cannot be complete: `git -c core.pager=...`,
// `find -exec`, `awk 'BEGIN{system(...)}'`, `sed` with the e flag and any editor
// with a shell escape all reach a shell without appearing here. What actually
// stands between a model and this machine is a human answering a prompt for
// every single command. This list only removes the cases where that human would
// have been answering about something they could not see.
//
// NO INJECTION SCAN ON THE ARGUMENTS, deliberately, and this reverses an earlier
// draft. `evaluateInjection(argv.join(' '), { surface: 'exec' })` was measured
// against the real rules:
//
//     BLOCK  ["git","commit","-m","fix: rm -rf / guard"]
//     BLOCK  ["grep","-n","print","secrets.py"]
//     clean  ["sh","build.sh"]
//
// It denies ordinary work and misses the case that matters, because `actionFor`
// escalates every rule to a block on the exec surface, prose-intent ones
// included. Two false denials in a row trip the circuit breaker and abort a board
// run. A filter with that shape does not add safety on top of a human approval,
// it subtracts working commands and adds false confidence.

/**
 * A SECOND CHECK AFTER RESOLUTION, because the first one can be walked past.
 *
 * `classifyArgv` sees the text the model wrote. `spawn` runs whatever that text
 * resolves to, and those differ: a symlink named `tool` pointing at `/bin/bash`
 * passes a basename denylist and then executes bash. Measured, not theorised.
 *
 * So the program is resolved to a real path FIRST, the denylist is applied to
 * the resolved basename, and the RESOLVED PATH is what gets spawned. Spawning
 * the original text after checking the resolved target would reintroduce the
 * same gap between what was approved and what runs, one layer down.
 */

import { access, open, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

import { isAgentUserMode } from '../../agentUser/config'
import { activeAgentHost, agentHomeDir } from '../../agentUser/state'
import { realPathOrSpelling, workDirSpellings } from '../../workDir'

/** Refusal codes, carried to the model so it can adapt rather than retry blindly. */
export type ExecRefusalCode =
  | 'not-argv'
  | 'empty-program'
  | 'too-many-args'
  | 'arg-too-long'
  | 'control-character'
  | 'interpreter'
  | 'path-separator-in-program'
  | 'not-found'
  | 'agent-space'
  | 'not-trusted-owner'

export interface ExecRefusal {
  ok: false
  code: ExecRefusalCode
  /** Addressed to the MODEL: says what to do instead, not just what went wrong. */
  message: string
}

export interface ExecAccepted {
  ok: true
  /** argv[0] exactly as given. Resolution to an absolute path happens later. */
  program: string
  argv: string[]
}

export const MAX_ARGV_LENGTH = 64

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const OPEN_PROGRAM = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)
export const MAX_ARG_BYTES = 2048

/**
 * Programs that turn an argv into a shell, by basename.
 *
 * Frozen and matched on the BASENAME with any `.exe` suffix removed, so an
 * absolute path cannot walk around it. Grouped by how they get there, because a
 * future reader needs to know what kind of thing belongs in this list.
 */
export const SHELL_ESCAPING_PROGRAMS: ReadonlySet<string> = new Set([
  // Shells.
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'ash',
  'busybox',
  // Run-another-program wrappers. Each takes a command as its arguments, so
  // refusing them is refusing an indirection, not a capability.
  'env',
  'xargs',
  'nohup',
  'timeout',
  'nice',
  'ionice',
  'setsid',
  'stdbuf',
  'watch',
  'script',
  'time',
  'sudo',
  'doas',
  'su',
  // Interpreters with an inline-eval flag or a script-file argument.
  'python',
  'python2',
  'python3',
  'node',
  'nodejs',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'lua',
  'tclsh',
  'osascript',
  'rscript',
  'julia',
  'groovy',
  // Package runners that fetch and execute arbitrary code.
  'npx',
  'pnpx',
  'bunx',
  'yarn-dlx',
  // Build tools whose entire job is running shell recipes.
  'make',
  'gmake',
  'cmake',
  'ninja',
  'rake',
  'gradle',
  'mvn',
  'ant',
  // Anything that runs a command somewhere else.
  'ssh',
  'docker',
  'podman',
  'kubectl',
  'nsenter',
  'chroot',
  'flatpak',
])

const refuse = (code: ExecRefusalCode, message: string): ExecRefusal => ({
  ok: false,
  code,
  message,
})

/**
 * Any C0 control or DEL.
 *
 * Checked by code point rather than by regex because the equivalent character
 * class is literally a control character in the source, which eslint refuses
 * (`no-control-regex`) for exactly the reason it is worth refusing: nobody
 * reviewing the file could see what was in the brackets.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** Basename, lowercased, `.exe` stripped. */
export function programBasename(program: string): string {
  const tail = program.split(/[\\/]/).pop() ?? ''
  return tail.toLowerCase().replace(/\.exe$/, '')
}

/**
 * Whether this basename names a shell escape, version suffix and all.
 *
 * EXACT MEMBERSHIP WAS NOT ENOUGH. Interpreters ship under versioned names, and
 * `python3.11`, `node22` and `perl5.36` were all accepted while `python` and
 * `node` were refused. Measured, not theorised. The suffix is stripped and the
 * stem re-checked, so a family already on the list stays on it however it is
 * versioned, and an unrelated program that merely ends in digits is unaffected
 * because its stem is not on the list either.
 */
export function isShellEscapingProgram(basename: string): boolean {
  if (SHELL_ESCAPING_PROGRAMS.has(basename)) return true
  const stem = basename.replace(/[0-9]+(?:\.[0-9]+)*$/, '')
  if (stem !== basename && SHELL_ESCAPING_PROGRAMS.has(stem)) return true
  // `python3.11` reduces to `python3.` above; drop a trailing separator too.
  const trimmed = stem.replace(/[.\-_]$/, '')
  return trimmed !== stem && SHELL_ESCAPING_PROGRAMS.has(trimmed)
}

/**
 * Decide whether this argv may be put in front of a human.
 *
 * Pure and synchronous: no filesystem, no PATH, no spawning. Resolving argv[0]
 * to a real binary is a separate, later step, because a refusal here must not
 * depend on what happens to be installed.
 */
export function classifyArgv(input: unknown): ExecAccepted | ExecRefusal {
  if (!Array.isArray(input) || input.length === 0) {
    return refuse(
      'not-argv',
      'argv must be a non-empty array of strings, for example ["git","status"].',
    )
  }
  if (input.length > MAX_ARGV_LENGTH) {
    return refuse('too-many-args', `argv may hold at most ${MAX_ARGV_LENGTH} items.`)
  }
  if (!input.every((a) => typeof a === 'string')) {
    return refuse('not-argv', 'every argv item must be a string.')
  }

  const argv = input as string[]
  for (const arg of argv) {
    if (Buffer.byteLength(arg, 'utf8') > MAX_ARG_BYTES) {
      return refuse('arg-too-long', `each argv item must be under ${MAX_ARG_BYTES} bytes.`)
    }
    // A NUL truncates the string at the syscall boundary, so what a human read on
    // the card and what the kernel receives would differ. That is the one thing
    // this tier promises cannot happen.
    if (hasControlCharacter(arg)) {
      return refuse('control-character', 'argv items may not contain control characters.')
    }
  }

  const program = argv[0] ?? ''
  if (!program.trim()) {
    return refuse('empty-program', 'argv[0] must name a program.')
  }
  // A relative path with a separator (`./build.sh`, `scripts/run`) resolves
  // against a working directory the model does not control and cannot see, so
  // the card would show a name whose target is ambiguous. An absolute path is
  // allowed: it says exactly what it means.
  if (!program.startsWith('/') && /[\\/]/.test(program)) {
    return refuse(
      'path-separator-in-program',
      'argv[0] must be a bare program name or an absolute path.',
    )
  }

  const base = programBasename(program)
  if (isShellEscapingProgram(base)) {
    return refuse(
      'interpreter',
      `"${base}" runs other commands, so the approval card could not show what would actually run. ` +
        'Call the program you want directly, one command per call.',
    )
  }

  return { ok: true, program, argv }
}

/**
 * Find the real binary behind `program`, following symlinks.
 *
 * Returns the resolved absolute path, or null when nothing executable matches.
 * A bare name is looked up on the CHILD's PATH rather than the server's, so the
 * thing checked is the thing that will run.
 */
export async function resolveProgramPath(
  program: string,
  pathEnv: string | undefined,
): Promise<string | null> {
  if (isAgentUserMode()) {
    const found = await resolveAgentProgram(program, pathEnv)
    return found.ok ? found.resolved : null
  }
  const candidates = programCandidates(program, pathEnv)

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      // realpath, not the candidate: the denylist has to see the target, and the
      // spawn has to use the same path the denylist saw.
      const real = await realpath(candidate)
      const st = await stat(real)
      if (st.isFile()) return real
    } catch {
      // Not here, or not executable. Try the next PATH entry.
    }
  }
  return null
}

function programCandidates(program: string, pathEnv: string | undefined): string[] {
  return program.startsWith('/')
    ? [program]
    : (pathEnv ?? '')
        .split(':')
        .filter(Boolean)
        .map((dir) => path.join(dir, program))
}

// WITH AGENTS ON THEIR OWN OS USER (CLAWBOO_AGENT_USER) the command runs as that
// user, and the agent can write its home and its work folder (and could open
// them up to this server). Every look at a program here is this server's own
// file access on a path the model chose, so in that mode:
//
//  - a program in agent space is refused by name, before any file is touched:
//    the agent could swap it for a named pipe between a check and the open, and
//    a blocked open holds one of the few threads all of this server's file work
//    shares;
//  - the agent host (as the agent user) says first which candidates that user
//    can execute at all. A program it cannot run would fail at the spawn anyway,
//    and a path only this server can reach is never looked at, so the answer
//    says nothing about it. The host is on the agents' side, so its answer only
//    narrows the list: the checks after it are this server's own;
//  - the program must be owned by root or by the user this server runs as,
//    and writable by neither its group nor others. The agent user can change
//    such a file only by being one of those owners, so it cannot have put it
//    there or changed it, and the file that was shown on the card is the file
//    the agent user runs. (The server's own user counts: on a one-person Mac,
//    Homebrew's programs belong to that person, who is the server user.)

/** Agent space in every spelling: the work folder and the agent user's home. */
function agentSpaceRoots(): string[] {
  const home = path.resolve(agentHomeDir())
  return [...new Set([...workDirSpellings(), home, realPathOrSpelling(home)])]
}

function isInAgentSpace(p: string, roots: readonly string[]): boolean {
  const abs = path.resolve(p)
  return roots.some(
    (root) => abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep),
  )
}

/** Owned by root or this server's user, and neither group nor others may write it. */
function hasTrustedOwner(st: { uid: number; mode: number }): boolean {
  const owner = st.uid === 0 || st.uid === process.getuid?.()
  return owner && (st.mode & 0o022) === 0
}

const inAgentSpace = (shown: string): ExecRefusal =>
  refuse(
    'agent-space',
    `"${shown}" is in the agents' own folders. Agents run as their own user here, so a ` +
      'program they could have written is not run. Call an installed program instead, by ' +
      'name (such as git) or by a path outside those folders.',
  )

const notTrustedOwner = (real: string): ExecRefusal =>
  refuse(
    'not-trusted-owner',
    `"${real}" is owned by another user, or its group or others may change it. Agents run ` +
      'as their own user here, so only a program installed by root or by the user Clawboo ' +
      'runs as, and writable by no one else, can be run. Call an installed program instead.',
  )

/** The candidates the agent user can execute, as the agent host reports it. */
async function agentCanExec(paths: string[]): Promise<Set<string>> {
  const res = await activeAgentHost().client.request({ op: 'canExec', paths })
  const ok = new Set<string>()
  for (const r of Array.isArray(res.results) ? res.results : []) {
    if (r && r.ok === true && typeof r.path === 'string') ok.add(r.path)
  }
  return ok
}

export type AgentProgramResolution = { ok: true; resolved: string } | ExecRefusal

/**
 * `resolveProgramPath` with agents on their own OS user, saying why when a
 * program cannot be used. A bare name takes the first PATH entry that passes
 * every check, so a copy someone installed for themselves earlier in PATH does
 * not hide the system one.
 */
export async function resolveAgentProgram(
  program: string,
  pathEnv: string | undefined,
): Promise<AgentProgramResolution> {
  try {
    const roots = agentSpaceRoots()
    const candidates = programCandidates(program, pathEnv)
    const outside = candidates.filter((c) => !isInAgentSpace(c, roots))
    if (program.startsWith('/') && outside.length === 0) return inAgentSpace(program)
    const runnable = outside.length > 0 ? await agentCanExec(outside) : new Set<string>()
    let first: ExecRefusal | null = null
    for (const candidate of outside) {
      if (!runnable.has(candidate)) continue
      try {
        const real = await realpath(candidate)
        if (isInAgentSpace(real, roots)) {
          first ??= inAgentSpace(real)
          continue
        }
        const st = await stat(real)
        if (!st.isFile()) continue
        if (!hasTrustedOwner(st)) {
          first ??= notTrustedOwner(real)
          continue
        }
        return { ok: true, resolved: real }
      } catch {
        // Gone since the host looked. Try the next PATH entry.
      }
    }
    return (
      first ??
      refuse(
        'not-found',
        `"${program}" was not found as a program this Boo may run. Agents run as their own ` +
          'user here, so a program must be one that user can run, installed by root or by the ' +
          "user Clawboo runs as, and outside the agents' own folders.",
      )
    )
  } catch (err) {
    return refuse(
      'not-found',
      `"${program}" could not be checked: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * The check that actually protects the promise, applied to the resolved target.
 *
 * Separate from `classifyArgv` because it needs the filesystem, and because a
 * refusal that depends on what happens to be installed should be visibly
 * distinct from one that does not.
 */
export function classifyResolvedProgram(resolved: string): ExecAccepted | ExecRefusal {
  const base = programBasename(resolved)
  if (isShellEscapingProgram(base)) {
    return refuse(
      'interpreter',
      `that resolves to "${base}", which runs other commands, so the approval card ` +
        'could not show what would actually run. Call the program you want directly.',
    )
  }
  return { ok: true, program: resolved, argv: [resolved] }
}

/**
 * The identity of the file that was approved.
 *
 * A path is not an identity. The approval sits in front of a human for minutes,
 * and the file at that path can be replaced in the meantime, so what was
 * inspected and what gets executed need not be the same bytes.
 *
 * DEVICE AND INODE ARE NOT ENOUGH, which CI proved rather than theory: on ext4
 * a delete-and-recreate at the same path REUSED the inode, so the check said
 * "same file" about different bytes. macOS did not reuse it, so the gap only
 * appeared on Linux. Size and the two timestamps are recorded as well, and all
 * of them change when a file is replaced.
 */
export interface ExecFileIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

export interface ExecInspection {
  ok: true
  resolved: string
  identity: ExecFileIdentity
}

/**
 * Everything that must be true of the real file before a person is asked.
 *
 * READS THE SHEBANG, because a basename says nothing about what actually
 * interprets a script. A file named `mytool` whose first line is `#!/bin/sh` is
 * a shell script: it passed the denylist, and the card would have shown
 * `mytool` while `/bin/sh` did the work. Verified against a real file, not
 * reasoned about.
 */
export async function inspectResolvedProgram(
  resolved: string,
): Promise<ExecInspection | ExecRefusal> {
  const base = programBasename(resolved)
  if (isShellEscapingProgram(base)) {
    return refuse(
      'interpreter',
      `that resolves to "${base}", which runs other commands, so the approval card ` +
        'could not show what would actually run. Call the program you want directly.',
    )
  }

  // With agents on their own user, refused by name before the open (see
  // `resolveAgentProgram`), and the open below takes no link at the path's end:
  // the resolved path is a real path, so a link there now is a swap.
  const agentMode = isAgentUserMode()
  if (agentMode) {
    let roots: string[]
    try {
      roots = agentSpaceRoots()
    } catch (err) {
      return refuse(
        'not-found',
        `"${resolved}" could not be checked: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (isInAgentSpace(resolved, roots)) return inAgentSpace(resolved)
  }

  let identity: ExecFileIdentity
  let shebang = ''
  let ownership: ExecRefusal | null = null
  try {
    // O_NONBLOCK, so a named pipe swapped in after the checks cannot hold the
    // open (and one of the threads this server's file work shares) until
    // something writes to it. It changes nothing for a regular file, and
    // anything else is refused just below, before a read.
    const handle = await open(resolved, OPEN_PROGRAM | (agentMode ? NOFOLLOW : 0))
    try {
      const st = await handle.stat()
      if (!st.isFile()) throw new Error('not a regular file')
      if (agentMode && !hasTrustedOwner(st)) ownership = notTrustedOwner(resolved)
      identity = {
        dev: st.dev,
        ino: st.ino,
        size: st.size,
        mtimeMs: st.mtimeMs,
        ctimeMs: st.ctimeMs,
      }
      const buf = Buffer.alloc(256)
      const { bytesRead } = await handle.read(buf, 0, 256, 0)
      shebang = buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return refuse('not-found', `"${resolved}" could not be read.`)
  }
  if (ownership) return ownership

  if (shebang.startsWith('#!')) {
    const line = shebang.split('\n', 1)[0] ?? ''
    // `#!/usr/bin/env python3` names the interpreter in the second word, so both
    // are checked: `env` is itself on the list, and so is what it would run.
    const words = line.slice(2).trim().split(/\s+/).filter(Boolean)
    for (const word of words.slice(0, 2)) {
      const wordBase = programBasename(word)
      if (isShellEscapingProgram(wordBase)) {
        return refuse(
          'interpreter',
          `"${base}" is a script run by "${wordBase}", which runs other commands, so the ` +
            'approval card could not show what would actually run.',
        )
      }
    }
  }

  return { ok: true, resolved, identity }
}

/**
 * Whether the file about to be spawned is still the one that was approved.
 *
 * NARROWS THE WINDOW, DOES NOT CLOSE IT, and the comment says so because the
 * alternative is a reader trusting it further than it earns. The file can still
 * change between this check and the spawn; closing that properly means holding
 * the descriptor open from inspection and executing it directly, which is not
 * portable. What this does remove is the case that actually matters: a swap
 * during the minutes an approval waits for a human.
 *
 * Every recorded field is compared, not just the inode, because inode reuse is
 * real and was observed in CI.
 */
export async function isSameFile(resolved: string, identity: ExecFileIdentity): Promise<boolean> {
  try {
    const st = await stat(resolved)
    return (
      st.dev === identity.dev &&
      st.ino === identity.ino &&
      st.size === identity.size &&
      st.mtimeMs === identity.mtimeMs &&
      st.ctimeMs === identity.ctimeMs
    )
  } catch {
    return false
  }
}
