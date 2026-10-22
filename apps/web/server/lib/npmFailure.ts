/**
 * apps/web/server/lib/npmFailure.ts
 *
 * Turns the output of a failed `npm install` into one line a person can act
 * on, for the update chip. Without it the chip could only say "exit code 7",
 * which names npm's exit status and nothing about what went wrong.
 *
 * Pure: takes npm's combined stdout and stderr, returns a summary.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

/** npm's bookkeeping lines: not the reason, just the context around it. */
const CONTEXT =
  /^(code|errno|syscall|path|cwd|signal|command|A complete log|Log files were not written)\b/i

const MAX_DETAIL = 120

export interface NpmFailure {
  /** npm's error code (`ETARGET`, `EACCES`, ...), when it printed one. */
  code: string | null
  /** The reason, in one line, or null when the output names none. */
  detail: string | null
  /** The install was refused for lack of permission. */
  permission: boolean
}

function cap(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > MAX_DETAIL ? `${t.slice(0, MAX_DETAIL - 1)}…` : t
}

function sentence(text: string): string {
  const t = cap(text)
  const s = t.charAt(0).toUpperCase() + t.slice(1)
  return /[.!?…]$/.test(s) ? s : `${s}.`
}

export function summarizeNpmFailure(output: string): NpmFailure {
  const lines = output
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  // npm 7+ writes `npm error <text>`, npm 6 wrote `npm ERR! <text>`.
  const npmLines: string[] = []
  for (const line of lines) {
    const m = /^npm (?:error|ERR!)\s?(.*)$/.exec(line)
    if (m) npmLines.push(m[1]!.trim())
  }

  const code = npmLines.map((l) => /^code (\S+)/.exec(l)?.[1]).find(Boolean) ?? null
  const permission = /\b(EACCES|EPERM)\b|permission denied/i.test(output)

  // A package's own install script failed (a native build, usually). npm names
  // the package by its folder in the `path` line.
  if (npmLines.includes('command failed')) {
    const pkgPath = npmLines.map((l) => /^path (.+)$/.exec(l)?.[1]).find(Boolean)
    const pkg = pkgPath ? pkgPath.split(/[\\/]/).pop() : null
    return {
      code,
      permission,
      detail: pkg ? `The install script for ${pkg} failed.` : 'A package install script failed.',
    }
  }

  // `Error: EACCES: permission denied, mkdir '...'`: the most specific line.
  for (const line of npmLines) {
    const m = /(?:^|\s)[A-Za-z]*Error: (.+)$/.exec(line)
    if (m) return { code, permission, detail: sentence(m[1]!) }
  }

  // The first descriptive line. npm opens a block with a lowercase heading
  // word (`notarget No matching version...`, `network request to...`) and
  // repeats it on each line of the block. Drop the heading when it is followed
  // by a sentence or repeats.
  const described = npmLines.filter((l) => l && !CONTEXT.test(l) && !/^[[{]/.test(l))
  if (described.length > 0) {
    const first = described[0]!
    const heading = /^([a-z][a-z-]*)\s+(.+)$/.exec(first)
    const isHeading =
      heading !== null &&
      (/^[A-Z0-9]/.test(heading[2]!) ||
        described.filter((l) => l.startsWith(`${heading[1]} `)).length > 1)
    return { code, permission, detail: sentence(isHeading ? heading![2]! : first) }
  }

  // npm died before its own error handler ran (an uncaught exception): take the
  // exception's message line, e.g. `Error: ENOENT: no such file or directory, uv_cwd`.
  for (const line of lines) {
    const m = /^[A-Za-z]*Error: (.+)$/.exec(line)
    if (m) return { code, permission, detail: sentence(m[1]!) }
  }

  return { code, permission, detail: null }
}
