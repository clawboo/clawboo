// The fan-in over every registered CapabilitySource: ONE merged
// CapabilityRecord[] stream for reads (the single source of truth the Ghost
// Graph AND the Capabilities dashboard both consume), owner-routed writes. Mirror
// of @clawboo/scheduler's ScheduleMultiplexer.

import { UnknownCapabilityError } from './errors'
import type { CapabilityRecord, CapabilitySourceId } from './records'
import type { CapabilitySource, CapabilityWriteAction, SourceReadStatus } from './source'

const SOURCE_IDS: readonly CapabilitySourceId[] = [
  'native',
  'hermes',
  'claude-code',
  'codex',
  'openclaw',
]

/** Compose the source-namespaced capability id. */
export function makeCapabilityId(sourceId: CapabilitySourceId, rawKey: string): string {
  return `${sourceId}:${rawKey}`
}

/**
 * Split a capability id back into its owning source + raw key. Splits on the
 * FIRST `:` so a rawKey containing `:` survives — the source prefix is all the
 * multiplexer needs to route a write.
 */
export function parseCapabilityId(
  id: string,
): { sourceId: CapabilitySourceId; rawKey: string } | null {
  for (const sourceId of SOURCE_IDS) {
    const prefix = `${sourceId}:`
    if (id.startsWith(prefix) && id.length > prefix.length) {
      return { sourceId, rawKey: id.slice(prefix.length) }
    }
  }
  return null
}

export interface MergedCapabilityRead {
  records: CapabilityRecord[]
  sources: SourceReadStatus[]
}

export class CapabilityMultiplexer {
  private readonly sources = new Map<CapabilitySourceId, CapabilitySource>()

  register(source: CapabilitySource): void {
    this.sources.set(source.id, source)
  }

  list(): CapabilitySource[] {
    return [...this.sources.values()]
  }

  get(id: CapabilitySourceId): CapabilitySource | undefined {
    return this.sources.get(id)
  }

  /**
   * Fan-in read. Per-source try/catch: a source that violates its own
   * never-reject contract becomes a degraded status entry — the merge never
   * rejects, so one dead source can't take the inventory down.
   */
  async read(): Promise<MergedCapabilityRead> {
    const records: CapabilityRecord[] = []
    const sources: SourceReadStatus[] = []
    for (const source of this.sources.values()) {
      try {
        const result = await source.read()
        records.push(...result.records)
        sources.push(result.status)
      } catch (err) {
        sources.push({
          sourceId: source.id,
          ok: false,
          degraded: true,
          reason: err instanceof Error ? err.message : String(err),
          at: Date.now(),
        })
      }
    }
    return { records, sources }
  }

  /**
   * Owner-routed write. Routes by `spec.via` (install) or the id prefix
   * (enable/disable/approve) → the owning source. Unknown source → throws.
   * The manageability gate (per-RECORD here, unlike the scheduler's per-source
   * tier) is enforced UPSTREAM at the REST layer + defended inside each
   * source.write() (observe-only → unsupported()).
   */
  async write(action: CapabilityWriteAction): Promise<CapabilityRecord | null> {
    const sourceId =
      action.kind === 'install' ? action.spec.via : parseCapabilityId(action.id)?.sourceId
    if (!sourceId) {
      throw new UnknownCapabilityError(action.kind === 'install' ? '<install>' : action.id)
    }
    const source = this.sources.get(sourceId)
    if (!source) throw new UnknownCapabilityError(sourceId)
    return source.write(action)
  }
}
