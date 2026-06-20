// @clawboo/obs — pure, browser-safe observability primitives. The OTel SDK is
// NEVER imported here; it is lazy-loaded server-side only when an OTLP endpoint
// is configured.
export * from './events/schema'
export * from './log/schema'
export * from './taxonomy/errors'
export * from './project/graph'
export * from './metrics'
export * from './judge/drive'
