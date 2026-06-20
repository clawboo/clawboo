// The fan-in over every registered ScheduleSource: one merged ScheduleRecord[]
// stream for reads, owner-routed writes with the manageability + domain gates
// enforced BEFORE any source is touched.

import {
  TeamTaskDomainViolationError,
  UnknownScheduleError,
  UnsupportedScheduleWriteError,
} from './errors'
import type { ScheduleRecord, ScheduleSourceId } from './records'
import type { ScheduleSource, ScheduleSourceReadStatus, ScheduleWriteAction } from './source'

const SOURCE_IDS: readonly ScheduleSourceId[] = ['clawboo-routine', 'openclaw-gateway-cron']

export function makeScheduleId(source: ScheduleSourceId, raw: string): string {
  return `${source}:${raw}`
}

export function parseScheduleId(
  id: string,
): { source: ScheduleSourceId; sourceScheduleId: string } | null {
  for (const source of SOURCE_IDS) {
    const prefix = `${source}:`
    if (id.startsWith(prefix) && id.length > prefix.length) {
      return { source, sourceScheduleId: id.slice(prefix.length) }
    }
  }
  return null
}

export interface MergedScheduleRead {
  records: ScheduleRecord[]
  sources: ScheduleSourceReadStatus[]
}

export class ScheduleMultiplexer {
  private readonly sources = new Map<ScheduleSourceId, ScheduleSource>()

  register(source: ScheduleSource): void {
    this.sources.set(source.id, source)
  }

  list(): ScheduleSource[] {
    return [...this.sources.values()]
  }

  /**
   * Fan-in read. Per-source try/catch: a source that violates its own
   * never-reject contract becomes a degraded status entry — the merge never
   * rejects.
   */
  async read(): Promise<MergedScheduleRead> {
    const records: ScheduleRecord[] = []
    const sources: ScheduleSourceReadStatus[] = []
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
   * Owner-routed write. Gates IN ORDER: unknown source / unparseable id →
   * UnknownScheduleError; observe-only tier → UnsupportedScheduleWriteError;
   * a team-task create aimed at a runtime-own-life source →
   * TeamTaskDomainViolationError (defense-in-depth — the source refuses too).
   */
  async write(action: ScheduleWriteAction): Promise<ScheduleRecord | null> {
    const sourceId =
      action.kind === 'create' ? action.spec.source : parseScheduleId(action.id)?.source
    if (!sourceId) throw new UnknownScheduleError(action.kind === 'create' ? '<create>' : action.id)
    const source = this.sources.get(sourceId)
    if (!source) throw new UnknownScheduleError(sourceId)
    if (source.manageability === 'observe-only') {
      throw new UnsupportedScheduleWriteError(source.id, action.kind, source.manageability)
    }
    if (
      action.kind === 'create' &&
      action.spec.domain === 'team-task' &&
      source.domain !== 'team-task'
    ) {
      throw new TeamTaskDomainViolationError(source.id)
    }
    return source.write(action)
  }
}
