/**
 * apps/web/src/lib/onboardingProgress.ts
 *
 * Tracks whether a first-run onboarding wizard is IN PROGRESS — distinct from
 * `clawboo.onboarded`, which means the wizard was fully COMPLETED.
 *
 * Why both exist:
 *   - `clawboo.onboarded` → "the user finished onboarding; treat them as a
 *     returning user and skip the wizard." Set on wizard completion AND by
 *     GatewayBootstrap when it detects an already-configured OpenClaw (the
 *     v0.1.6 returning-user fast path).
 *   - `clawboo.wizard.active` (this module) → "a wizard run started but hasn't
 *     finished." Without it, a mid-onboarding refresh — e.g. right after the
 *     configure / start-gateway steps, when OpenClaw becomes 'configured' —
 *     would hit the returning-user fast path and dump the user on an empty
 *     dashboard, skipping the team-pick + deploy steps. With it, the bootstrap
 *     resumes the wizard instead.
 *
 * The `onboarded` flag wins over this marker for genuinely-returning users
 * (completed before): the bootstrap only resumes when active && !onboarded.
 */
const WIZARD_ACTIVE_KEY = 'clawboo.wizard.active'

/** Mark that a wizard run is in progress (idempotent). */
export function markWizardActive(): void {
  if (typeof window !== 'undefined') localStorage.setItem(WIZARD_ACTIVE_KEY, '1')
}

/** Clear the in-progress marker — call on completion or when skipping to the
 * returning-user fast path. */
export function clearWizardActive(): void {
  if (typeof window !== 'undefined') localStorage.removeItem(WIZARD_ACTIVE_KEY)
}

/** True when a wizard run started but hasn't been completed/cleared. */
export function isWizardActive(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(WIZARD_ACTIVE_KEY) === '1'
}
