// Makes `$HOME` authoritative for `os.homedir()` on EVERY platform, for tests only.
//
// WHY THIS EXISTS (issue #140). Node resolves `os.homedir()` from `$HOME` on
// POSIX but from `%USERPROFILE%` on Windows. Every sandboxing suite in this
// server tree overrides `process.env.HOME` and nothing else, which is correct on
// POSIX and silently wrong on Windows: `resolveClawbooDir`, `defaultDbPath` and
// `userHermesHome` all route through `os.homedir()`, so on a Windows runner they
// resolved the developer's REAL home instead of the per-test temp dir. Every
// suite then shared one `C:\Users\<user>\.clawboo\clawboo.db`, which is what
// produced the cascading UNIQUE-constraint failures on the first Windows run.
//
// WHY A SHIM RATHER THAN PER-SUITE ENV. The alternative was adding a second
// override (USERPROFILE, or a per-resolver variable like CLAWBOO_HOME) to ~45
// beforeEach blocks. That is 45 chances to get a save/restore pair wrong, it has
// to be repeated in every suite added later, and it cannot fix
// `hermesDriver.test.ts` at all: that suite DELIBERATELY deletes `HERMES_HOME`
// (see its beforeEach) so it exercises the `~/.hermes` fallback, so the only way
// to sandbox it is to move `os.homedir()` itself. One seam, applied uniformly,
// is both smaller and harder to get wrong.
//
// SCOPE. This is a Vitest setup file. It is never bundled and never ships: the
// server's own `os.homedir()` behavior is untouched in production. On POSIX it
// is a no-op by construction, because `os.homedir()` already returns `$HOME`
// there, so it changes results on Windows only.
//
// SAFETY. Patching the `node:os` module object works because every homedir
// caller in this repo uses the `os.homedir()` member form rather than a named
// `import { homedir }`, which would bind the original function and bypass this.
// If you add a caller, use `os.homedir()`. The original is restored on exit so
// nothing leaks between Vitest's module registries.

import os from 'node:os'

const realHomedir = os.homedir

os.homedir = function sandboxedHomedir(): string {
  // `$HOME` first on every platform, then Windows' own variable, then the real
  // OS lookup. Falling through rather than returning '' matters: a suite that
  // never sandboxes a home must still see a genuine home directory.
  const home = process.env['HOME']?.trim()
  if (home) return home
  const profile = process.env['USERPROFILE']?.trim()
  if (profile) return profile
  return realHomedir()
}
