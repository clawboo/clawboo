export type { AccessGate, AccessGateOptions } from './access-gate'
export { createAccessGate } from './access-gate'

export type { OriginGuard, OriginGuardOptions } from './origin-guard'
export { createOriginGuard } from './origin-guard'

export type { GatewayProxyHandle, ProxyOptions, UpstreamSettings } from './proxy'
export { createGatewayProxy } from './proxy'

// Device-auth primitives — surfaced so a NON-browser GatewayClient (the server-side
// AgentSource) can reuse the already-paired proxy device identity to sign its own
// connect frames (via the gateway-client `signConnect` hook).
export type { DeviceIdentity, ProxyDeviceFields } from './proxy-device-auth'
export {
  getProxyDeviceIdentityPath,
  loadOrCreateProxyDeviceIdentity,
  signConnectParams,
} from './proxy-device-auth'
