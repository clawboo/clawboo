// Redact-on-display: the server-side apply-site entry point.
//
// The canonical implementation lives in @clawboo/logger (the lowest-level package,
// so the pino instance there and this server share ONE implementation without a
// dependency inversion). This module re-exports it under the path the API response
// handlers import from. Apply `redactObject` to any response body that carries an
// event payload, audit entry, or trace span attribute BEFORE it is sent — masking
// credential-looking keys/values with a bullet string. Defense in depth: it sits
// downstream of the storage-layer scrub (@clawboo/db scrubSecrets) and never masks
// numeric telemetry (token counts / cost survive). See @clawboo/logger/redact.

export { redactObject, redactValue, redactJsonString, REDACTION_MASK } from '@clawboo/logger'
