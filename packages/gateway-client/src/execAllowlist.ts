// Reading OpenClaw's exec allowlist without lying about what is in it.
//
// An allowlist row is not self-describing. Two entries that look almost
// identical on screen can differ by whether one field is present, and one of
// them grants a command forever while the other is skipped outright. A
// permissions screen that renders them the same way either frightens an operator
// about something inert or reassures them about something live.
//
// SO THE CLASSIFIER IS A TRANSCRIPTION, not an interpretation. Its branches come
// from `matchAllowlist` (openclaw/dist/exec-command-resolution-*.js:390-411): a
// rule that reads the entries differently from the engine enforcing them is worse
// than no rule at all.
//
// THERE ARE TWO ENGINES, and missing the second one is how this file was wrong on
// its first draft. `matchAllowlist` is not the only reader of these rows:
//
//   - `hasNodeAllowAlwaysCommandApproval` (bash-tools-*.js:1634) gates the
//     node-host allow-always path. It FIRST requires the `=node-command:<hash>`
//     row to be present, and only then checks that the pattern rows completely
//     cover the command.
//   - `hasExactCommandDurableExecApproval` (exec-approvals-*.js:198) matches a
//     `=command:<hash>` row, or any row whose stored `commandText` equals the
//     command.
//
// That makes an operator "Always" a PAIR, not a row plus litter. The marker
// authorizes nothing on its own, and the grant does not work without it, so
// deleting either half revokes. A first draft of this file called the marker
// inert and its test said deleting it "revokes nothing"; both were false in the
// direction that matters, since an operator acting on that would have deleted a
// load-bearing row believing it did nothing.
//
// The rest of `matchAllowlist`'s surprises:
//
//   - An `allow-always` entry with NO argPattern is skipped there:
//     `if (!entry.argPattern) { if (entry.source === "allow-always") continue; ... }`
//   - An `allow-always` entry whose argPattern is NOT a cwd-bound hash is also
//     skipped: `if (entry.source === "allow-always" &&
//     !isCwdBoundHashedArgPattern(entry.argPattern)) continue`. A hand-typed
//     pattern on an allow-always row is inert, and looks exactly like a live rule.
//   - A bare `*` grants everything, but ONLY when it is not an allow-always row
//     and carries no argPattern, via a short-circuit before the loop.

/** The only argPattern form an `allow-always` row is honoured with. */
export const EXEC_ALLOWLIST_CWD_BOUND_PREFIX = 'sha256:cwd-argv:v1:'

/**
 * The marker half of a mint, required by the node-host allow-always path.
 *
 * `=node-command:` + the first 16 hex of sha256 over the TRIMMED command text
 * (`buildNodeCommandApprovalPattern`, exec-approvals-*.js:189).
 */
export const EXEC_ALLOWLIST_NODE_MARKER_PREFIX = '=node-command:'

/**
 * The other marker form, read by `hasExactCommandDurableExecApproval`.
 *
 * Same hash construction, different prefix (`buildDurableCommandApprovalPattern`,
 * exec-approvals-*.js:186). It short-circuits the durable-approval requirement
 * entirely, so a row carrying it is live by itself.
 */
export const EXEC_ALLOWLIST_EXACT_COMMAND_PREFIX = '=command:'

export type ExecAllowlistClass =
  /** Operator-minted, bound to one argv in one directory. A real standing grant. */
  | 'bound-grant'
  /**
   * The companion row a mint produces. Authorizes nothing alone, and the
   * node-host path REQUIRES it, so removing it revokes the grant it belongs to.
   */
  | 'node-marker'
  /** `=command:<hash>`, honoured on its own by the durable-approval path. */
  | 'exact-command-grant'
  /** `allow-always` with no usable argPattern. The engine skips it. */
  | 'inert-allow-always'
  /** A configured rule: this program, any arguments, any directory. */
  | 'path-rule'
  /** A configured rule constrained by an argument pattern. */
  | 'arg-rule'
  /** A bare `*`, no argPattern, not allow-always. Any command at all. */
  | 'catch-all'
  /** Malformed or unreachable: no pattern, or a `*` the loop can never match. */
  | 'inert'

export interface ClassifiableEntry {
  pattern?: string
  argPattern?: string
  source?: string
  [key: string]: unknown
}

export function isCwdBoundArgPattern(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(EXEC_ALLOWLIST_CWD_BOUND_PREFIX)
}

