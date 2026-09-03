// BooThoughtBubble — what a Boo is doing, in a bubble above its head.
//
// Replaces the 280x170 card the node used to morph into while running. That
// card cost the mascot its identity at the exact moment it was most interesting
// (the character shrank to a 30px corner icon) and spent most of its area on
// nothing, because the only thing it carried that the circle does not already
// show below itself is ONE line of activity.
//
// So: the Boo stays a Boo, and the line moves into a bubble sized to its own
// contents. A thought bubble is also the honest metaphor, because the line is
// the agent's reasoning or its current tool call rather than a status field.
//
// ─── Why it is never still ──────────────────────────────────────────────────
//
// The bubble carries the ONE claim on this canvas that decays if it stops
// moving: "this agent is working right now". A frozen line cannot distinguish a
// busy agent from a hung one, so the pulse runs the whole time the run does and
// stops the instant it errors. It is the smallest honest animation available:
// three dots that mean exactly "still going", separated from the text so a new
// line never interrupts them.
//
// Everything else here changes only when the agent does something. The line
// tickers UP on arrival, the way a feed pushes an older item off the top, so a
// glance catches that something happened even if the words are missed.
//
// The bubble also renders with NO line at all. A reasoning model can think for
// ten seconds before its first tool call, and staying invisible through the
// longest part of a run is what made the old surface feel dead. "thinking"
// plus the pulse is both true and the most interesting thing to say.

import { memo } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { useBooActivity } from './useBooActivity'

/** Wide enough for a path like `editing pricing.css` on one line, narrow enough
 *  that a long command wraps rather than reaching the next Boo. */
const MAX_WIDTH = 208

/** The pulse. Three dots, staggered, for as long as the run lasts. */
const WorkingPulse = memo(function WorkingPulse({
  reduceMotion,
  stopped,
}: {
  reduceMotion: boolean | null
  stopped: boolean
}) {
  // A run that has stopped must not keep pulsing — the pulse is a claim about
  // the present, and an errored agent is doing nothing. It collapses to one
  // solid dot rather than vanishing, so the row keeps its shape.
  if (stopped) {
    return (
      <span
        aria-hidden
        style={{
          width: 3,
          height: 3,
          borderRadius: '50%',
          background: 'var(--primary)',
          flexShrink: 0,
        }}
      />
    )
  }
  return (
    <span
      aria-hidden
      style={{ display: 'inline-flex', alignItems: 'center', gap: 2.5, flexShrink: 0 }}
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          style={{
            width: 3,
            height: 3,
            borderRadius: '50%',
            background: 'rgb(var(--foreground-rgb) / 0.55)',
          }}
          animate={reduceMotion ? { opacity: 0.55 } : { opacity: [0.22, 1, 0.22] }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 1.15, repeat: Infinity, ease: 'easeInOut', delay: i * 0.16 }
          }
        />
      ))}
    </span>
  )
})

export const BooThoughtBubble = memo(function BooThoughtBubble({
  agentId,
  show,
  /** Half the Boo circle's width / height, so the bubble tracks a Boo that
   *  grew with its edge count instead of sitting at a fixed offset. */
  booW,
  booH,
}: {
  agentId: string
  show: boolean
  booW: number
  booH: number
}) {
  const reduceMotion = useReducedMotion()
  const activity = useBooActivity(agentId)

  // Reasoning is prose and reads in the body font; a tool call is a command and
  // reads in mono. Using one font for both made every line look like a command,
  // including sentences.
  const isReasoning = activity?.kind === 'thinking' || activity?.kind === 'streaming'
  // A tool call reads as a sentence. The picker hands back the bare label now,
  // so the bubble says "Using read_file" rather than printing an identifier at
  // the person watching. A board run's line is already phrased for a reader and
  // takes no verb.
  const line = !activity
    ? 'thinking'
    : activity.kind === 'tool'
      ? `Using ${activity.text}`
      : activity.text

  return (
    <div
      // Anchored to the FOOTPRINT rather than the floating layer, so the text
      // stays still while the Boo does its idle bob. A bobbing label is hard to
      // read and the bubble is the one part of this node that is words.
      style={{
        position: 'absolute',
        // The bubble's bottom-left corner must clear the circle's top-right
        // quadrant, or it sits ON the mascot's head. The circle's edge at 45deg
        // is at 0.35x its width from centre, so 0.42 puts the corner just
        // outside it and the puffs bridge the gap.
        left: `calc(50% + ${Math.round(booW * 0.42)}px)`,
        bottom: `calc(50% + ${Math.round(booH * 0.42)}px)`,
        zIndex: 3,
        pointerEvents: 'none',
      }}
      aria-hidden={!show}
    >
      <AnimatePresence>
        {show && (
          <motion.div
            // Grows out of the Boo's shoulder rather than fading in place.
            style={{ transformOrigin: 'bottom left' }}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.86, y: 6 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: 4 }}
            transition={
              reduceMotion ? { duration: 0 } : { duration: 0.26, ease: [0.32, 0.72, 0, 1] }
            }
          >
            {/* The two trailing puffs, small to large, leading up from the Boo.
                Drawn before the bubble so the bubble's shadow sits over them. */}
            <span
              aria-hidden
              className="surface-floating-tier"
              style={{
                position: 'absolute',
                left: -9,
                bottom: -11,
                width: 6,
                height: 6,
                borderRadius: '50%',
              }}
            />
            <span
              aria-hidden
              className="surface-floating-tier"
              style={{
                position: 'absolute',
                left: -3,
                bottom: -4,
                width: 10,
                height: 10,
                borderRadius: '50%',
              }}
            />

            <div
              className="surface-floating-tier"
              style={{
                // Sized by its contents, capped so a long command wraps instead
                // of running into the neighbouring Boo.
                width: 'max-content',
                maxWidth: MAX_WIDTH,
                padding: '6px 10px',
                borderRadius: 12,
                position: 'relative',
                display: 'flex',
                // Top, not centre: on a two-line entry the pulse belongs beside
                // the FIRST line, the way a bullet does.
                alignItems: 'flex-start',
                gap: 6,
              }}
            >
              {/* Outside the ticker on purpose. Inside it, every new line would
                  restart the stagger and the pulse would stutter exactly when
                  the agent is busiest. */}
              <span style={{ display: 'flex', alignItems: 'center', height: 15 }}>
                <WorkingPulse reduceMotion={reduceMotion} stopped={activity?.isError === true} />
              </span>

              {/* The ticker. `mode="wait"` so the outgoing line clears before
                  the next arrives: two lines crossing in a 200px bubble is
                  unreadable, and the beat between them is what registers as
                  "that changed". */}
              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={line}
                    initial={reduceMotion ? false : { opacity: 0, y: 7 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -7 }}
                    transition={
                      reduceMotion ? { duration: 0 } : { duration: 0.15, ease: [0.32, 0.72, 0, 1] }
                    }
                    style={{
                      margin: 0,
                      fontFamily: isReasoning || !activity ? 'inherit' : 'var(--font-mono)',
                      fontStyle: activity?.kind === 'thinking' || !activity ? 'italic' : 'normal',
                      fontSize: 10.5,
                      lineHeight: 1.45,
                      letterSpacing: '-0.01em',
                      color: activity?.isError
                        ? 'var(--primary)'
                        : 'rgb(var(--foreground-rgb) / 0.72)',
                      // Two lines maximum: a bubble that grows without bound
                      // would cover the graph it is meant to annotate.
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      wordBreak: 'break-word',
                    }}
                  >
                    {line}
                  </motion.p>
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})
