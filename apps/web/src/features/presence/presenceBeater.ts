// The dashboard's presence beat: tells the engine a person is here, so a host
// that stops the engine when nobody is using it can tell people from polling.
// An open board polls the API dozens of times a minute whether or not anyone is
// looking at it, so the engine counts only these beats (POST /api/system/presence;
// see server/lib/presence.ts).
//
// A tab beats while it is visible AND focused AND the person touched the page
// (pointer, keys, wheel, touch) within INPUT_IDLE_MS, every PRESENCE_BEAT_MS. The
// moment it stops being so (hidden, focus lost, or the person walked away) it sends
// one last beat saying so, then nothing until a person is back. A dashboard left
// focused on an unattended screen therefore stops counting after INPUT_IDLE_MS.
//
// Loading the page, or switching to its tab or window, counts too, but only for
// GLANCE_MS: a person who comes back to read counts before they click, while a
// window a desktop shell restores at login, or one left focused when the screen
// was locked, stops counting soon after unless someone touches it.

/** How often a tab with a person at it beats. The engine's presence window is three of these. */
export const PRESENCE_BEAT_MS = 20_000
/** No input for this long, and a focused tab stops counting as a person. */
export const INPUT_IDLE_MS = 15 * 60_000
/** How long a page load, or a switch to the tab or window, counts without input. */
export const GLANCE_MS = 2 * 60_000

export interface PresenceBeatBody {
  tabId: string
  visible: boolean
  focused: boolean
  acted?: boolean
}

export interface PresenceBeatDeps {
  tabId: string
  send: (body: PresenceBeatBody) => void
  now?: () => number
  isVisible: () => boolean
  hasFocus: () => boolean
}

export interface PresenceBeater {
  /** The interval's tick: beat while a person is here. */
  tick(): void
  /** Visibility or focus changed: say so at once. */
  changed(): void
  /** The person touched the page. */
  input(): void
  /** The page is going away (closed, reloaded, navigated off). */
  left(): void
}

export function createPresenceBeater(deps: PresenceBeatDeps): PresenceBeater {
  const now = deps.now ?? ((): number => Date.now())
  // The page was just opened or reloaded by someone.
  // When the person last touched the page. A load or a switch to the page counts
  // as a touch GLANCE_MS before the idle limit runs out, so only a short while.
  const glance = (): number => now() - INPUT_IDLE_MS + GLANCE_MS
  let lastInputAt = glance()
  let actedSinceBeat = false
  // What the last beat said, so a change is sent once and silence costs nothing.
  let lastSaidHere: boolean | null = null

  const here = (): boolean =>
    deps.isVisible() && deps.hasFocus() && now() - lastInputAt < INPUT_IDLE_MS

  const send = (isHere: boolean): void => {
    // An action counts even on the beat that says the person left: a click just
    // before switching away still means someone was here a moment ago.
    const acted = actedSinceBeat
    deps.send({
      tabId: deps.tabId,
      visible: deps.isVisible(),
      // Idle counts as not focused: the engine reads visible and focused as a person.
      focused: isHere,
      ...(acted ? { acted: true } : {}),
    })
    actedSinceBeat = false
    lastSaidHere = isHere
  }

  return {
    tick() {
      const isHere = here()
      if (isHere || lastSaidHere === true) send(isHere)
    },
    changed() {
      // Switching to this tab or window counts as a glance (see GLANCE_MS): someone
      // who comes back after a break is here before they click, for a while.
      if (lastSaidHere !== true && deps.isVisible() && deps.hasFocus()) {
        lastInputAt = Math.max(lastInputAt, glance())
      }
      const isHere = here()
      // Nothing said yet reads as not here: a tab that was never here stays silent.
      if (isHere !== (lastSaidHere ?? false)) send(isHere)
    },
    input() {
      lastInputAt = now()
      actedSinceBeat = true
      // Back after being away: say so now. Otherwise the next tick carries it.
      if (lastSaidHere !== true && here()) send(true)
    },
    left() {
      if (lastSaidHere === true) send(false)
    },
  }
}
