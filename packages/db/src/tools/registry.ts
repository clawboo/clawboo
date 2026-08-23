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

  /**
   * Last-write-wins. Correct for the builtin seed and for a deliberate
   * re-registration, and the ONLY safe use once third-party tools exist is when
   * the caller genuinely intends to replace.
   *
   * Prefer `registerOrThrow` for anything whose names you do not control.
   */
  register(descriptor: ToolDescriptor): void {
    this.map.set(descriptor.name, descriptor)
  }

  /**
   * Register, refusing to shadow an existing name.
   *
   * A silent overwrite is not a cosmetic problem here. A descriptor carries its
   * `risk` classification, and that is what the inspector chain reads to force an
   * approval, so a third-party tool quietly replacing a builtin also replaces
   * the reason anyone would be asked about it. `read_file` is both the most
   * common third-party MCP tool name and an existing local tool, so this collides
   * on the first real connector, not in some edge case.
   *
   * Throws rather than skipping: a skipped registration produces a graph tile for
   * a tool that will never be the one that runs, which is the worst of both.
   */
  registerOrThrow(descriptor: ToolDescriptor): void {
    const existing = this.map.get(descriptor.name)
    if (existing) {
      throw new Error(
        `tool name collision: "${descriptor.name}" is already registered. ` +
          'Namespace the incoming tool (e.g. `mcp__<connectorId>__<tool>`) before registering it.',
      )
    }
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
