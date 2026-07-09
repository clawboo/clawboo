// Team onboarding state — per-team flags + user-introduction text persisted
// in the settings key/value table. Tracks whether agents have introduced
// themselves and whether the user has introduced themselves to the team.
// Both flags must be true before the normal team chat composer is unlocked.
//
// `userIntroText` is the source of truth for the user's self-introduction.
// It's injected into the team context preamble on every group-chat message
// so the agent always sees it (independent of the unreliable Gateway
// SOUL.md persistence).

import type { Request, Response } from 'express'
import { chatMessages, createDb, getSetting, setSetting } from '@clawboo/db'
import { like } from 'drizzle-orm'
import { getDbPath } from '../lib/db'

interface OnboardingState {
  agentsIntroduced: boolean
  userIntroduced: boolean
  userIntroText: string
}

const DEFAULT_STATE: OnboardingState = {
  agentsIntroduced: false,
  userIntroduced: false,
  userIntroText: '',
}

function settingsKey(teamId: string): string {
  return `team-onboarding:${teamId}`
}

/** True when the team already has any group-chat history under a `agent:*:team:<id>`
 *  session key — i.e. it has been used. Such a team should NOT be re-gated behind the
 *  "Know Your Team" onboarding flow. (Post-S08b there is no agent-intro parade, so a
 *  genuinely new team has no chat until the user sends its first message, which happens
 *  only after the gate — so this cleanly distinguishes "used" from "brand-new".) */
function hasTeamChatActivity(db: ReturnType<typeof createDb>, teamId: string): boolean {
  const row = db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(like(chatMessages.sessionKey, `%:team:${teamId}`))
    .limit(1)
    .get()
  return row != null
}

export function readOnboardingState(
  db: ReturnType<typeof createDb>,
  teamId: string,
): OnboardingState {
  const raw = getSetting(db, settingsKey(teamId))
  if (!raw) return { ...DEFAULT_STATE }
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingState>
    return {
      agentsIntroduced: parsed.agentsIntroduced === true,
      userIntroduced: parsed.userIntroduced === true,
      userIntroText: typeof parsed.userIntroText === 'string' ? parsed.userIntroText : '',
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

// ─── GET /api/teams/:id/onboarding ──────────────────────────────────────────

export function teamOnboardingGET(req: Request, res: Response): void {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  try {
    const db = createDb(getDbPath())
    const state = readOnboardingState(db, teamId)
    // A team that already has chat history has clearly been used — don't re-gate it
    // behind the "Know Your Team" onboarding. Report it as onboarded (read-time
    // effective override; the stored flags are untouched) so the group chat opens
    // straight to its transcript instead of the "introduce yourself" gate.
    if ((!state.agentsIntroduced || !state.userIntroduced) && hasTeamChatActivity(db, teamId)) {
      res.json({ ...state, agentsIntroduced: true, userIntroduced: true })
      return
    }
    res.json(state)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PATCH /api/teams/:id/onboarding ────────────────────────────────────────
// Body: partial {
//   agentsIntroduced?: boolean,
//   userIntroduced?: boolean,
//   userIntroText?: string,
// }
// Merges with existing state and returns the updated full state.

interface PatchBody {
  agentsIntroduced?: boolean
  userIntroduced?: boolean
  userIntroText?: string
}

const MAX_USER_INTRO_CHARS = 4000

export function teamOnboardingPATCH(req: Request, res: Response): void {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  const body = req.body as PatchBody | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }
  try {
    const db = createDb(getDbPath())
    const current = readOnboardingState(db, teamId)
    const next: OnboardingState = {
      agentsIntroduced:
        typeof body.agentsIntroduced === 'boolean'
          ? body.agentsIntroduced
          : current.agentsIntroduced,
      userIntroduced:
        typeof body.userIntroduced === 'boolean' ? body.userIntroduced : current.userIntroduced,
      userIntroText:
        typeof body.userIntroText === 'string'
          ? body.userIntroText.slice(0, MAX_USER_INTRO_CHARS)
          : current.userIntroText,
    }
    setSetting(db, settingsKey(teamId), JSON.stringify(next))
    res.json(next)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
