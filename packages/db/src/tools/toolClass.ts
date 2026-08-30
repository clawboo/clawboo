// What the SERVER says a tool does, independent of what a call claims.
//
// The approval card needs a floor it can trust. A tool name is written by
// whoever built the tool and an argument list is written by a model, so neither
// can be the basis for telling an operator that something is safe. A descriptor
// in the registry, on the other hand, was classified by the code that registered
// it, and every tool clawboo serves has one.
//
// This is the FLOOR, never the ceiling: a request may make a card look more
// serious than the class here, and may never make it look calmer.

/** The server's reading of a tool. */
export type ToolClass = 'read' | 'write' | 'destructive'

/** Classify from the annotations a descriptor carries. */
export function toolClassOf(d: { readOnly?: boolean; destructive?: boolean }): ToolClass {
  if (d.destructive === true) return 'destructive'
  if (d.readOnly === true) return 'read'
  // NOT read. An unannotated tool is assumed to change something, because the
  // cost of being wrong the other way is telling someone a write is a read.
  return 'write'
}

/**
 * A one-line summary of a tool, from its own description.
 *
 * Used when nothing else can name the action, which on a general platform is the
 * common case rather than the exception: an operator installs a connector nobody
 * wrote a phrasebook for, and "wants to use resolve-library-id" is not something
 * a person can consent to. The tool's first sentence usually is.
 */
export function toolSummaryOf(description: string, maxChars = 160): string | null {
  const flat = description.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  // First sentence, when there is a clear one and it is not the whole essay.
  const stop = flat.search(/\.\s/)
  const first = stop > 0 && stop < maxChars ? flat.slice(0, stop + 1) : flat
  return first.length > maxChars ? `${first.slice(0, maxChars).trimEnd()}...` : first
}
