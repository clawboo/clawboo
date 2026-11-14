// Fill a website login into an agent's own browser, for the run's person.
//
// What the agent gets back is an outcome and nothing else: filled (with the names
// of the fields), no saved login, needs you, or refused (with a reason it can act
// on). Never a username, password or code, on any path, including the error ones:
// a value is held only inside `fillLogin`, goes into the page through the agent's
// browser connector (browserLink.ts), and is
// dropped when the call returns.
//
// Whose logins: the run's person's (runPerson.ts), and only theirs. A run with no
// person fills nothing. The live page's origin must be exactly the login's
// (pageFill.ts). A CAPTCHA, passkey or card check is for a person: until an agent's
// desktop can be taken over, the run's task is handed back to the person who asked
// (its card goes to Needs you), and a run with no task tells the agent to ask in
// the chat.

import { getTask, handBackTask, type ClawbooDb } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'

import { emitEvent } from '../obs/emit'
import type { RunPerson } from '../runPerson'
import { noteFilledValues } from './filledValues'
import { onePasswordLoginFor } from './onePassword'
import { loginOriginOf } from './origin'
import {
  errorClass,
  fillLoginOnPage,
  type FillBlocker,
  type FillField,
  type PageFillValues,
} from './pageFill'
import { loginSecretFor } from './store'
import { totpCode } from './totp'

const log = createLogger('website-logins')

export type NeedsYouReason = FillBlocker | 'login_source'

export type RefusedReason =
  | 'no_person'
  | 'invalid_site'
  | 'insecure_site'
  | 'no_browser'
  | 'browser_not_granted'
  | 'insecure_page'
  | 'certificate_unverifiable'
  | 'person_in_control'
  | 'not_on_site'
  | 'no_form'
  | 'failed'

export type FillOutcome =
  | { outcome: 'filled'; origin: string; fields: FillField[]; source: 'saved' | '1password' }
  | { outcome: 'no_saved_login'; origin: string }
  | {
      outcome: 'needs_you'
      origin: string
      reason: NeedsYouReason
      /** Fields already filled before the blocker, when there were any. */
      fields: FillField[]
      /** The run's task went back to its person (Needs you). */
      handedBack: boolean
    }
  | { outcome: 'refused'; origin: string | null; reason: RefusedReason }

export interface FillLoginInput {
  db: ClawbooDb
  agentId: string
  /** What the agent passed: a host, an origin or an address on the site. */
  site: string
  runPerson: RunPerson
  /** The run's board task, when it has one: a blocker hands it back. */
  taskId?: string | null
  /** The run's team, whose grants may give the agent its browser. */
  teamId?: string | null
}

const BLOCKER_WORDS: Record<NeedsYouReason, string> = {
  captcha: 'a CAPTCHA',
  passkey: 'a passkey',
  card_check: 'a card check',
  login_source: 'a login Clawboo could not read from 1Password',
}

/** What the person must do, in the words a Needs you card shows. */
export function needForPerson(origin: string, reason: NeedsYouReason): string {
  const host = new URL(origin).host
  if (reason === 'login_source') {
    return `Signing in to ${host} needs the 1Password connection fixed (Settings, Website logins). Then press Retry.`
  }
  return `Open this agent's page and take over its browser to finish signing in to ${host}: it asks for ${BLOCKER_WORDS[reason]}. Then press Retry.`
}

/**
 * Hand the run's task back to its person with what they must do, as the agent's own
 * `hand_back_task` would, and write the event that announces it. False when the task
 * could not be handed back (none, not the agent's, a routine's, or a person moved it).
 */
function handBack(
  db: ClawbooDb,
  taskId: string | null | undefined,
  agentId: string,
  need: string,
): boolean {
  if (!taskId) return false
  try {
    const r = handBackTask(db, taskId, { agentId, need })
    if (!r.ok) return false
    const task = getTask(db, taskId)
    // A move into Needs you is announced by its event, or no one is told.
    if (task) {
      emitEvent(db, {
        kind: 'status_changed',
        taskId: task.id,
        teamId: task.teamId,
        agentId,
        data: {
          to: task.status,
          reason: 'login_needs_person',
          actor: { kind: 'agent', agentId, execId: null },
        },
      })
    }
    return true
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.name : 'error', taskId }, 'login hand-back failed')
    return false
  }
}

