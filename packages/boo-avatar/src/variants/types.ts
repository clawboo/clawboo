/**
 * The agent Boo variants: fixed brand artwork, one per runtime.
 *
 * These are not the generated mascot. `generateBooAvatar` draws a different Boo per agent seed;
 * a variant is one approved drawing that every agent on that runtime shares, so two Codex agents
 * look identical apart from their colour. Nothing here varies per seed.
 */

export type BooVariantId = 'codex' | 'claude' | 'hermes'

/** Which locked file to draw. Only Hermes ships two; the others use `light` for both surfaces. */
export type BooSurface = 'light' | 'dark'

export interface BooVariantMeta {
  id: BooVariantId
  /** The variant's product name, e.g. 'Codex Boo'. */
  label: string
  /** What a colour picker calls the variant's own colour, e.g. 'Codex blue'. */
  originalLabel: string
  /**
   * The variant's own colour, which is its default. `null` for Hermes, which is drawn in ink:
   * its original is not a brand hue but the absence of one.
   */
  originalColour: string | null
  /** svg height / width, so a caller can size the mark without parsing its viewBox. */
  aspect: number
}

export interface BooVariantRenderer {
  meta: BooVariantMeta
  /**
   * The variant's SVG, coloured to `tint`.
   *
   * `null` or `undefined` returns the locked artwork unchanged, byte for byte: the variant's own
   * colour is the default, not a fallback.
   */
  render(tint?: string | null): string
}
