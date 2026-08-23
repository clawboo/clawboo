// Tool-name scope matching. A hand-rolled `*` glob rather than a RegExp built
// from user input: the patterns come from a grant row that an agent can propose,
// so compiling them into a RegExp would hand an attacker the regex engine
// (catastrophic backtracking on a name the tool itself supplies).
//
// Only `*` is special, and it matches any run of characters including none.
// Everything else is literal: `.` and `-` are ordinary characters here, which
// matters because MCP tool names are full of both.

/** True when `name` matches a single `*`-glob pattern, anchored at both ends. */
export function matchesGlob(pattern: string, name: string): boolean {
  // Fast paths for the two overwhelmingly common shapes.
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === name

  const segments = pattern.split('*')
  const first = segments[0] ?? ''
  const last = segments[segments.length - 1] ?? ''

  if (!name.startsWith(first)) return false
  // The two anchors may overlap on a short name (`ab*b` vs `ab`), so the
  // remaining length check below is what rejects that, not `endsWith` alone.
  if (!name.endsWith(last)) return false
  if (first.length + last.length > name.length) return false

  // Walk the interior segments left to right, consuming the earliest match of
  // each. Greedy-from-the-left is correct for `*`-only globs and is linear.
  let cursor = first.length
  const end = name.length - last.length
  for (let i = 1; i < segments.length - 1; i++) {
    const segment = segments[i] ?? ''
    if (segment === '') continue
    const found = name.indexOf(segment, cursor)
    if (found === -1 || found + segment.length > end) return false
    cursor = found + segment.length
  }
  return true
}

/** True when ANY pattern matches. An empty list matches nothing. */
export function matchesAny(patterns: readonly string[], name: string): boolean {
  for (const pattern of patterns) {
    if (matchesGlob(pattern, name)) return true
  }
  return false
}

/**
 * The scope gate: is `name` inside this grant's tool scope?
 *
 * Deny is evaluated AFTER allow and always wins, so a grant can say "everything
 * except the two dangerous ones" without enumerating the rest.
 *
 * `allow: []` means NO tools, not all of them. That is the whole reason
 * `Grant.toolAllow` is a required field: an optional one would let a dropped
 * key read as "unrestricted", which is the failure mode this three-state design
 * exists to prevent.
 */
export function isToolInScope({
  allow,
  deny,
  name,
}: {
  allow: readonly string[]
  deny: readonly string[]
  name: string
}): boolean {
  if (matchesAny(deny, name)) return false
  return matchesAny(allow, name)
}