/** Fill the run's person's login for `site` into the agent's own browser. */
export async function fillLogin(input: FillLoginInput): Promise<FillOutcome> {
  const parsed = loginOriginOf(input.site)
  if (!parsed.ok) {
    return {
      outcome: 'refused',
      origin: null,
      reason: parsed.reason === 'insecure' ? 'insecure_site' : 'invalid_site',
    }
  }
  const origin = parsed.origin
  const person = input.runPerson.person
  if (!person) return { outcome: 'refused', origin, reason: 'no_person' }
  const ownerId = person.id

  // The page first, the logins after: whether a login exists is answered only on a
  // page of that site showing a field to fill, so an agent cannot ask about sites
  // from anywhere else (every other page gets the same refusal either way).
  const held: { source: 'saved' | '1password'; sourceFailed: boolean } = {
    source: 'saved',
    sourceFailed: false,
  }

  // Every value is recorded for the masks before it leaves this process, so a
  // browser result that comes back while the fill is still running is masked too.
  const valuesFor = async (): Promise<PageFillValues | null> => {
    const saved = loginSecretFor(origin, ownerId)
    if (saved) {
      held.source = 'saved'
      const values = {
        username: saved.username,
        password: saved.password,
        oneTimeCode: saved.otpSecret ? totpCode(saved.otpSecret) : null,
      }
      noteFilledValues(input.agentId, [values.username, values.password, values.oneTimeCode])
      return values
    }
    const found = await onePasswordLoginFor(origin, ownerId)
    if (found.kind === 'failed') {
      held.sourceFailed = true
      return null
    }
    if (found.kind === 'none') return null
    held.source = '1password'
    noteFilledValues(input.agentId, [
      found.login.username,
      found.login.password,
      found.login.oneTimeCode,
    ])
    return {
      username: found.login.username,
      password: found.login.password,
      oneTimeCode: found.login.oneTimeCode,
    }
  }

  let result: Awaited<ReturnType<typeof fillLoginOnPage>>
  try {
    result = await fillLoginOnPage(
      { agentId: input.agentId, teamId: input.teamId ?? null },
      origin,
      valuesFor,
    )
  } catch (err) {
    log.warn({ agentId: input.agentId, err: errorClass(err) }, 'login fill failed')
    result = { kind: 'failed' }
  }
  const { source, sourceFailed } = held

  const needsYou = (reason: NeedsYouReason, fields: FillField[]): FillOutcome => ({
    outcome: 'needs_you',
    origin,
    reason,
    fields,
    handedBack: handBack(input.db, input.taskId, input.agentId, needForPerson(origin, reason)),
  })

  switch (result.kind) {
    case 'filled':
      if (result.blocker) return needsYou(result.blocker, result.fields)
      return { outcome: 'filled', origin, fields: result.fields, source }
    case 'blocked':
      return needsYou(result.blocker, [])
    case 'no_login':
      return sourceFailed ? needsYou('login_source', []) : { outcome: 'no_saved_login', origin }
    case 'not_on_site':
      return { outcome: 'refused', origin, reason: 'not_on_site' }
    case 'no_browser':
      return { outcome: 'refused', origin, reason: 'no_browser' }
    case 'not_granted':
      return { outcome: 'refused', origin, reason: 'browser_not_granted' }
    case 'insecure':
      return { outcome: 'refused', origin, reason: 'insecure_page' }
    case 'unverifiable':
      return { outcome: 'refused', origin, reason: 'certificate_unverifiable' }
    case 'person_in_control':
      return { outcome: 'refused', origin, reason: 'person_in_control' }
    case 'no_form':
      return { outcome: 'refused', origin, reason: 'no_form' }
    default:
      return { outcome: 'refused', origin, reason: 'failed' }
  }
}

const FIELD_WORDS: Record<FillField, string> = {
  username: 'username',
  password: 'password',
  one_time_code: 'one-time code',
}

function listFields(fields: FillField[]): string {
  const words = fields.map((f) => FIELD_WORDS[f])
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/**
 * What the agent reads. Built from the outcome alone, which holds no value, so no
 * path through here can quote one.
 */
export function outcomeText(o: FillOutcome): string {
  const host = o.origin ? new URL(o.origin).host : 'that site'
  switch (o.outcome) {
    case 'filled':
      return `filled: Clawboo filled the ${listFields(o.fields)} on ${host}. They are not in this answer; do not read them back from the page. Submit the form now (click the sign-in button).`
    case 'no_saved_login':
      return `no saved login: there is no login for ${o.origin} that this run may use. Ask the person who asked for this work to save one in Settings, Website logins, or sign in another way.`
    case 'needs_you': {
      const what =
        o.reason === 'login_source'
          ? 'the 1Password connection needs a person'
          : `${host} asks for ${BLOCKER_WORDS[o.reason]}`
      const filled = o.fields.length > 0 ? ` Clawboo filled the ${listFields(o.fields)} first.` : ''
      return o.handedBack
        ? `needs you: ${what}, which only a person can do.${filled} Clawboo handed this task back to the person who asked. Stop here: end your turn with one short line saying they need to finish signing in.`
        : `needs you: ${what}, which only a person can do.${filled} Stop here and tell the person, in your reply, to finish signing in to ${host} in your browser.`
    }
    case 'refused':
      switch (o.reason) {
        case 'no_person':
          return 'refused: this run belongs to no person, so it may use no saved login. Routine runs cannot sign in yet.'
        case 'invalid_site':
          return 'refused: site must be a web address or host name, for example example.com.'
        case 'insecure_site':
          return 'refused: logins are filled only on https sites.'
        case 'no_browser':
          return 'refused: you have no browser open. Open the site sign-in page in your browser first, then call fill_login again.'
        case 'browser_not_granted':
          return 'refused: you have not been given a browser (the Playwright or Chrome DevTools connector), so there is no page to fill. Ask a person to give you one.'
        case 'insecure_page':
          return `refused: the browser reports a certificate error on ${host}, so the page may not be the real site. Do not sign in there; tell the person.`
        case 'certificate_unverifiable':
          return `refused: this browser cannot show Clawboo the certificate of ${host}, so the page may not be the real site. Open the sign-in page with the Playwright browser tools and call fill_login again; if that is the browser you used, tell the person.`
        case 'not_on_site':
          return `refused: your current browser tab is not on ${o.origin}. Open its sign-in page in that tab first, then call fill_login again.`
        case 'person_in_control':
          return 'refused: a person has taken over your browser. Wait until they hand it back, then call fill_login again.'
        case 'no_form':
          return `refused: your page on ${host} shows no sign-in field to fill. Go to the sign-in form (or its next step) and call fill_login again.`
        default:
          return `refused: the fill on ${host} did not complete. Reload the sign-in page and try once more.`
      }
  }
}
