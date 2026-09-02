// Display metadata for the two OPEN unions: category and pack id.
//
// WHY THIS IS A FUNCTION AND NOT A MAP. `TemplateCategory` and `TemplateSource`
// used to be closed unions, so `Record<TemplateCategory, Meta>` typechecked as
// exhaustive and every call site indexed it directly. Opening the unions (so a
// third-party pack can bring a category without a Clawboo release) deletes that
// guarantee, and an unguarded index on a missing key returns `undefined` — which
// is what used to white-screen the Agents tab the moment an unknown domain
// reached `AGENT_DOMAIN_META[d].label`.
//
// `metaFor` and `sourceMetaFor` are TOTAL. They never return undefined. That is
// the whole contract, and it is what makes the open union safe.

/** What a chip, a badge, and a filter pill all need. */
export interface Meta {
  label: string
  /** Always #RRGGBB — see FALLBACK_HEX. */
  color: string
}

/**
 * The 19 categories Clawboo ships labels for. Not a closed set: it is the KNOWN
 * set, and `metaFor` derives a label and a colour for anything else.
 *
 * A pack that introduces a category outside this map must declare it in the
 * manifest's `newCategories`, which is what turns "new taxonomy value" into a
 * reviewable line in the content PR instead of a silent 20th filter chip.
 */
export const KNOWN_CATEGORY_META: Readonly<Record<string, Meta>> = {
  academic: { label: 'Academic', color: '#D946EF' },
  content: { label: 'Content', color: '#6366F1' },
  design: { label: 'Design', color: '#F43F5E' },
  devops: { label: 'DevOps', color: '#0EA5E9' },
  education: { label: 'Education', color: '#FBBF24' },
  engineering: { label: 'Engineering', color: '#3B82F6' },
  'game-dev': { label: 'Game Dev', color: '#EF4444' },
  general: { label: 'General', color: '#94A3B8' },
  marketing: { label: 'Marketing', color: '#EC4899' },
  ops: { label: 'Operations', color: '#64748B' },
  'paid-media': { label: 'Paid Media', color: '#F59E0B' },
  product: { label: 'Product', color: '#8B5CF6' },
  'project-management': { label: 'Project Management', color: '#0284C7' },
  research: { label: 'Research', color: '#A855F7' },
  sales: { label: 'Sales', color: '#F97316' },
  spatial: { label: 'Spatial', color: '#06B6D4' },
  specialized: { label: 'Specialized', color: '#78716C' },
  support: { label: 'Support', color: '#14B8A6' },
  testing: { label: 'Testing', color: '#10B981' },
}

/** The packs Clawboo ships. Same story: known, not closed. */
export const KNOWN_PACK_META: Readonly<Record<string, Meta>> = {
  clawboo: { label: 'Clawboo', color: '#34D399' },
  'clawboo-home': { label: 'Clawboo Life and Home', color: '#34D399' },
  'agency-agents': { label: 'Agency Agents', color: '#3B82F6' },
  // Derivation would give "Voltagent Subagents" and "Wshobson Agents".
  // Both labels come from the pack manifest's own `name`, and both colours from
  // its `provenance.color`, so the pill matches the pack's declared brand.
  'voltagent-subagents': { label: 'Research and Orchestration', color: '#F59E0B' },
  'wshobson-agents': { label: 'Engineering Agents', color: '#A855F7' },
  'clawboo-founder-sprint': { label: 'Founder Sprint', color: '#0EA5E9' },
  'coreyhaines-growth-marketing': { label: 'Growth Marketing', color: '#EC4899' },
  'mattpocock-craft': { label: 'Engineering Craft', color: '#84CC16' },
  'agricidaniel-repurpose': { label: 'Content Repurposing', color: '#22D3EE' },
  'alirezarezvani-business-desk': { label: 'Business and Compliance Desk', color: '#0D9488' },
  'blackforestlabs-visual-direction': { label: 'Image and Shot Direction', color: '#8B5CF6' },
  'calesthio-generative-media': { label: 'Generative Media Production', color: '#D946EF' },
  'charliehills-creator-studio': { label: 'Creator Studio', color: '#F472B6' },
  'craighewitt-creator-ops': { label: 'Creator and Founder Operations', color: '#14B8A6' },
  'google-ads-analytics': { label: 'Ads and Analytics', color: '#EA580C' },
  'heygen-presenter-video': { label: 'Presenter Video Studio', color: '#06B6D4' },
  'kgelster-storefront-catalog': { label: 'Storefront Catalog Ops', color: '#F97316' },
  'phuryn-product-craft': { label: 'Product Craft', color: '#7C3AED' },
  'thatrebeccarae-lifecycle-commerce': { label: 'Lifecycle Commerce', color: '#E11D48' },
}

/**
 * 6-DIGIT HEX ONLY.
 *
 * The cards build alpha variants by string concatenation — `${color}18`,
 * `${color}35` in AgentCard, TeamTemplateCard and AgentTemplateDetail — and
 * three tests assert `/^#[0-9A-Fa-f]{6}$/`. An `hsl(210 62% 55%)` fallback would
 * produce `hsl(210 62% 55%)18`, an invalid colour that silently renders
 * transparent rather than failing anywhere visible.
 */
const FALLBACK_HEX = [
  '#3B82F6',
  '#EC4899',
  '#F97316',
  '#8B5CF6',
  '#F43F5E',
  '#10B981',
  '#6366F1',
  '#14B8A6',
  '#FBBF24',
  '#0EA5E9',
  '#A855F7',
  '#78716C',
] as const

/** FNV-1a, so an unknown id keeps the same colour across reloads and machines. */
function hash(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** 'project-management' -> 'Project Management'. */
function titleize(id: string): string {
  const words = id.split(/[-_\s]+/).filter(Boolean)
  if (words.length === 0) return id
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function derive(id: string): Meta {
  return { label: titleize(id), color: FALLBACK_HEX[hash(id) % FALLBACK_HEX.length]! }
}

/** Never returns undefined. That is the whole contract. */
export function metaFor(
  id: string,
  known: Readonly<Record<string, Meta>> = KNOWN_CATEGORY_META,
): Meta {
  return known[id] ?? derive(id)
}

/** The same contract for a pack id. */
export function sourceMetaFor(
  packId: string,
  known: Readonly<Record<string, Meta>> = KNOWN_PACK_META,
): Meta {
  return known[packId] ?? derive(packId)
}

/** True when the taxonomy value is one Clawboo ships a label for. Used by the content gate. */
export function isKnownCategory(id: string): boolean {
  return id in KNOWN_CATEGORY_META
}
