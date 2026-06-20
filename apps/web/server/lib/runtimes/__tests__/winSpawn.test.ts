// Windows command-injection guard: an untrusted prompt passed to a .cmd/.bat
// shim must be quoted + caret-escaped so it cannot chain a second command, and a
// .exe target (or any non-Windows spawn) must pass argv through unchanged with no
// shell. `../../platform` is mocked to isWindows:true so the Windows branch runs
// on a POSIX CI host.

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../platform', () => ({ isWindows: true }))

const { escapeCmdArg, resolveWindowsSpawn } = await import('../winSpawn')

describe('escapeCmdArg — neutralizes cmd.exe metacharacters', () => {
  it('caret-escapes & so a prompt cannot chain a second command', () => {
    const out = escapeCmdArg('do X & calc.exe')
    expect(out).toContain('^&') // the & is caret-escaped
    expect(/(?<!\^)&/.test(out)).toBe(false) // no BARE & survives (every & is caret-prefixed)
  })

  it('escapes pipe, redirection, %VAR% expansion, ! and ^', () => {
    for (const ch of ['|', '>', '<', '%', '!', '^']) {
      const out = escapeCmdArg(`x ${ch} y`)
      expect(out).toContain(`^${ch}`)
    }
  })

  it('wraps the argument in double quotes (argv boundary protection)', () => {
    // The wrapping quotes are themselves caret-escaped (cmd strips them on parse).
    expect(escapeCmdArg('plain')).toContain('^"')
  })
})

describe('resolveWindowsSpawn', () => {
  it('leaves a .exe target as a plain argv spawn (no cmd.exe, no shell)', () => {
    const plan = resolveWindowsSpawn({ command: 'C:\\bin\\codex.exe', args: ['exec', 'do X & y'] })
    expect(plan.command).toBe('C:\\bin\\codex.exe')
    expect(plan.args).toEqual(['exec', 'do X & y']) // unchanged
    expect(plan.windowsVerbatimArguments).toBeUndefined()
  })

  it('routes a .cmd shim through cmd.exe with the prompt escaped', () => {
    const plan = resolveWindowsSpawn({
      command: 'C:\\bin\\codex.cmd',
      args: ['exec', 'do X & calc.exe'],
    })
    expect(plan.command).toBe(process.env['ComSpec'] || process.env['comspec'] || 'cmd.exe')
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(plan.windowsVerbatimArguments).toBe(true)
    const line = plan.args[3] ?? ''
    expect(line).toContain('^&') // the prompt's & is escaped inside the command line
    expect(/(?<!\^)&/.test(line)).toBe(false) // no bare & cmd could chain on
  })
})
