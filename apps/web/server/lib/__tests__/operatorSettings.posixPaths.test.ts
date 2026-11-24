// The path settings name Linux programs, so their shape is checked by POSIX
// rules on every system. Here the host's path module is Windows' (node:path
// mocked to path.win32), the way the server sees it on a Windows machine: a
// Linux path still reads as itself, and the same values are still refused.

import { describe, expect, it, vi } from 'vitest'

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...actual.win32, default: actual.win32 }
})

import { OperatorSettingsError, readOperatorEnv } from '../operatorSettings'

describe('path settings under Windows path rules', () => {
  it('reads a Linux program path as written', () => {
    const pins = readOperatorEnv({
      CLAWBOO_XVNC_PATH: '/usr/bin/Xtigervnc',
      CLAWBOO_CUA_DRIVER_PATH: '/opt/cua/cua-driver',
    })
    expect(pins.xvncPath?.value).toBe('/usr/bin/Xtigervnc')
    expect(pins.cuaDriverPath?.value).toBe('/opt/cua/cua-driver')
  })

  it('pins nothing when neither is set, so a server that sets neither starts as before', () => {
    const pins = readOperatorEnv({})
    expect(pins.xvncPath).toBeUndefined()
    expect(pins.cuaDriverPath).toBeUndefined()
  })

  it.each([
    ['relative/Xvnc'],
    ['/usr/bin/../bin/Xvnc'],
    ['/usr//bin/Xvnc'],
    ['/usr/bin/./Xvnc'],
    ['/usr/bin/'],
    ['C:\\Program Files\\Xvnc.exe'],
    ['\\usr\\bin\\Xvnc'],
  ])('still refuses a value that is not a plain absolute POSIX path (%j)', (value) => {
    expect(() => readOperatorEnv({ CLAWBOO_XVNC_PATH: value })).toThrow(OperatorSettingsError)
  })
})
