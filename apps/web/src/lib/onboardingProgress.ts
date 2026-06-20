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
const WIZARD_RUNTIME_KEY = 'clawboo.wizard.runtime'

/** The runtime the user picked on the "How do you want your agents to run?"
 *  step — persisted so a mid-wizard refresh resumes at the right step with the
 *  same selection. */
export type WizardRuntime = 'clawboo-native' | 'openclaw' | 'claude-code' | 'codex' | 'hermes'

const VALID_RUNTIMES: readonly WizardRuntime[] = [
  'clawboo-native',
  'openclaw',
  'claude-code',
  'codex',
  'hermes',
]

// localStorage exists but THROWS on access in storage-disabled contexts (Safari
// private mode, some embedded webviews). The `typeof window` guard isn't enough, so
// every access is wrapped: the persistence feature degrades to a no-op rather than
// crashing the onboarding wizard.
function safeLocalSet(key: string, value: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable — degrade to non-persistent */
  }
}

function safeLocalRemove(key: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(key)
  } catch {
    /* storage unavailable */
  }
}

function safeLocalGet(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Mark that a wizard run is in progress (idempotent). */
export function markWizardActive(): void {
  safeLocalSet(WIZARD_ACTIVE_KEY, '1')
}

/** Clear the in-progress marker — call on completion or when skipping to the
 * returning-user fast path. Also clears the persisted runtime selection. */
export function clearWizardActive(): void {
  safeLocalRemove(WIZARD_ACTIVE_KEY)
  safeLocalRemove(WIZARD_RUNTIME_KEY)
}

/** True when a wizard run started but hasn't been completed/cleared. */
export function isWizardActive(): boolean {
  return safeLocalGet(WIZARD_ACTIVE_KEY) === '1'
}

/** Persist the runtime the user picked (so a refresh resumes their selection). */
export function setWizardRuntime(runtime: WizardRuntime): void {
  safeLocalSet(WIZARD_RUNTIME_KEY, runtime)
}

/** The persisted runtime selection, or null if none picked yet / invalid. */
export function getWizardRuntime(): WizardRuntime | null {
  const v = safeLocalGet(WIZARD_RUNTIME_KEY)
  return v && (VALID_RUNTIMES as readonly string[]).includes(v) ? (v as WizardRuntime) : null
}

/**
 * The view GatewayBootstrap should land on for a returning/refreshing user —
 * the PURE decision, extracted so it can be unit-tested (the async I/O that
 * resolves the inputs stays in the effect).
 *
 * - `dashboard`           markOnboarded + clearWizardActive + show the app
 * - `dashboard-transient` show the app, preserve flags (status fetch failed)
 * - `wizard-fresh`        clear the stale onboarded flag + arm + show the wizard
 * - `wizard-resume`       keep the marker + resume the in-progress wizard
 * - `wizard-transient`    show the wizard WITHOUT arming the marker
 * - `native`             returning native (Gateway-free) user → native mode
 */
export type OnboardingViewDecision =
  | 'dashboard'
  | 'dashboard-transient'
  | 'wizard-fresh'
  | 'wizard-resume'
  | 'wizard-transient'
  | 'native'

export interface OnboardingDecisionInputs {
  /** `clawboo.onboarded` localStorage flag is set (completed before). */
  onboarded: boolean
  /** `/api/system/status` reported OpenClaw installed + configured + env present. */
  configured: boolean
  /** `/api/system/status` returned a usable response (false = transient failure). */
  statusKnown: boolean
  /** A wizard run is marked in-progress (`clawboo.wizard.active`). */
  wizardActive: boolean
  /** At least one team exists (only meaningful when `configured`). */
  hasTeam: boolean
  /** A clawboo-native agent exists (only meaningful when `statusKnown && !configured`). */
  hasNative: boolean
  /**
   * A non-OpenClaw runtime has a connected credential (`GET /api/runtimes` →
   * any `hasCredential`). Only meaningful when `statusKnown && !configured &&
   * !hasNative` — it's the durable on-disk proof that a user completed the
   * coding-agent onboarding path (which seeds no native agent and no team, so
   * neither `hasNative` nor `hasTeam` marks them as returning).
   */
  hasConnectedRuntime: boolean
}

export function decideOnboardingView(i: OnboardingDecisionInputs): OnboardingViewDecision {
  if (i.configured) {
    // Keep the user IN the wizard ONLY for a genuine mid-onboarding refresh: a
    // run is active, not completed, AND no team deployed yet (onboarding always
    // deploys one). Everyone else who's configured — a returning user (onboarded
    // OR a team already exists) — goes to the dashboard, clearing any STALE
    // marker a transient not-configured blip may have left behind.
    if (i.wizardActive && !i.onboarded && !i.hasTeam) return 'wizard-resume'
    return 'dashboard'
  }
  if (i.statusKnown) {
    // Definitively NOT configured. A native install lands in the dashboard. A
    // completed coding-agent user (finished the wizard → `onboarded`, with a
    // connected non-OpenClaw runtime) ALSO lands in the dashboard — they seed
    // no native agent and no team, so without this branch they'd be re-trapped
    // in a fresh wizard on every reload (which also wipes their `onboarded`
    // flag). The `onboarded &&` guard is load-bearing: a user who merely has a
    // provider env var (`hasConnectedRuntime`) but never onboarded still goes
    // through the wizard. Otherwise it's a fresh/uninstalled run → the wizard.
    if (i.hasNative) return 'native'
    if (i.onboarded && i.hasConnectedRuntime) return 'native'
    // A GENUINE mid-onboarding reload on a not-yet-configured path (native mid-
    // ConfigureNativeStep before any agent/team is seeded, a coding-agent at the
    // connectAgents step, or OpenClaw after chooseRuntime but before config lands):
    // RESUME at the persisted runtime's step rather than resetting to a fresh wizard
    // (which would wipe `onboarded` + drop the persisted runtime). Distinct from the
    // first-load fresh case (`wizardActive` false → wizard-fresh below).
    if (i.wizardActive && !i.onboarded) return 'wizard-resume'
    return 'wizard-fresh'
  }
  // Transient status failure — never trap. A returning user lands on the
  // dashboard (auto-connect retries); a genuine in-progress run resumes;
  // anything else shows the wizard without arming the marker.
  if (i.onboarded) return 'dashboard-transient'
  if (i.wizardActive) return 'wizard-resume'
  return 'wizard-transient'
}
