/**
 * Reviewed REVIEW-severity injection findings in the marketplace catalog.
 *
 * A `review` finding is machine-directed content (a SQL statement, a shell
 * command) on a prose surface. It does not block, because security-education
 * material legitimately quotes the payloads it teaches people to reject, but it
 * must not pass silently either, so `scripts/catalog/validate.ts` fails unless
 * every review finding is listed here with a human reason.
 *
 * The fingerprint is `sha256(scope + rule label + the matched physical line)`,
 * whitespace-collapsed and lowercased. The scope is `<entry id>#<file>`, so
 * renaming an entry or editing the payload line forces a fresh review instead of
 * silent inheritance.
 *
 * Regenerate with: `tsx scripts/catalog/validate.ts --update-allowlist`
 * (then replace `pending-maintainer-signoff` with a real reviewer and write a
 * real `why` for every new row).
 */

export interface CatalogInjectionAllowlistEntry {
  /** `<catalog entry id>#<file>`, the scope the fingerprint was computed over. */
  entry: string
  /** The rule label that fired, e.g. `drop-table`. */
  rule: string
  /** Full 64-hex sha256. */
  fingerprint: string
  /** Why this is content, not an attack. */
  why: string
  reviewedBy: string
  /** ISO date. */
  reviewedAt: string
}

export const CATALOG_INJECTION_ALLOWLIST: readonly CatalogInjectionAllowlistEntry[] = [
  {
    entry: 'agency-engineering-code-reviewer#IDENTITY.md',
    rule: 'drop-table',
    fingerprint: '308ec7cf6e10034909a20ef9c7dd1e53366c6290da3f15ad1a83d8b581f0b9e8',
    why: 'Security-education content: an example review comment showing the SQL-injection payload the reviewer is being taught to flag. Prose inside a fenced block, never executed.',
    reviewedBy: 'pending-maintainer-signoff',
    reviewedAt: '2026-08-25',
  },
  {
    entry: 'agency-testing-api-tester#IDENTITY.md',
    rule: 'drop-table',
    fingerprint: '27ac7629d31812d3bfc02373fcfb186f502f729bff92dd8f225db9e1a249e253',
    why: 'Security-education content: a Playwright case asserting the API REJECTS an SQL-injection string. Prose inside a fenced block, never executed.',
    reviewedBy: 'pending-maintainer-signoff',
    reviewedAt: '2026-08-25',
  },
]
