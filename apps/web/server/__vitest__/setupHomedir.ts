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
// to be repeated in every suite added later, and it cannot fix a
// suite that DELIBERATELY deletes `HERMES_HOME` to exercise the `~/.hermes`
// fallback (the Hermes home tests do), so the only way to sandbox it is to move
// `os.homedir()` itself. One seam, applied uniformly,
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
import path from 'node:path'

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

// A CLAWBOO_WORK_DIR exported in the developer's shell would steer every suite's
// team folders and checkouts into that real folder, and a team-delete test
// removes `teams/<id>` from it. A suite that needs one sets it itself.
delete process.env['CLAWBOO_WORK_DIR']

// Likewise a CLAWBOO_RUNTIMES_DIR from the shell, or a real ~/clawboo-runtimes
// holding a Codex or OpenClaw Clawboo installed, would make every suite find
// that copy first (a Codex error then advises Settings instead of npm). So no
// suite sees one unless it makes its own: this folder is never created.
process.env['CLAWBOO_RUNTIMES_DIR'] = path.join(
  os.tmpdir(),
  `clawboo-test-no-runtimes-${process.pid}`,
  'runtimes',
)
