// Typed errors the multiplexer + sources throw — the REST layer maps each to a
// status code (unknown → 404, unsupported → 422). Mirrors @clawboo/scheduler's
// error taxonomy.

import type { CapabilityManageability, CapabilitySourceId } from './records'

/** An action targeting an unknown source / unparseable capability id. */
export class UnknownCapabilityError extends Error {
  readonly code = 'unknown_capability'
  constructor(public readonly target: string) {
    super(`unknown capability source for: ${target}`)
    this.name = 'UnknownCapabilityError'
  }
}

/** A write aimed at a tier that forbids it (observe-only, or a source that can't install). */
export class UnsupportedCapabilityWriteError extends Error {
  readonly code = 'unsupported_capability_write'
  constructor(
    public readonly sourceId: CapabilitySourceId,
    public readonly action: string,
    public readonly manageability: CapabilityManageability,
  ) {
    super(`source '${sourceId}' cannot '${action}' a '${manageability}' capability`)
    this.name = 'UnsupportedCapabilityWriteError'
  }
}

/** The canonical throw every observe-only source.write() raises. */
export function unsupported(
  sourceId: CapabilitySourceId,
  action: string,
  manageability: CapabilityManageability = 'observe-only',
): never {
  throw new UnsupportedCapabilityWriteError(sourceId, action, manageability)
}
