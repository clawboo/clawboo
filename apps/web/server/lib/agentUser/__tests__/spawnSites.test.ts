// Every place the server starts a process, and why each one may.
//
// With CLAWBOO_AGENT_USER set, anything that runs model-directed work, or runs
// in a folder an agent can write, must start through `spawnAgentProcess`
// (runtimes/spawner.ts), so it runs as the agent user. A new call to
// child_process anywhere else in the server fails this test until it is either
// moved onto the seam or added below with the reason it is the server's own
// business (design 4.4: "a new spawn site that forgets the seam fails a test").

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const SERVER = path.resolve(__dirname, '..', '..', '..')

/** File (relative to apps/web/server) -> why it may start a process itself. */
const ALLOWED: Record<string, string> = {
  'lib/runtimes/spawner.ts': 'the seam itself: child_process.spawn only with agent isolation off',
  'agentHost/host.ts': 'the agent host: it runs as the agent user and starts agent processes',
  'lib/agentUser/client.ts': 'starts the agent host as the agent user through sudo or doas',
  'lib/agentUser/system.ts': 'id lookups, and stopping every agent process through sudo or doas',
  'lib/agentUser/plan.ts': 'reads the used user and group ids (dscl) to print the setup commands',
  'lib/runtimes/killTree.ts': "ps and taskkill for the server's own children",
  'lib/processIdentity.ts': 'ps for process start times (the boot reap of its own children)',
  'lib/platform.ts': 'which / where lookups to resolve runtime binaries',
  'lib/selfRestart.ts': 'restarts the server itself',
  'api/systemUpdate.ts': 'updates the installed clawboo package (the server, not agent work)',
  'api/runtimes.ts': "installs runtimes, and signs out the operator's own Codex login",
  'lib/runtimes/npmRuntimeInstall.ts':
    'npm installs a runtime into the runtimes folder, which is kept apart from agent space',
  'lib/runtimes/hermes/install.ts':
    'downloads, unpacks and version-checks Hermes in the runtimes folder, kept apart from agent space',
  'lib/runtimes/codexAuth.ts': "codex login status of the operator's own login",
  'api/cliLogin.ts':
    "OpenClaw's login, whose Gateway runs as the server user (Codex and Hermes logins go through the seam)",
  'api/system.ts':
    'installs and supervises the OpenClaw Gateway, which agent isolation does not cover',
  'lib/openclawDetect.ts': 'openclaw --version',
  'lib/openclawRepair.ts': "repairs the server's OpenClaw install",
  'lib/modelCache.ts': 'openclaw models list, against the server-side Gateway',
}

const SPEC = `['"](?:node:)?child_process['"]`
/** `import <clause> from 'child_process'`, `import type` included (to skip). */
const STATIC_IMPORT_RE = new RegExp(`import\\s+(type\\s+)?([^'";]*?)\\s*from\\s*${SPEC}`, 'g')
/** `import('child_process')` and `require('child_process')`. */
const CALL_RE = new RegExp(`\\b(?:import|require)\\(\\s*${SPEC}\\s*\\)`)

/** Whether source text takes a value (not only types) from child_process: a
 *  named, default or namespace import, a dynamic import, or a require. */
function importsChildProcessValue(text: string): boolean {
  if (CALL_RE.test(text)) return true
  for (const m of text.matchAll(STATIC_IMPORT_RE)) {
    if (m[1]) continue
    const clause = (m[2] ?? '').trim()
    const braces = /^\{([^}]*)\}$/.exec(clause)
    if (!braces) return true
    const names = braces[1]!
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
    if (names.some((n) => !n.startsWith('type '))) return true
  }
  return false
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(full)
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      yield full
    }
  }
}

/** Files that import a value (not only a type) from child_process. */
function processStarters(): string[] {
  const found: string[] = []
  for (const file of sourceFiles(SERVER)) {
    if (importsChildProcessValue(fs.readFileSync(file, 'utf8'))) {
      found.push(path.relative(SERVER, file).split(path.sep).join('/'))
    }
  }
  return found.sort()
}

describe('finding the files that can start a process', () => {
  it.each([
    ["import { spawn } from 'node:child_process'", true],
    ["import * as cp from 'node:child_process'", true],
    ["import cp from 'child_process'", true],
    ["import cp, { type ChildProcess } from 'node:child_process'", true],
    ["const cp = await import('node:child_process')", true],
    ["const { spawn } = require('child_process')", true],
    ["import { spawn,\n  type ChildProcess,\n} from 'node:child_process'", true],
    ["import type { ChildProcess } from 'node:child_process'", false],
    ["import { type ChildProcess, type SpawnOptions } from 'node:child_process'", false],
    ["import { spawn } from './spawner'", false],
  ])('%s: %s', (text, starts) => {
    expect(importsChildProcessValue(text)).toBe(starts)
  })
})

describe('process starts in the server', () => {
  it('happen only through the agent spawn seam, or in a file with a stated reason', () => {
    const unexplained = processStarters().filter((f) => !(f in ALLOWED))
    expect(
      unexplained,
      'Start agent work with spawnAgentProcess (lib/runtimes/spawner.ts); add a file to ALLOWED only for the server own processes',
    ).toEqual([])
  })

  it('names no file that no longer starts a process', () => {
    const starters = new Set(processStarters())
    expect(Object.keys(ALLOWED).filter((f) => !starters.has(f))).toEqual([])
  })
})
