import type { Request } from 'express'

/**
 * The ONE tenant-resolution site. Every write path that carries a `tenantId`
 * resolves it here, so tenancy is decided in one place.
 *
 * Single implicit tenant, so always `null`. The `tenantId` columns are nullable
 * with no default, so returning `null` keeps every INSERT byte-identical to the
 * pre-seam behavior. Never read a tenant from a raw request header: it is
 * spoofable. Reads are not tenant-scoped; this seam is write-time only.
 */
export function getTenantId(_req: Request): string | null {
  return null
}
