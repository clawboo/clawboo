// The working-directory guard. A global `npm install -g clawboo@latest`
// replaces the package folder; a server whose directory sat inside it, and
// everything that server started, was left in a directory that no longer
// existed. The unit cases drive the guard through injected deps; the process
// case makes a real Node process delete its own working directory and checks
// the guard recovers and that express (whose depd calls process.cwd() while
// loading) loads afterwards.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { currentDir, ensureLiveCwd, launchDir, liveCwd, type CwdGuardDeps } from '../cwdGuard'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GUARD_TS = path.resolve(HERE, '..', 'cwdGuard.ts')
const SERVER_INDEX = path.resolve(HERE, '..', '..', 'index.ts')

const ROOT = process.platform === 'win32' ? 'C:\\' : '/'
const abs = (...parts: string[]): string => path.join(ROOT, ...parts)

/** Deps where the working directory is gone until something chdirs. */
function deadCwd(overrides: Partial<CwdGuardDeps> = {}): CwdGuardDeps & {
  chdirs: string[]
  made: string[]
} {
  let cwd: string | null = null
  const dirs = new Set<string>([abs('home', 'ada'), abs('tmp')])
  const chdirs: string[] = []
  const made: string[] = []
  return {
    chdirs,
    made,
    cwd: () => {
      if (cwd === null) throw Object.assign(new Error('uv_cwd'), { code: 'ENOENT' })
      return cwd
    },
    chdir: (dir) => {
      if (!dirs.has(dir)) throw new Error(`ENOENT ${dir}`)
      chdirs.push(dir)
      cwd = dir
    },
    isDir: (dir) => dirs.has(dir),
    mkdir: (dir) => {
      made.push(dir)
      dirs.add(dir)
    },
    env: { CLAWBOO_HOME: abs('home', 'ada', '.clawboo') },
    homedir: () => abs('home', 'ada'),
    tmpdir: () => abs('tmp'),
    ...overrides,
  }
}

describe('ensureLiveCwd', () => {
  it('leaves a working directory that exists alone', () => {
    const deps = deadCwd({ cwd: () => abs('work') })
    expect(ensureLiveCwd(deps)).toEqual({ moved: false, dir: abs('work') })
    expect(deps.chdirs).toEqual([])
  })

  it("moves a server in a deleted directory into clawboo's own, creating it", () => {
    const deps = deadCwd()
    expect(ensureLiveCwd(deps)).toEqual({ moved: true, dir: abs('home', 'ada', '.clawboo') })
    expect(deps.made).toEqual([abs('home', 'ada', '.clawboo')])
  })

  it("falls back to the home directory when clawboo's cannot be created", () => {
    const deps = deadCwd({
      mkdir: () => {
        throw new Error('EACCES')
      },
    })
    expect(ensureLiveCwd(deps)).toEqual({ moved: true, dir: abs('home', 'ada') })
  })

  it('skips a relative CLAWBOO_HOME, which would resolve against the dead directory', () => {
    const deps = deadCwd({ env: { CLAWBOO_HOME: 'relative/home' } })
    expect(ensureLiveCwd(deps).dir).toBe(abs('home', 'ada'))
    expect(deps.made).toEqual([])
  })

  it('reports no directory when nothing can be entered', () => {
    const deps = deadCwd({ isDir: () => false, mkdir: () => {} })
    expect(ensureLiveCwd(deps)).toEqual({ moved: false, dir: null })
  })
})

describe('liveCwd and launchDir', () => {
  it('liveCwd moves first, so a child never inherits the dead directory', () => {
    const deps = deadCwd()
    expect(liveCwd(deps)).toBe(abs('home', 'ada', '.clawboo'))
  })

  it('launchDir prefers the directory the CLI was started from', () => {
    const deps = deadCwd({
      cwd: () => abs('home', 'ada', '.clawboo'),
      env: { CLAWBOO_LAUNCH_DIR: abs('home', 'ada') },
    })
    expect(launchDir(deps)).toBe(abs('home', 'ada'))
  })

  it('launchDir ignores a launch directory that is gone or relative', () => {
    const gone = deadCwd({
      cwd: () => abs('work'),
      env: { CLAWBOO_LAUNCH_DIR: abs('deleted') },
    })
    expect(launchDir(gone)).toBe(abs('work'))
    const relative = deadCwd({ cwd: () => abs('work'), env: { CLAWBOO_LAUNCH_DIR: 'here' } })
    expect(launchDir(relative)).toBe(abs('work'))
  })

  it('currentDir is null instead of throwing', () => {
    expect(currentDir(deadCwd())).toBeNull()
  })
})

describe('server entry', () => {
  it('imports the guard before anything else, so it runs before express loads', () => {
    const source = fs.readFileSync(SERVER_INDEX, 'utf8')
    const firstImport = /^import\s.*$/m.exec(source)?.[0]
    expect(firstImport).toBe("import './lib/cwdGuard'")
  })
})

describe.skipIf(process.platform === 'win32')('a real process whose directory was deleted', () => {
  const made: string[] = []
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('recovers, and express loads afterwards', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-cwd-')))
    made.push(root)
    const clawbooHome = path.join(root, 'home', '.clawboo')
    const doomed = path.join(root, 'doomed')
    const tsxApi = createRequire(import.meta.url).resolve('tsx/esm/api')

    // tsx transpiles the guard, and needs a working directory to do it, so the
    // module is loaded first; the directory is then deleted and the guard's own
    // function is what has to recover. Express is required only after that.
    const child = path.join(root, 'child.mjs')
    fs.writeFileSync(
      child,
      `
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const [tsxApi, guardTs, doomed] = process.argv.slice(2)
const { register } = await import(pathToFileURL(tsxApi).href)
register()
const guard = await import(pathToFileURL(guardTs).href)
fs.mkdirSync(doomed)
process.chdir(doomed)
fs.rmdirSync(doomed)
let before = 'live'
try { process.cwd() } catch { before = 'dead' }
const result = guard.ensureLiveCwd()
createRequire(guardTs)('express')
console.log(JSON.stringify({ before, result, after: process.cwd() }))
`,
    )

    const out = spawnSync(process.execPath, [child, tsxApi, GUARD_TS, doomed], {
      cwd: root,
      env: { ...process.env, CLAWBOO_HOME: clawbooHome },
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(out.stderr).toBe('')
    expect(out.status).toBe(0)
    const report = JSON.parse(out.stdout.trim().split('\n').pop()!) as {
      before: string
      result: { moved: boolean; dir: string }
      after: string
    }
    expect(report.before).toBe('dead')
    expect(report.result).toEqual({ moved: true, dir: clawbooHome })
    expect(report.after).toBe(clawbooHome)
  })
})
