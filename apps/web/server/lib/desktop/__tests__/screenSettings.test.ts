// What an administrator sets for agents' screens: the links switch, programs
// named by path and the check they must pass, the download switch, the display
// cap. The filesystem is stood in for: the trust check reads only what it is
// handed.

import type fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetOperatorSettings } from '../../operatorSettings'
import {
  computerLinksSetting,
  desktopToolDownloadRefusal,
  desktopToolsInstallRefusal,
  linkKindRefusal,
  maxAgentDisplays,
  operatorProgram,
  programTrustProblem,
  type ProgramCheckDeps,
} from '../screenSettings'

const ENV_KEYS = [
  'CLAWBOO_COMPUTER_LINKS',
  'CLAWBOO_XVNC_PATH',
  'CLAWBOO_CUA_DRIVER_PATH',
  'CLAWBOO_DISABLE_DESKTOP_TOOLS_INSTALL',
  'CLAWBOO_MAX_AGENT_DISPLAYS',
  'CLAWBOO_MAX_AGENT_BROWSERS',
  'CLAWBOO_HOME',
  'CLAWBOO_OPERATOR_SETTINGS',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  // No operator file: a home of its own, with none in it.
  process.env['CLAWBOO_HOME'] = path.join(os.tmpdir(), `cb-screens-${process.pid}-${Date.now()}`)
  resetOperatorSettings()
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  resetOperatorSettings()
})

// ─── A filesystem to check against ───────────────────────────────────────────

interface Entry {
  kind: 'file' | 'dir'
  uid: number
  mode: number
  /** Where the path really leads, when it is (or passes through) a link. */
  real?: string
}

const ME = 1000

function fakeFs(entries: Record<string, Entry>, canExecute = true): ProgramCheckDeps {
  const stat = (p: string): fs.Stats => {
    const e = entries[p]
    if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return {
      uid: e.uid,
      mode: e.mode,
      isFile: () => e.kind === 'file',
      isDirectory: () => e.kind === 'dir',
    } as unknown as fs.Stats
  }
  return {
    lstat: stat,
    realpath: (p) => {
      stat(p)
      return entries[p]?.real ?? p
    },
    canExecute: () => canExecute,
    uid: ME,
  }
}

const rootDir = (mode = 0o755): Entry => ({ kind: 'dir', uid: 0, mode })
const good = (): Record<string, Entry> => ({
  '/': rootDir(),
  '/opt': rootDir(),
  '/opt/vnc': rootDir(),
  '/opt/vnc/Xvnc': { kind: 'file', uid: 0, mode: 0o755 },
})

describe('programTrustProblem', () => {
  it('lets a program run that only root or this user can change', () => {
    expect(programTrustProblem('/opt/vnc/Xvnc', fakeFs(good()))).toBeNull()
    const mine = { ...good(), '/opt/vnc/Xvnc': { kind: 'file' as const, uid: ME, mode: 0o700 } }
    expect(programTrustProblem('/opt/vnc/Xvnc', fakeFs(mine))).toBeNull()
  })

  it('refuses a path that is not written plainly', () => {
    for (const p of ['opt/vnc/Xvnc', '/opt/vnc/../vnc/Xvnc', '/opt//vnc/Xvnc', '/opt/./vnc/Xvnc']) {
      expect(programTrustProblem(p, fakeFs(good()))).toMatch(/absolute path written plainly/)
    }
  })

  it('refuses a link, or a path through a folder that is a link', () => {
    const linked = { ...good(), '/opt/vnc/Xvnc': { ...good()['/opt/vnc/Xvnc']!, real: '/tmp/x' } }
    expect(programTrustProblem('/opt/vnc/Xvnc', fakeFs(linked))).toMatch(/is a link.*\/tmp\/x/)
  })

  it('refuses what is missing, not a file, or cannot be run', () => {
    expect(programTrustProblem('/opt/vnc/nope', fakeFs(good()))).toMatch(/does not exist/)
    const dir = { ...good(), '/opt/vnc/Xvnc': rootDir() }
    expect(programTrustProblem('/opt/vnc/Xvnc', fakeFs(dir))).toMatch(/not a file/)
    const noExec = { ...good(), '/opt/vnc/Xvnc': { kind: 'file' as const, uid: 0, mode: 0o644 } }
    expect(programTrustProblem('/opt/vnc/Xvnc', fakeFs(noExec))).toMatch(/cannot be run/)
    expect(programTrustProblem('/opt/vnc/Xvnc', fakeFs(good(), false))).toMatch(/cannot be run/)
  })

  it('refuses a program another user owns, or its group or others can write', () => {
    for (const file of [
      { kind: 'file' as const, uid: 1001, mode: 0o755 },
      { kind: 'file' as const, uid: 0, mode: 0o775 },
      { kind: 'file' as const, uid: ME, mode: 0o757 },
    ]) {
      const fsx = { ...good(), '/opt/vnc/Xvnc': file }
      expect(programTrustProblem('/opt/vnc/Xvnc', fakeFs(fsx))).toMatch(/can be changed by a user/)
    }
  })

  it('refuses a program in a folder that others could swap it out of, at any depth', () => {
    for (const [dir, entry] of [
      ['/opt/vnc', { kind: 'dir' as const, uid: 1001, mode: 0o755 }],
      ['/opt/vnc', rootDir(0o775)],
      // A sticky, world-writable folder (like /tmp) is refused too.
      ['/opt', rootDir(0o1777)],
      ['/', rootDir(0o757)],
    ] as const) {
      const fsx = { ...good(), [dir]: entry }
      expect(programTrustProblem('/opt/vnc/Xvnc', fakeFs(fsx))).toMatch(
        new RegExp(`^${dir.replace(/\//g, '\\/')}, a folder above`),
      )
    }
  })
})

