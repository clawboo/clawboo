// ─── In-memory tool registry ────────────────────────────────────────────────
// Holds the executable descriptors (zod schema + executor) the broker + MCP
// server gate/inspect/run. `listVisible` applies availability so only usable
// tools reach the model's tools/list. Persistence of descriptor METADATA (for
// the UI + audit + the enabled/provenance columns) lives in `persistence.ts`;
// this in-memory registry is the source of executable truth.

import { evaluateAvailability } from './availability'
import { BUILTIN_TOOLS } from './builtins'
import type { AvailabilityContext, AvailabilityResult, ToolDescriptor } from './types'

export interface VisibleTool {
  descriptor: ToolDescriptor
  availability: AvailabilityResult
}

export class ToolRegistry {
  private readonly map = new Map<string, ToolDescriptor>()

  register(descriptor: ToolDescriptor): void {
    this.map.set(descriptor.name, descriptor)
  }

  unregister(name: string): void {
    this.map.delete(name)
  }

  get(name: string): ToolDescriptor | undefined {
    return this.map.get(name)
  }

  has(name: string): boolean {
    return this.map.has(name)
  }

  list(): ToolDescriptor[] {
    return [...this.map.values()]
  }

  /** Descriptors whose availability is satisfied under `ctx` (the tools/list set). */
  listVisible(ctx: AvailabilityContext): ToolDescriptor[] {
    return this.list().filter((d) => evaluateAvailability(d, ctx).visible)
  }

  /** Every descriptor + its availability verdict (for the UI's greyed-node view). */
  listWithAvailability(ctx: AvailabilityContext): VisibleTool[] {
    return this.list().map((descriptor) => ({
      descriptor,
      availability: evaluateAvailability(descriptor, ctx),
    }))
  }
}

/** A registry pre-loaded with the builtin tools. */
export function createBuiltinRegistry(): ToolRegistry {
  const reg = new ToolRegistry()
  for (const tool of BUILTIN_TOOLS) reg.register(tool)
  return reg
}
