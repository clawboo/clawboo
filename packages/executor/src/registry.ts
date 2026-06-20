import type { RuntimeAdapter } from './types'

/**
 * The set of available runtime adapters, keyed by id. The set is open: OpenClaw
 * is the reference adapter today; future adapters (claude-code, codex, hermes,
 * or a human participant) register through the same interface.
 */
export class RuntimeRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>()

  register(adapter: RuntimeAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  unregister(id: string): void {
    this.adapters.delete(id)
  }

  get(id: string): RuntimeAdapter | undefined {
    return this.adapters.get(id)
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }

  ids(): string[] {
    return [...this.adapters.keys()]
  }

  list(): RuntimeAdapter[] {
    return [...this.adapters.values()]
  }
}
