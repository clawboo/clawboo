// The three marks on the picker's chooser.
//
// SHOW THE THING, NOT A WORD FOR IT. A lucide glyph in a tinted square is the
// same picture whatever the row is about: swap the label and nothing else has to
// change, which is exactly why that treatment reads as filler. Each mark here is
// a miniature of what the row would actually add, so the chooser answers "what
// is behind this" before the label is read.
//
//   Connectors  the real brand marks already installed, fanned like a stack
//   Skills      three plates, because a skill has no logo and inventing one
//               would be the same lie a wrong brand mark tells
//   New agent   the Boo itself, which is the thing being created
//
// ONE GEOMETRY FOR ALL THREE. Same tile, same 32px, same fan, so the rows align
// down their left edge and the differences between them are all content. The
// tints are the canvas node accents the picker already borrows, so this reads as
// a map of the graph rather than a second palette invented for a menu.

import { memo } from 'react'
import { BooAvatar } from '@clawboo/ui'

import { brandColorVar, ConnectorGlyph } from '@/features/connectors/ConnectorMark'

/** The shared tile. Ground and hairline are both derived from one tint. */
function Tile({ tint, children }: { tint: string; children: React.ReactNode }) {
  return (
    <span
      className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[10px]"
      style={{
        background: `color-mix(in srgb, ${tint} 11%, transparent)`,
        // A hairline rather than a border, so the tile keeps its 32px box and
        // the three rows stay on one baseline.
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tint} 16%, transparent)`,
      }}
      aria-hidden
    >
      {children}
    </span>
  )
}

/**
 * The connectors already on this install, fanned.
 *
 * REAL MARKS, NOT A PICTURE OF A CABLE. The slugs come from the rows the picker
 * is about to show, so the tile is a preview of that list rather than a stock
 * illustration. Each sits on its own disc because brand colours are chosen
 * against a page and collide with each other when they touch.
 */
export const ConnectorsMark = memo(function ConnectorsMark({
  slugs,
  tint,
}: {
  slugs: readonly string[]
  tint: string
}) {
  // Three is what fits at 32px. Reversed so the first slug ends up in front:
  // later siblings paint over earlier ones.
  const shown = slugs.slice(0, 3)
  return (
    <Tile tint={tint}>
      <span className="flex items-center">
        {[...shown].reverse().map((slug, i) => (
          <span
            key={slug}
            className="flex size-[14px] items-center justify-center rounded-full bg-surface"
            style={{
              // Overlap, and lift each one over the last.
              marginLeft: i === 0 ? 0 : -5,
              zIndex: i,
              boxShadow: '0 0 0 1px color-mix(in srgb, var(--foreground) 9%, transparent)',
              color: brandColorVar(slug),
            }}
          >
            <ConnectorGlyph slug={slug} title="" size={9} />
          </span>
        ))}
      </span>
    </Tile>
  )
})

/**
 * Three plates, for the rows that have no logo to show.
 *
 * A skill is a capability rather than a brand, so the honest miniature is the
 * shape of a stack and not a borrowed identity. The fan matches the connector
 * marks exactly, which is what keeps the two rows reading as siblings.
 */
export const SkillsMark = memo(function SkillsMark({ tint }: { tint: string }) {
  const plates = [
    { rotate: -8, opacity: 0.4 },
    { rotate: 0, opacity: 0.68 },
    { rotate: 8, opacity: 1 },
  ]
  return (
    <Tile tint={tint}>
      <span className="flex items-center">
        {plates.map((p, i) => (
          <span
            key={p.rotate}
            className="size-[13px] rounded-[3.5px]"
            style={{
              marginLeft: i === 0 ? 0 : -4,
              transform: `rotate(${p.rotate}deg)`,
              background: tint,
              opacity: p.opacity,
              zIndex: i,
              boxShadow: '0 0 0 1px color-mix(in srgb, var(--surface) 55%, transparent)',
            }}
          />
        ))}
      </span>
    </Tile>
  )
})

/**
 * The Boo that would be created, with a plus on it.
 *
 * The mascot is already how an agent is drawn everywhere else in the app, so a
 * generic plus in a square was the one place an agent did not look like one.
 */
export const NewAgentMark = memo(function NewAgentMark({ tint }: { tint: string }) {
  return (
    <Tile tint={tint}>
      {/* A fixed seed, because this Boo is a picture of the idea of an agent
          rather than any particular one, and it should not change per render. */}
      <BooAvatar seed="new-agent" size={21} tint={tint} />
      <span
        className="absolute bottom-[3px] right-[3px] flex size-[11px] items-center justify-center rounded-full text-surface"
        style={{ background: tint }}
      >
        <svg viewBox="0 0 24 24" width={7} height={7} fill="none" stroke="currentColor">
          <path d="M12 5v14M5 12h14" strokeWidth={3.5} strokeLinecap="round" />
        </svg>
      </span>
    </Tile>
  )
})
