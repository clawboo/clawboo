import type { AgentSource } from './source'
import type { RuntimeId } from './records'

/**
 * The catalog of AgentSources. Phase A holds exactly one (`OpenClawAgentSource`);
 * a future native runtime registers a second with the SAME interface. Mirrors
 * `RuntimeRegistry` in @clawboo/executor.
 */
export class AgentRegistry {
  private readonly sources = new Map<RuntimeId, AgentSource>()

  register(source: AgentSource): void {
    this.sources.set(source.id, source)
  }

  unregister(id: RuntimeId): void {
    this.sources.delete(id)
  }

  get(id: RuntimeId): AgentSource | undefined {
    return this.sources.get(id)
  }

  /** The default source. Phase A: the single registered source. Throws if none. */
  default(): AgentSource {
    const first = this.sources.values().next().value
    if (!first) throw new Error('AgentRegistry has no registered source')
    return first
  }

  has(id: RuntimeId): boolean {
    return this.sources.has(id)
  }

  list(): AgentSource[] {
    return [...this.sources.values()]
  }
}
