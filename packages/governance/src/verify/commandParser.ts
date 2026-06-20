// Extract the task's deterministic verify command from the system-of-record.
// The scaffold writes `VERIFY_CMD='<shell-quoted>'` into init.sh and
// `` - Verify: `<cmd>` `` into VERIFICATION.md, with a known placeholder when the
// task author hasn't configured one. We parse the structured line — never scrape
// rendered output — and return null for the placeholder (an unconfigured task).

const PLACEHOLDER_MARKER = 'configure VERIFY_CMD'

/** Reverse the scaffold's bash single-quote escaping (`'\''` → `'`). */
function unquoteSingle(token: string): string {
  const t = token.trim()
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/'\\''/g, "'")
  }
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1)
  }
  return t
}

function rejectPlaceholder(cmd: string): string | null {
  const trimmed = cmd.trim()
  if (!trimmed) return null
  if (trimmed.includes(PLACEHOLDER_MARKER)) return null
  return trimmed
}

/** Parse `VERIFY_CMD='…'` out of an init.sh body. Returns null if absent or the placeholder. */
export function parseVerifyCommand(initShText: string): string | null {
  const m = initShText.match(/^\s*(?:export\s+)?VERIFY_CMD=(.+?)\s*$/m)
  if (!m) return null
  return rejectPlaceholder(unquoteSingle(m[1] ?? ''))
}

/** Parse the `` - Verify: `<cmd>` `` line out of a VERIFICATION.md body. */
export function parseVerifyCommandFromVerificationMd(md: string): string | null {
  const m = md.match(/^[-*]\s*Verify:\s*`([^`]+)`/m)
  if (!m) return null
  return rejectPlaceholder(m[1] ?? '')
}
