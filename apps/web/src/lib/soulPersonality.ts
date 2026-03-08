/**
 * Shared helpers for merging personality slider values into SOUL.md content.
 *
 * Personality sections are appended to the existing SOUL.md (preserving the
 * role description) below a `---` separator and a
 * `<!-- clawboo:personality ... -->` marker comment.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type PersonalityKey = 'verbosity' | 'humor' | 'caution' | 'speed_cost' | 'formality'
export type PersonalityValues = Record<PersonalityKey, number>

export const PERSONALITY_KEYS: PersonalityKey[] = [
  'verbosity',
  'humor',
  'caution',
  'speed_cost',
  'formality',
]

// ─── Dimension text generators ───────────────────────────────────────────────

interface Dimension {
  key: PersonalityKey
  label: string
  sectionText: (v: number) => string
}

const DIMENSIONS: Dimension[] = [
  {
    key: 'verbosity',
    label: 'Verbosity',
    sectionText: (v) => {
      if (v < 20)
        return 'Respond with the absolute minimum — single sentences where possible. No preamble, no summaries.'
      if (v < 40)
        return 'Keep responses brief and focused. Provide enough detail to be actionable, nothing more.'
      if (v < 60)
        return 'Balance brevity with clarity. Explain reasoning when it aids understanding, but avoid padding.'
      if (v < 80)
        return 'Provide thorough explanations with relevant examples and context. Cover the important nuances.'
      return 'Elaborate fully — explore edge cases, alternatives, and tradeoffs. Assume the reader wants depth.'
    },
  },
  {
    key: 'humor',
    label: 'Humor',
    sectionText: (v) => {
      if (v < 20)
        return 'Maintain a purely professional, no-nonsense tone. Focus on facts and substance.'
      if (v < 40) return 'Stay mostly professional but remain warm and approachable.'
      if (v < 60) return 'Be friendly and occasionally use light wit when it fits naturally.'
      if (v < 80) return 'Bring a playful energy — wordplay, light jokes, and banter are welcome.'
      return 'Lean into humor and creativity. Make it fun while still being genuinely helpful.'
    },
  },
  {
    key: 'caution',
    label: 'Caution',
    sectionText: (v) => {
      if (v < 20)
        return 'Act decisively with minimal caveats. Trust that the user knows what they want.'
      if (v < 40) return 'Proceed confidently but note any significant gotchas upfront.'
      if (v < 60)
        return 'Balance action with appropriate warnings. Flag risks without over-qualifying.'
      if (v < 80)
        return 'Highlight risks clearly. Prefer safe, reversible approaches and ask when uncertain.'
      return 'Treat every action as potentially consequential. Confirm before acting on anything irreversible.'
    },
  },
  {
    key: 'speed_cost',
    label: 'Speed vs Cost',
    sectionText: (v) => {
      if (v < 20)
        return 'Optimize for speed and capability. Use the most powerful model available without restraint.'
      if (v < 40)
        return "Lean toward speed. Use capable models and don't artificially constrain context."
      if (v < 60)
        return 'Balance speed and cost. Choose model and context proportionate to task complexity.'
      if (v < 80) return 'Prefer lighter models where quality allows. Keep context windows lean.'
      return 'Aggressively minimize costs. Use the smallest model that can handle the task.'
    },
  },
  {
    key: 'formality',
    label: 'Formality',
    sectionText: (v) => {
      if (v < 20)
        return "Communicate like you're chatting with a friend. Contractions, casual language, relaxed tone."
      if (v < 40) return 'Keep it conversational and warm, but stay focused and professional.'
      if (v < 60) return 'Friendly but professional. Clear and direct without being stiff.'
      if (v < 80)
        return 'Maintain a structured, professional tone. Complete sentences and proper grammar.'
      return 'Communicate with formal precision. Structured prose, no contractions, careful word choice.'
    },
  },
]

// ─── Marker ──────────────────────────────────────────────────────────────────

const PERSONALITY_MARKER = '<!-- clawboo:personality'

// ─── Public helpers ──────────────────────────────────────────────────────────

/**
 * Check whether SOUL.md content already contains a personality block.
 */
export function hasPersonalityBlock(content: string): boolean {
  return content.includes(PERSONALITY_MARKER)
}

/**
 * Strip any existing personality block from SOUL.md content.
 * The block starts at the `<!-- clawboo:personality` comment
 * (and any preceding `---` separator) and extends to the end of the file.
 */
export function stripPersonalityBlock(content: string): string {
  const idx = content.indexOf(PERSONALITY_MARKER)
  if (idx === -1) return content

  let stripFrom = idx
  const before = content.slice(0, idx)
  // Check for a preceding `---` separator (with optional whitespace)
  const separatorMatch = before.match(/\n---\s*\n?\s*$/)
  if (separatorMatch && separatorMatch.index !== undefined) {
    stripFrom = separatorMatch.index
  }

  return content.slice(0, stripFrom).trimEnd()
}

/**
 * Build the personality sections markdown block.
 */
export function buildPersonalityBlock(values: PersonalityValues): string {
  const meta = PERSONALITY_KEYS.map((k) => `${k}=${values[k]}`).join(' ')
  const sections = DIMENSIONS.map((d) => `## ${d.label}\n${d.sectionText(values[d.key])}`).join(
    '\n\n',
  )
  return `${PERSONALITY_MARKER} ${meta} -->\n\n${sections}`
}

/**
 * Merge personality sections into SOUL.md content.
 * Preserves the existing role description, strips any old personality block,
 * and appends the new one below a `---` separator.
 */
export function mergeSoulWithPersonality(
  existingContent: string,
  values: PersonalityValues,
): string {
  const base = stripPersonalityBlock(existingContent)
  const personalityBlock = buildPersonalityBlock(values)

  if (!base.trim()) {
    return `# SOUL\n\n${personalityBlock}\n`
  }

  return `${base}\n\n---\n\n${personalityBlock}\n`
}

/**
 * Type guard for personality values from SQLite JSON.
 */
export function isPersonalityValues(obj: unknown): obj is PersonalityValues {
  if (!obj || typeof obj !== 'object') return false
  const rec = obj as Record<string, unknown>
  return PERSONALITY_KEYS.every((k) => typeof rec[k] === 'number')
}

/**
 * Get the section text for a given dimension key and value.
 * Used by PersonalitySliders for the live description below each slider.
 */
export function getDimensionText(key: PersonalityKey, value: number): string {
  const dim = DIMENSIONS.find((d) => d.key === key)
  return dim ? dim.sectionText(value) : ''
}

/**
 * Get all dimension definitions (for rendering sliders).
 */
export function getDimensions(): readonly Dimension[] {
  return DIMENSIONS
}
