import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Check } from 'lucide-react'

import { useTheme } from '@/features/theme/useTheme'
import {
  COLLECTION_IDS,
  PALETTE_RECIPES,
  collectionAnchorColor,
  generateTeamColors,
  type CollectionId,
} from '@/lib/teamPalettes'

interface TeamColorCollectionPickerProps {
  value: CollectionId
  onChange: (id: CollectionId) => void
}

/** Swatches previewed per collection — matches a typical ~8-Boo team. */
const PREVIEW_COUNT = 8

/**
 * Collection picker — users choose a generative *collection*, not individual
 * colors. Each option is a compact swatch-strip chip laid out in a single row;
 * the preview shows the colors a team of {@link PREVIEW_COUNT} Boos would get
 * (theme-adapted, so the preview matches the deploy). Dusty Pastel Pro is
 * pre-selected by the caller.
 */
export function TeamColorCollectionPicker({ value, onChange }: TeamColorCollectionPickerProps) {
  const { resolvedTheme } = useTheme()

  const previews = useMemo(
    () =>
      COLLECTION_IDS.map((id) => ({
        id,
        recipe: PALETTE_RECIPES[id],
        swatches: generateTeamColors(id, PREVIEW_COUNT, resolvedTheme),
        accent: collectionAnchorColor(id),
      })),
    [resolvedTheme],
  )

  return (
    <div>
      <p className="mb-2.5 text-[12px] leading-snug text-foreground/55">
        Each teammate gets a distinct, auto-generated color — pick a collection, not individual
        colors.
      </p>
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${previews.length}, minmax(0, 1fr))` }}
        role="radiogroup"
      >
        {previews.map(({ id, recipe, swatches, accent }, index) => {
          const selected = id === value
          return (
            <motion.button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={recipe.name}
              title={recipe.name}
              onClick={() => onChange(id)}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, delay: Math.min(index * 0.02, 0.4) }}
              className="relative flex min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-xl p-1.5 transition-all hover:border-border-strong"
              style={{
                background: selected ? `${accent}14` : 'var(--surface-raised)',
                border: `1px solid ${selected ? `${accent}aa` : 'var(--border)'}`,
                boxShadow: selected ? 'var(--shadow-floating)' : 'var(--shadow-raised)',
              }}
            >
              {/* Palette preview — the 8 colors as a vertical-stripe chip. */}
              <span
                className="flex h-9 w-full overflow-hidden rounded-md"
                style={{ boxShadow: 'inset 0 0 0 1px rgb(var(--foreground-rgb) / 0.08)' }}
              >
                {swatches.map((hex, i) => (
                  <span key={i} className="flex-1" style={{ background: hex }} />
                ))}
              </span>
              <span className="line-clamp-2 w-full break-words text-center text-[9px] font-medium leading-[1.15] text-foreground/80">
                {recipe.name}
              </span>
              {selected && (
                <span
                  className="absolute -right-1 -top-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full"
                  style={{ background: accent }}
                >
                  <Check className="h-2 w-2 text-white" strokeWidth={3.5} />
                </span>
              )}
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}