describe('operatorProgram', () => {
  it('is null when nothing is named, and the named path with its problem otherwise', () => {
    expect(operatorProgram('xvncPath', fakeFs(good()))).toBeNull()
    process.env['CLAWBOO_XVNC_PATH'] = '/opt/vnc/Xvnc'
    expect(operatorProgram('xvncPath', fakeFs(good()))).toEqual({
      path: '/opt/vnc/Xvnc',
      problem: null,
    })
    process.env['CLAWBOO_CUA_DRIVER_PATH'] = '/opt/cua/cua-driver'
    expect(operatorProgram('cuaDriverPath', fakeFs(good()))?.problem).toMatch(/does not exist/)
  })

  it('refuses a name it cannot read rather than falling back to another program', () => {
    process.env['CLAWBOO_XVNC_PATH'] = 'relative/Xvnc'
    expect(operatorProgram('xvncPath', fakeFs(good()))?.problem).toMatch(/cannot be read/)
  })
})

describe('linkKindRefusal', () => {
  it('follows CLAWBOO_COMPUTER_LINKS, and turns links off on a value it cannot read', () => {
    expect(computerLinksSetting()).toBe('on')
    expect(linkKindRefusal('view')).toBeNull()
    expect(linkKindRefusal('control')).toBeNull()
    process.env['CLAWBOO_COMPUTER_LINKS'] = 'view'
    expect(linkKindRefusal('view')).toBeNull()
    expect(linkKindRefusal('control')).toMatch(/Control links are turned off/)
    process.env['CLAWBOO_COMPUTER_LINKS'] = 'off'
    expect(linkKindRefusal('view')).toMatch(/turned off/)
    expect(linkKindRefusal('control')).toMatch(/turned off/)
    process.env['CLAWBOO_COMPUTER_LINKS'] = 'yes please'
    expect(computerLinksSetting()).toBe('off')
  })
})

describe('desktop tool downloads', () => {
  it('are allowed by default, off for all with the switch, off for one whose program is named', () => {
    expect(desktopToolsInstallRefusal()).toBeNull()
    expect(desktopToolDownloadRefusal('tigervnc')).toBeNull()
    expect(desktopToolDownloadRefusal('cuaDriver')).toBeNull()
    process.env['CLAWBOO_XVNC_PATH'] = '/opt/vnc/Xvnc'
    expect(desktopToolDownloadRefusal('tigervnc')).toMatch(/CLAWBOO_XVNC_PATH/)
    expect(desktopToolDownloadRefusal('cuaDriver')).toBeNull()
    process.env['CLAWBOO_DISABLE_DESKTOP_TOOLS_INSTALL'] = '1'
    expect(desktopToolsInstallRefusal()).toMatch(/turned off/)
    expect(desktopToolDownloadRefusal('cuaDriver')).toMatch(/turned off/)
  })
})

describe('maxAgentDisplays', () => {
  it('is its own setting, and the browser cap only when unset', () => {
    expect(maxAgentDisplays()).toBe(4)
    process.env['CLAWBOO_MAX_AGENT_BROWSERS'] = '6'
    expect(maxAgentDisplays()).toBe(6)
    process.env['CLAWBOO_MAX_AGENT_DISPLAYS'] = '2'
    expect(maxAgentDisplays()).toBe(2)
  })
})
