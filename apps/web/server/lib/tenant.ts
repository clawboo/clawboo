import type { Request } from 'express'

/**
 * The ONE tenant-resolution site. Every write path that carries a `tenantId`
 * resolves it here — so a future hosted/multi-tenant build parameterizes tenancy
 * in a single place instead of sprinkling header/JWT parsing across the codebase.
 *
 * Single implicit tenant today → `null`. The `tenantId` columns are nullable with
 * no default, so returning `null` keeps every INSERT byte-identical to the
 * pre-seam behavior (this is a no-op in single-tenant by construction).
 *
 * This function body is the future parameterization point: a hosted build resolves
 * the tenant from the request's AUTHENTICATED identity (a verified JWT / session
 * established by real auth middleware — see `attachIdentity` in ./auth), NEVER a
 * spoofable raw header. Read scoping (tenant-scoped WHERE clauses) is deliberately
 * NOT done here — that is the future build; this seam is write-time only.
 */
export function getTenantId(_req: Request): string | null {
  return null
}
