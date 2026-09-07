// Windows command-injection guard: an untrusted prompt passed to a .cmd/.bat
// shim must be quoted + caret-escaped so it cannot chain a second command, and a
// .exe target (or any non-Windows spawn) must pass argv through unchanged with no
// shell. `../../platform` is mocked to isWindows:true so the Windows branch runs
// on a POSIX CI host.
//
// Two DIFFERENT protections share one command line. Arguments are caret-escaped,
// so no bare metacharacter survives in them. The program token is wrapped in real
// double quotes instead, which make the substitution-phase metacharacters
// literal, so it legitimately carries a bare `&`. Assertions about carets must
// therefore be scoped to the arguments, never applied to the whole line.
// Quoting does NOT cover `%` or `!`: cmd substitutes those before quotes mean
// anything, so such a path is refused rather than quoted.

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../platform', () => ({ isWindows: true }))

const { escapeCmdArg, resolveWindowsSpawn } = await import('../winSpawn')

/**
 * The argument tail of a cmd.exe `/c` line, with the quoted program token removed.
 * A Windows file name cannot contain `"`, so the quote closing the program token
 * is the first one after the two that open the line.
 */
function argsPortion(line: string): string {
  const close = line.indexOf('"', 2)
  return close < 0 ? line : line.slice(close + 1)
}

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
    // Scoped to the ARGUMENTS. The program token is quote-protected rather than
    // caret-escaped, so a bare & inside it is correct and this assertion must not
    // reach it. See the &-bearing path test below.
    expect(/(?<!\^)&/.test(argsPortion(line))).toBe(false) // no bare & cmd could chain on
  })

  it('double-quotes the command token so a spaced or meta-bearing path stays one program', () => {
    const plan = resolveWindowsSpawn({
      command: 'C:\\Users\\Jo Doe\\bin (x86)\\codex.cmd',
      args: ['login'],
    })
    const line = plan.args[3] ?? ''
    // The program is one quoted token; inside real quotes cmd treats spaces and
    // parentheses as literal, so the path cannot split or start a group.
    expect(line.startsWith('""C:\\Users\\Jo Doe\\bin (x86)\\codex.cmd"')).toBe(true)
  })

  it('keeps an &-bearing command path one literal token, by quoting rather than caret-escaping', () => {
    // `&` is legal in a Windows path (the reserved set is < > : " / \ | ? *), so an
    // &-bearing install path is exactly as reachable as the spaced-username case.
    // Inside real double quotes cmd treats it as literal, so the program token
    // carries a BARE &, and the caret invariant applies to the arguments only.
    const command = 'C:\\Users\\A&B\\AppData\\Roaming\\npm\\codex.cmd'
    const plan = resolveWindowsSpawn({ command, args: ['login'] })
    const line = plan.args[3] ?? ''
    expect(line.startsWith(`""${command}"`)).toBe(true) // one quoted program token
    expect(line).not.toContain('^&') // the path's & is quote-protected, not caret-escaped
    expect(/(?<!\^)&/.test(argsPortion(line))).toBe(false) // arguments still carry no bare &
  })

  // `%` and `!` are substituted BEFORE quotes take effect, so unlike & they cannot
  // be made literal by the wrapping. main's caret pass happened to defeat %VAR% by
  // corrupting the variable name; quoting does not, so the path is refused instead.
  for (const { label, command } of [
    { label: '%VAR% expansion', command: 'C:\\tools\\%TEMP%\\codex.cmd' },
    { label: 'delayed !VAR! expansion', command: 'C:\\tools\\!TEMP!\\codex.cmd' },
  ]) {
    it(`refuses a command path cmd would substitute (${label})`, () => {
      expect(() => resolveWindowsSpawn({ command, args: ['login'] })).toThrow(/% or !/)
    })
  }

  it('refuses the substitutable path rather than emitting an expandable token', () => {
    // The regression guard: quoting alone would have produced a live %TEMP% pair
    // in the program position for cmd to expand.
    let line = ''
    try {
      line = resolveWindowsSpawn({ command: 'C:\\tools\\%TEMP%\\x.cmd', args: [] }).args[3] ?? ''
    } catch {
      line = ''
    }
    expect(/%[A-Za-z_][A-Za-z0-9_]*%/.test(line)).toBe(false)
  })

  it('refuses even a lone %, because the guard rejects on the character not the pair', () => {
    // Deliberately broader than strictly required. A lone % cannot expand on its
    // own, but pair-matching the guard would make it depend on cmd's scanner
    // behaviour, and a resolved binary path carrying % is pathological anyway.
    expect(() => resolveWindowsSpawn({ command: 'C:\\tools\\100%\\x.cmd', args: [] })).toThrow()
  })
})
