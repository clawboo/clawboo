import { rmSync } from 'node:fs'
import os from 'node:os'

/**
 * Removes the sandbox HOME created by `playwright.config.ts` once the e2e
 * run finishes (or fails). The path is read from `process.env.CLAWBOO_E2E_SANDBOX_HOME`
 * which was set at config-load time.
 *
 * Safety: only deletes paths that live under the OS temp dir. If something
 * has accidentally pointed this var at a real directory we silently no-op
 * rather than `rm -rf` someone's data.
 */
export default async function globalTeardown(): Promise<void> {
  const sandboxHome = process.env.CLAWBOO_E2E_SANDBOX_HOME
  if (!sandboxHome) return

  const tmpRoot = os.tmpdir()
  if (!sandboxHome.startsWith(tmpRoot)) {
    console.warn(
      `[e2e teardown] Refusing to remove ${sandboxHome} — not under ${tmpRoot}. ` +
        `Skipping cleanup as a safety measure.`,
    )
    return
  }

  try {
    rmSync(sandboxHome, { recursive: true, force: true })
  } catch (err) {
    // Best-effort cleanup. A leftover temp dir is annoying but harmless.

    console.warn(`[e2e teardown] Failed to remove sandbox ${sandboxHome}:`, err)
  }
}
