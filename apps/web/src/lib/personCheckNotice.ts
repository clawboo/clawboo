// What a person hears when the server's person check does not recognise them.
//
// In its usual mode the check (server/lib/auth.ts) reads the marks a browser puts on
// the dashboard's own requests. A proxy can lose them: over plain http a browser sends
// only Origin, and a proxy that rewrites Host, as nginx does by default, makes the two
// disagree. The person is then refused, or a move goes through without their
// authority, so say what happened and what to do rather than let a card vanish or a
// run keep going.
//
// A server can instead count only a person its sign-in proxy signed for
// (`personCheck: verified`). There the marks do not matter, and the fix is to open
// Clawboo through the proxy, so the same notices say that instead. The page learns
// the mode once it is open (`primePersonCheckMode`).

import { apiFetch } from '@clawboo/control-client'

import { useToastStore } from '@/stores/toast'

const UNSURE = 'Clawboo could not tell that this came from you in the dashboard'
const FIX =
  'If you reach it through a proxy over plain http, make the proxy pass the original Host header, or use https.'

export const PERSON_CHECK_REFUSED = `${UNSURE}, so it did not do this. ${FIX}`
export const PERSON_CHECK_MOVE = `The card moved, but ${UNSURE}, so any run on it keeps going. ${FIX}`
export const PERSON_CHECK_REPLY = `Your comment is saved, but ${UNSURE}, so it did not go to the agent as your reply. ${FIX}`

const UNSIGNED = 'this page is not signed in through your sign-in proxy'
const SIGN_IN = 'Open Clawboo at the address your sign-in proxy serves.'

/** The same notices on a server that counts only a person its sign-in proxy signed for. */
export const VERIFIED_REFUSED = `Clawboo did not do this: ${UNSIGNED}. ${SIGN_IN}`
export const VERIFIED_MOVE = `The card moved, but ${UNSIGNED}, so any run on it keeps going. ${SIGN_IN}`
export const VERIFIED_REPLY = `Your comment is saved, but ${UNSIGNED}, so it did not go to the agent as your reply. ${SIGN_IN}`
/** Said once when such a page opens with nobody signed in. */
export const VERIFIED_NOBODY = `You can look around, but ${UNSIGNED}, so nothing you do here acts as you: answering approvals, moving cards and taking over a screen are refused. ${SIGN_IN}`

const UNDER_VERIFIED: Record<string, string> = {
  [PERSON_CHECK_REFUSED]: VERIFIED_REFUSED,
  [PERSON_CHECK_MOVE]: VERIFIED_MOVE,
  [PERSON_CHECK_REPLY]: VERIFIED_REPLY,
}

/** How the server checks a person, once the page has read it. */
let mode: 'page' | 'verified' = 'page'
let priming: Promise<void> | null = null

/** Long enough to read two sentences. */
const NOTICE_TTL_MS = 12_000
/** A bulk move or repeated clicks say it once. */
const REPEAT_AFTER_MS = 15_000

const lastShown = new Map<string, number>()

export function notePersonCheck(message: string): void {
  const now = Date.now()
  if (now - (lastShown.get(message) ?? -Infinity) < REPEAT_AFTER_MS) return
  lastShown.set(message, now)
  const shown = mode === 'verified' ? (UNDER_VERIFIED[message] ?? message) : message
  useToastStore.getState().addToast({ message: shown, type: 'error', ttlMs: NOTICE_TTL_MS })
}

/**
 * Read once how the server checks a person, so the notices give the right fix,
 * and say so at once when it counts only a person its sign-in proxy signed for
 * and this page has none. Called when the dashboard opens. A read that fails
 * leaves the usual notices.
 */
export function primePersonCheckMode(): Promise<void> {
  priming ??= (async () => {
    try {
      const res = await apiFetch('/api/access/identity')
      if (!res.ok) return
      const body = (await res.json()) as { personCheck?: unknown; person?: unknown }
      if (body.personCheck !== 'verified') return
      mode = 'verified'
      if (body.person == null) notePersonCheck(VERIFIED_NOBODY)
    } catch {
      // The usual notices stand.
    }
  })()
  return priming
}

/** For tests: forget what was shown, and the mode read. */
export function resetPersonCheckNotices(): void {
  lastShown.clear()
  mode = 'page'
  priming = null
}

/** The refusal's body, whichever route it came from. */
export async function isPersonOnlyRefusal(res: Response): Promise<boolean> {
  if (res.status !== 403) return false
  try {
    const body = (await res.clone().json()) as { error?: unknown } | null
    return body?.error === 'person_only'
  } catch {
    return false
  }
}

/** Responses the notice leaves out. The decision history: by the time it is posted,
 *  the answer has already reached the Gateway, so "did not do this" would be untrue.
 *  Read marks: opening a task sends one, so the person did not ask for anything. */
const NOT_ASKED_FOR = /\/api\/(?:approvals|board\/(?:inbox\/read|[^/?#]+\/read))(?:[?#]|$)/

/** Look at every API response for a person-check refusal. */
export function watchForPersonCheckRefusal(res: Response): void {
  if (res.status !== 403 || NOT_ASKED_FOR.test(res.url)) return
  void isPersonOnlyRefusal(res).then((refused) => {
    if (refused) notePersonCheck(PERSON_CHECK_REFUSED)
  })
}
