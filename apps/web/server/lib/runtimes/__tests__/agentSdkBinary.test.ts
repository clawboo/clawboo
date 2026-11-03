// Finding the Agent SDK's own `claude` binary the way a run finds it, against
// real package layouts on disk: a global npm install, a musl Linux, a pnpm
// store reached through a symlink, and each piece missing in turn.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AGENT_SDK_PACKAGE,
  agentSdkBinaryCandidates,
  findAgentSdkDir,
  resolveAgentSdkBinary,
} from '../agentSdkBinary'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clawboo-agent-sdk-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A package folder with a package.json, plus any files named. */
function writePackage(dir: string, name: string, files: string[] = []): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  for (const f of files) writeFileSync(path.join(dir, f), '')
}

/** `<nm>/@anthropic-ai/claude-agent-sdk` and the platform packages named. */
function installSdk(nodeModules: string, platformSuffixes: string[]): void {
  writePackage(path.join(nodeModules, ...AGENT_SDK_PACKAGE.split('/')), AGENT_SDK_PACKAGE, [
    'sdk.mjs',
  ])
  for (const suffix of platformSuffixes) {
    const name = `${AGENT_SDK_PACKAGE}-${suffix}`
    const bin = suffix.startsWith('win32') ? 'claude.exe' : 'claude'
    writePackage(path.join(nodeModules, ...name.split('/')), name, [bin])
  }
}

/** Where a globally installed clawboo's server module sits. */
function clawbooDist(nodeModules: string): string {
  const dist = path.join(nodeModules, 'clawboo', 'dist')
  mkdirSync(dist, { recursive: true })
  return dist
}

describe('the specifiers the SDK tries', () => {
  it('names the platform package, glibc first on Linux and musl first without glibc', () => {
    expect(
      agentSdkBinaryCandidates({ platform: 'darwin', arch: 'arm64', preferMusl: false }),
    ).toEqual([`${AGENT_SDK_PACKAGE}-darwin-arm64/claude`])
    expect(agentSdkBinaryCandidates({ platform: 'linux', arch: 'x64', preferMusl: false })).toEqual(
      [`${AGENT_SDK_PACKAGE}-linux-x64/claude`, `${AGENT_SDK_PACKAGE}-linux-x64-musl/claude`],
    )
    expect(
      agentSdkBinaryCandidates({ platform: 'linux', arch: 'arm64', preferMusl: true }),
    ).toEqual([
      `${AGENT_SDK_PACKAGE}-linux-arm64-musl/claude`,
      `${AGENT_SDK_PACKAGE}-linux-arm64/claude`,
    ])
    expect(agentSdkBinaryCandidates({ platform: 'win32', arch: 'x64', preferMusl: false })).toEqual(
      [`${AGENT_SDK_PACKAGE}-win32-x64/claude.exe`],
    )
  })
})

describe('resolveAgentSdkBinary', () => {
  it('finds the binary of an SDK installed next to clawboo (a global install)', () => {
    const nm = path.join(root, 'lib', 'node_modules')
    installSdk(nm, ['linux-x64'])
    const found = resolveAgentSdkBinary({
      fromDir: clawbooDist(nm),
      platform: 'linux',
      arch: 'x64',
      preferMusl: false,
    })
    expect(found).toBe(path.join(nm, '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude'))
  })

  it('takes the musl build first on a Linux without glibc, as the SDK does', () => {
    const nm = path.join(root, 'node_modules')
    installSdk(nm, ['linux-x64', 'linux-x64-musl'])
    const from = clawbooDist(nm)
    const musl = resolveAgentSdkBinary({
      fromDir: from,
      platform: 'linux',
      arch: 'x64',
      preferMusl: true,
    })
    const glibc = resolveAgentSdkBinary({
      fromDir: from,
      platform: 'linux',
      arch: 'x64',
      preferMusl: false,
    })
    expect(musl).toBe(path.join(nm, '@anthropic-ai', 'claude-agent-sdk-linux-x64-musl', 'claude'))
    expect(glibc).toBe(path.join(nm, '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude'))
  })

  it('falls back to the other Linux build when only that one is installed', () => {
    const nm = path.join(root, 'node_modules')
    installSdk(nm, ['linux-x64-musl'])
    expect(
      resolveAgentSdkBinary({
        fromDir: clawbooDist(nm),
        platform: 'linux',
        arch: 'x64',
        preferMusl: false,
      }),
    ).toBe(path.join(nm, '@anthropic-ai', 'claude-agent-sdk-linux-x64-musl', 'claude'))
  })

  it('is null when the SDK has no binary for this platform (installed with --omit=optional)', () => {
    const nm = path.join(root, 'node_modules')
    installSdk(nm, ['darwin-arm64'])
    expect(
      resolveAgentSdkBinary({
        fromDir: clawbooDist(nm),
        platform: 'linux',
        arch: 'x64',
        preferMusl: false,
      }),
    ).toBeNull()
  })

  it('is null when only the binary package is there and the SDK a run loads is not', () => {
    const nm = path.join(root, 'node_modules')
    const name = `${AGENT_SDK_PACKAGE}-linux-x64`
    writePackage(path.join(nm, ...name.split('/')), name, ['claude'])
    expect(
      resolveAgentSdkBinary({
        fromDir: clawbooDist(nm),
        platform: 'linux',
        arch: 'x64',
        preferMusl: false,
      }),
    ).toBeNull()
  })

  it('is null when nothing is installed above the server', () => {
    const from = path.join(root, 'app', 'dist')
    mkdirSync(from, { recursive: true })
    expect(findAgentSdkDir(from)).toBeNull()
    expect(
      resolveAgentSdkBinary({ fromDir: from, platform: 'linux', arch: 'x64', preferMusl: false }),
    ).toBeNull()
  })

  it.skipIf(process.platform === 'win32')(
    'resolves from the SDK’s real folder when it is reached through a symlink (pnpm)',
    () => {
      // pnpm links the SDK into the app's node_modules from its store, and the
      // platform package sits beside the SDK in the store, not in the app.
      const store = path.join(root, '.pnpm', 'sdk@1', 'node_modules')
      installSdk(store, ['darwin-arm64'])
      const appModules = path.join(root, 'app', 'node_modules', '@anthropic-ai')
      mkdirSync(appModules, { recursive: true })
      symlinkSync(
        path.join(store, '@anthropic-ai', 'claude-agent-sdk'),
        path.join(appModules, 'claude-agent-sdk'),
      )
      const from = path.join(root, 'app', 'server')
      mkdirSync(from, { recursive: true })
      expect(
        resolveAgentSdkBinary({
          fromDir: from,
          platform: 'darwin',
          arch: 'arm64',
          preferMusl: false,
        }),
      ).toBe(path.join(store, '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude'))
    },
  )
})
