/**
 * Runtime Node-version guard for the launcher.
 *
 * `engines.node` is advisory only — npm's EBADENGINE warning never blocks and
 * `npx` ignores it entirely. On an unsupported Node the launcher itself often
 * starts fine and the DETACHED server dies during boot, so the user just sees a
 * spinner time out with no reason. Fail fast, in the terminal, before we fork.
 *
 * The floor is 22.12 rather than 22.0 because the CLI is bundled as CJS and
 * `require()`s ESM-only dependencies (chalk 5, ora 8, @clack/prompts); Node
 * enabled `require(esm)` by default in 22.12, so 22.0–22.11 throw ERR_REQUIRE_ESM.
 */

export const MIN_NODE_MAJOR = 22
export const MIN_NODE_MINOR = 12

/** Parse `major.minor` from a `process.version`-shaped string ('v22.11.0'). */
export function parseNodeVersion(version: string): { major: number; minor: number } | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)/)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null
  return { major, minor }
}

/** True when `version` meets the supported floor. */
export function isSupportedNodeVersion(version: string): boolean {
  const parsed = parseNodeVersion(version)
  // An unrecognised runtime must never block a launch — fail open, not closed.
  if (parsed === null) return true
  if (parsed.major > MIN_NODE_MAJOR) return true
  if (parsed.major < MIN_NODE_MAJOR) return false
  return parsed.minor >= MIN_NODE_MINOR
}

/** An actionable message when `version` is below the floor, else null. */
export function nodeVersionError(version: string): string | null {
  if (isSupportedNodeVersion(version)) return null
  const floor = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`
  return (
    `Clawboo requires Node.js ${floor} or newer — this is ${version}.\n` +
    `Install a current Node from https://nodejs.org, or switch with a version manager ` +
    `(\`nvm install ${MIN_NODE_MAJOR}\` / \`fnm use ${MIN_NODE_MAJOR}\`), then run \`clawboo\` again.`
  )
}
