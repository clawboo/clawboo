export type { AccessGate, AccessGateOptions, LaunchCode } from './access-gate'
export {
  ACCESS_TOKEN_CHARSET,
  createAccessGate,
  findUnsupportedTokenChar,
  isForwardedRequest,
} from './access-gate'

export type { OriginGuard, OriginGuardOptions } from './origin-guard'
export { createOriginGuard } from './origin-guard'

// How the guards read a request's path, for any other check that must agree
// with them and with the router.
export {
  anyPathUnder,
  everyPathUnder,
  isOriginFormTarget,
  requestPathReadings,
  targetPath,
} from './request-path'

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
