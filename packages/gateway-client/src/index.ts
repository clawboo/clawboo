export * from './types'
export * from './errors'
export { GatewayClient } from './client'
export * from './helpers'
// Shared by the server AND the browser SPA, which are separate build targets:
// apps/web/server may not import from apps/web/src, so anything both need lives
// in a package. This one writes the Gateway's own exec-approval policy.
export * from './execApprovals'
// device-auth is internal — not re-exported