/**
 * Which of `matchAllowlist`'s branches this entry would take.
 *
 * Written to follow that function's own order so the two can be compared clause
 * by clause when OpenClaw changes.
 */
export function classifyExecAllowlistEntry(entry: ClassifiableEntry): ExecAllowlistClass {
  const pattern = entry.pattern?.trim() ?? ''
  const allowAlways = entry.source === 'allow-always'
  const hasArgPattern = typeof entry.argPattern === 'string' && entry.argPattern.length > 0

  // `if (!pattern) continue`
  if (!pattern) return 'inert'

  // The pre-loop short-circuit: `entries.find(e => e.pattern?.trim() === "*" &&
  // !e.argPattern && e.source !== "allow-always")`, returned for any resolvable
  // command before a single entry is examined.
  if (pattern === '*' && !hasArgPattern && !allowAlways) return 'catch-all'

  // ALLOW-ALWAYS IS ITS OWN WORLD, and it is handled together so that every row
  // the engine skips reports as such. An operator needs one sentence for all of
  // them, "this Always is not in effect", and splitting them across labels by
  // which field happens to be missing would only surface the fields.
  if (allowAlways) {
    // Both marker forms are allow-always rows with no argPattern, so they must be
    // recognised BEFORE `matchAllowlist`'s skip is applied. That skip describes
    // only what that one function does with them; a different function is what
    // actually consults them.
    if (!hasArgPattern) {
      if (pattern.startsWith(EXEC_ALLOWLIST_EXACT_COMMAND_PREFIX)) return 'exact-command-grant'
      return pattern.startsWith(EXEC_ALLOWLIST_NODE_MARKER_PREFIX)
        ? 'node-marker'
        : 'inert-allow-always'
    }
    // `if (entry.source === "allow-always" && !isCwdBoundHashedArgPattern(...)) continue`
    if (!isCwdBoundArgPattern(entry.argPattern)) return 'inert-allow-always'
    // Even cwd-bound, a bare `*` reaches neither match test, so it can never fire.
    return pattern === '*' ? 'inert' : 'bound-grant'
  }

  // A bare `*` that carried an argPattern missed the short-circuit above, and
  // inside the loop it fails both match tests: it has no path selector, and the
  // basename branch is guarded by `pattern !== "*"`.
  if (pattern === '*') return 'inert'

  // `if (!pathOnlyMatch) pathOnlyMatch = entry`: this program, any arguments.
  if (!hasArgPattern) return 'path-rule'

  return 'arg-rule'
}

/**
 * Whether this row can let a command through ON ITS OWN.
 *
 * Deliberately not the same question as "does this row matter". A `node-marker`
 * answers false here and true to `affectsEnforcement`, because it authorizes
 * nothing by itself while the grant it belongs to stops working without it.
 * Collapsing the two would either present a companion row as a permission the
 * operator granted, or present it as litter they can safely delete. Both are
 * wrong, and the second is the one that quietly changes behaviour.
 */
export function isEffectiveExecGrant(entry: ClassifiableEntry): boolean {
  const cls = classifyExecAllowlistEntry(entry)
  return (
    cls === 'bound-grant' ||
    cls === 'exact-command-grant' ||
    cls === 'path-rule' ||
    cls === 'arg-rule' ||
    cls === 'catch-all'
  )
}

/**
 * Whether removing this row could change what the Boo is able to run.
 *
 * This is the question a revoke button needs answered, and it is broader than
 * `isEffectiveExecGrant` by exactly the companion markers.
 */
export function affectsEnforcement(entry: ClassifiableEntry): boolean {
  return isEffectiveExecGrant(entry) || classifyExecAllowlistEntry(entry) === 'node-marker'
}

/**
 * A stable handle for one entry, derived from its content.
 *
 * NOT THE ENTRY'S `id`. `parsePersistedExecApprovals` normalises on every parse
 * and `ensureAllowlistIds` mints a fresh UUID for any entry that lacks one, so an
 * id read in one call can differ from the id of the same entry in the next. A
 * revoke keyed on it would sometimes delete nothing and sometimes delete a
 * neighbour. Content is what OpenClaw itself dedupes a mint on.
 *
 * The separator is a NUL because it cannot occur in any of the three fields, so
 * no combination of values can be made to collide with a different combination.
 */
export function execAllowlistEntryKey(entry: ClassifiableEntry): string {
  return [entry.pattern ?? '', entry.argPattern ?? '', entry.source ?? ''].join('\u0000')
}
