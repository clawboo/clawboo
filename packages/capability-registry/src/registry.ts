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
 * Split a capability id back into its owning source + raw key.
 *
 * PREFIX-MATCHES the closed `SOURCE_IDS` list — it does NOT split on the first
 * `:`, and the difference matters: `claude-code:x` contains no colon before the
 * source name ends, but a naive first-colon split would still be wrong the moment
 * a source id itself contains one. Prefix-matching also means an id whose source
 * is not registered returns null rather than a plausible-looking wrong route.
 *
 * A rawKey containing `:` survives either way, which is what the brokered ids
 * (`native:tool_registry:echo`) rely on.
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
