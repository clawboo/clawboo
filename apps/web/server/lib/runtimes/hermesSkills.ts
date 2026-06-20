// READ-ONLY view over a Hermes home's native skills + a pure merge policy.
// A `syncSkills` writer is deliberately ABSENT (an explicit invariant, not an
// omission): clawboo NEVER writes into a Hermes home's skills dir — Hermes
// creates and curates its own skills, and cross-agent coordination reaches it
// through the MCP spine (Tasks/Memory/Tools), not by mutating its skill files.
// When clawboo-managed skills are merged into a run's view, the NATIVE skill
// wins on any name collision — clawboo never shadows a self-created skill.

import { readdir } from 'node:fs/promises'
import path from 'node:path'

export interface HermesSkillRef {
  name: string
  source: 'native' | 'managed'
}

/** Skill names under `<home>/skills` (dirs as-is, files extension-stripped).
 *  Read-only; `[]` when the dir is absent or unreadable. */
export async function listNativeSkills(home: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(home, 'skills'), { withFileTypes: true })
    return entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => (e.isDirectory() ? e.name : e.name.replace(/\.[^.]+$/, '')))
      .filter(Boolean)
      .sort()
  } catch {
    return []
  }
}

/** Merge native + clawboo-managed skill names. NATIVE WINS on name collision. */
export function mergeSkillSets(native: string[], managed: string[]): HermesSkillRef[] {
  const byName = new Map<string, HermesSkillRef>()
  for (const name of managed) byName.set(name, { name, source: 'managed' })
  for (const name of native) byName.set(name, { name, source: 'native' })
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
