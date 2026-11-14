// Is a person here? A presence signal that counts people, not requests.
//
// For a host that stops this engine when nobody is using it and starts it again
// on demand. Request traffic cannot answer the question: an open board polls the
// API dozens of times a minute whether or not anyone is looking at it. So presence
// moves only on a beat a client sends on purpose (POST /api/system/presence):
//
//   - The dashboard beats while its tab is visible AND focused and the person has
//     touched the page (pointer, keys, wheel, touch) in the last 15 minutes, every
//     20 seconds, and once more the moment the tab is hidden or loses focus (see
//     the dashboard's presenceBeater).
//     A hidden or background tab sends nothing, so its polling never counts.
//   - A beat may say the person acted (`acted`), which counts for
//     PRESENCE_TTL_MS even after the tab goes away. Another client a person uses
//     (a phone app, a desktop shell) beats the same way.
//   - A write that is something a person does (answering an approval, sending a
//     chat message or a comment, starting, retrying or stopping a run) counts as
//     acting too, from whichever client sent it. See personActions for the list,
//     and for why a request a sign-in proxy vouched for does not count by itself.
//
// A person is present while some tab's latest beat said visible and focused and
// arrived within PRESENCE_TTL_MS, or a person acted within PRESENCE_TTL_MS. Reading
// any route, this one's GET included, never counts. Presence lives in memory: a
// restarted engine has seen nobody until the next beat.

/** How long a focused tab's beat, or an action, keeps a person present. */
export const PRESENCE_TTL_MS = 60_000
/** Tabs remembered at once. A beat from one more drops the stalest. */
export const PRESENCE_MAX_TABS = 64
/** A tab id: what a client names its own tab, so its later beats replace earlier ones. */
export const PRESENCE_TAB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export interface PresenceBeat {
  visible: boolean
  focused: boolean
  /** The person did something on the page since its last beat. */
  acted?: boolean
}

export interface PresenceState {
  /** A person is here: a focused tab beat, or a person acted, within PRESENCE_TTL_MS. */
  present: boolean
  /** The latest focused-tab beat or action, epoch ms; null when none since the engine started. */
  lastSeenAt: number | null
  /** The latest action a client reported, epoch ms; null when none since the engine started. */
  lastActedAt: number | null
  /** Tabs whose latest beat said visible and focused, within PRESENCE_TTL_MS. */
  focusedTabs: number
}

export interface Presence {
  beat(tabId: string, beat: PresenceBeat): PresenceState
  /** A person did something the server saw itself (see personActions). */
  acted(): void
  state(): PresenceState
}

/** A moment on both clocks, so a window can be measured on either. */
interface Stamp {
  wall: number
  tick: number
}

interface TabRecord {
  focused: boolean
  /** When its latest beat arrived. */
  at: Stamp
}

export interface PresenceClock {
  /** Wall-clock time, epoch ms: what `lastSeenAt` and `lastActedAt` report. */
  now?: () => number
  /** A clock that only moves forward. Defaults to `performance.now`; with only
   *  `now` given (a test's fake clock), that is used for both. */
  monotonic?: () => number
}

export function createPresence(deps: PresenceClock = {}): Presence {
  const now = deps.now ?? ((): number => Date.now())
  const monotonic = deps.monotonic ?? (deps.now ? deps.now : (): number => performance.now())
  const stamp = (): Stamp => ({ wall: now(), tick: monotonic() })
  // How long ago `then` was, as the larger of the two clocks' answers. The
  // monotonic clock never runs backwards, so a wall clock set back cannot stretch
  // a window; but it stops while the computer sleeps, so the wall clock, which
  // does not, keeps a beat from before a long sleep from reading as recent.
  const since = (then: Stamp, at: Stamp): number =>
    Math.max(at.tick - then.tick, at.wall - then.wall)
  const tabs = new Map<string, TabRecord>()
  let lastFocusedAt: number | null = null
  let lastActed: Stamp | null = null

  const prune = (at: Stamp): void => {
    for (const [id, tab] of tabs) if (since(tab.at, at) >= PRESENCE_TTL_MS) tabs.delete(id)
  }

  const state = (): PresenceState => {
    const at = stamp()
    prune(at)
    let focusedTabs = 0
    for (const tab of tabs.values()) if (tab.focused) focusedTabs += 1
    const actedRecently = lastActed !== null && since(lastActed, at) < PRESENCE_TTL_MS
    const lastActedAt = lastActed?.wall ?? null
    const lastSeenAt =
      lastFocusedAt === null
        ? lastActedAt
        : lastActedAt === null
          ? lastFocusedAt
          : Math.max(lastFocusedAt, lastActedAt)
    return { present: focusedTabs > 0 || actedRecently, lastSeenAt, lastActedAt, focusedTabs }
  }

  const act = (): void => {
    lastActed = stamp()
  }

  return {
    beat(tabId, beat) {
      const focused = beat.visible && beat.focused
      const at = stamp()
      // A Map keeps insertion order, so re-inserting makes this tab the newest and
      // the first key is always the stalest.
      tabs.delete(tabId)
      tabs.set(tabId, { focused, at })
      while (tabs.size > PRESENCE_MAX_TABS) {
        const stalest = tabs.keys().next().value
        if (stalest === undefined) break
        tabs.delete(stalest)
      }
      if (focused) lastFocusedAt = at.wall
      if (beat.acted) lastActed = at
      return state()
    },
    acted: act,
    state,
  }
}

let singleton: Presence | null = null

/** The process's presence record. */
export function presence(): Presence {
  singleton ??= createPresence()
  return singleton
}

/** Test-only: a fresh record (or the default one back with null). */
export function setPresenceForTests(next: Presence | null): void {
  singleton = next
}
