// What a person hears when the server's person check does not recognise them.
//
// The check (server/lib/auth.ts) reads the marks a browser puts on the dashboard's
// own requests. A proxy can lose them: over plain http a browser sends only Origin,
// and a proxy that rewrites Host, as nginx does by default, makes the two disagree.
// The person is then refused, or a move goes through without their authority, so
// say what happened and what to do rather than let a card vanish or a run keep going.

import { useToastStore } from '@/stores/toast'

const UNSURE = 'Clawboo could not tell that this came from you in the dashboard'
const FIX =
  'If you reach it through a proxy over plain http, make the proxy pass the original Host header, or use https.'

export const PERSON_CHECK_REFUSED = `${UNSURE}, so it did not do this. ${FIX}`
export const PERSON_CHECK_MOVE = `The card moved, but ${UNSURE}, so any run on it keeps going. ${FIX}`
export const PERSON_CHECK_REPLY = `Your comment is saved, but ${UNSURE}, so it did not go to the agent as your reply. ${FIX}`

/** Long enough to read two sentences. */
const NOTICE_TTL_MS = 12_000
/** A bulk move or repeated clicks say it once. */
const REPEAT_AFTER_MS = 15_000

const lastShown = new Map<string, number>()

export function notePersonCheck(message: string): void {
  const now = Date.now()
  if (now - (lastShown.get(message) ?? -Infinity) < REPEAT_AFTER_MS) return
  lastShown.set(message, now)
  useToastStore.getState().addToast({ message, type: 'error', ttlMs: NOTICE_TTL_MS })
}

/** For tests: forget what was shown. */
export function resetPersonCheckNotices(): void {
  lastShown.clear()
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
