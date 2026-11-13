// The verify command line on Windows: the spawn seam takes no shell option, so
// the gate writes out what Node's own `shell: true` runs there. Checked on every
// platform by pretending to be Windows.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { verifyShellArgv } from '../deterministicGate'

vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  isWindows: true,
}))

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the verify command line on Windows', () => {
  it('is cmd.exe /d /s /c with the command quoted once, passed verbatim', () => {
    vi.stubEnv('ComSpec', 'C:\\Windows\\system32\\cmd.exe')
    expect(verifyShellArgv('npm test && echo "ok"')).toEqual({
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', '"npm test && echo "ok""'],
      windowsVerbatimArguments: true,
    })
  })

  it('falls back to cmd.exe without ComSpec', () => {
    vi.stubEnv('ComSpec', '')
    expect(verifyShellArgv('npm test')).toMatchObject({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '"npm test"'],
    })
  })

  it('gives a ComSpec that is not cmd.exe a plain -c, as Node does', () => {
    vi.stubEnv('ComSpec', 'C:\\tools\\bash.exe')
    expect(verifyShellArgv('npm test')).toEqual({
      command: 'C:\\tools\\bash.exe',
      args: ['-c', 'npm test'],
    })
  })
})
