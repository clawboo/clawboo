// Real team selection + deployment — the onboarding "Team" beat. Replaces the
// old auto-seeded "Team Lead + Coder" placeholder: the user browses the full
// marketplace of team templates, picks one, customizes it, and deploys it. It
// reuses the ONE real deploy engine (CreateTeamModal) so onboarding and the
// in-app "Create team" flow never drift.
//
// The wizard's PRIMARY runtime is already connected (previous step) — a native
// provider key, or Codex via Sign in with ChatGPT — so every picked team deploys
// FULLY on that runtime, server-orchestrated — enforced by `preferRuntime`, NOT
// inferred.
//
// It used to be inferred, and that was wrong: the reasoning was "the wizard has no
// live Gateway client, so CreateTeamModal's openclaw-availability check resolves
// false". But that check is `client != null || serverOpenclawConnected`, and the
// second term is the SERVER's operator connection — entirely independent of the
// wizard. So a first-run user whose Gateway was reachable deployed their first team
// onto OpenClaw, which (a) fails outright if that Gateway is not actually usable and
// (b) leaves the team with no member on the connected runtime, so the OpenClaw
// `main` fallback led the team.
//
// "Start from scratch" is disabled here (a blank team deploys no agents, which would
// leave a first-run user with an empty, leaderless workspace). Only the gate's
// WELCOME phase is pre-satisfied — `NativeReadyStep` is that beat — so the user still
// introduces themselves before landing in the team space.

import { useState } from 'react'
import { ArrowLeft, ArrowRight, Users } from 'lucide-react'

import { NATIVE_STEPS } from '../StepIndicator'
import { OnboardingGhost, OnboardingPrimary, OnboardingScreen } from '../OnboardingScreen'
import { CreateTeamModal } from '@/features/teams/CreateTeamModal'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

export interface SelectTeamStepProps {
  /** Fired with the deployed team's id once a team is created. */
  onDeployed: (teamId: string | null) => void
  /** Back to the connect step. */
  onBack: () => void
  /** The wizard's PRIMARY connect choice — every agent defaults to it. Defaults to
   *  native (the provider-key path); 'codex' for Sign in with ChatGPT. */
  primaryRuntime?: 'clawboo-native' | 'codex'
}

export function SelectTeamStep({
  onDeployed,
  onBack,
  primaryRuntime = 'clawboo-native',
}: SelectTeamStepProps) {
  // Open the team marketplace immediately — the whole point of this step. If the
  // user closes it without deploying, this screen stays visible so they can reopen.
  const [browseOpen, setBrowseOpen] = useState(true)

  return (
    <>
      <OnboardingScreen
        testId="select-team-step"
        step="team"
        steps={NATIVE_STEPS}
        align="center"
        title="Choose your first team"
        subtitle={
          primaryRuntime === 'codex'
            ? 'Pick a ready-made crew from the marketplace and deploy it. Your agents run on Codex with your ChatGPT subscription. You can add more teams anytime.'
            : 'Pick a ready-made crew from the marketplace and deploy it. Your agents run natively, no extra setup. You can add more teams anytime.'
        }
        footer={
          <div className="flex items-center justify-between">
            <OnboardingGhost testId="select-team-back" onClick={onBack}>
              <ArrowLeft size={15} /> Back
            </OnboardingGhost>
            <OnboardingPrimary testId="select-team-browse" onClick={() => setBrowseOpen(true)}>
              Browse teams <ArrowRight size={16} />
            </OnboardingPrimary>
          </div>
        }
      >
        <div
          className="flex flex-col items-center gap-3 rounded-2xl p-8 text-center"
          style={{ background: muted(0.035), border: `1px solid ${muted(0.07)}` }}
        >
          <span
            className="flex h-12 w-12 items-center justify-center rounded-xl"
            style={{ background: 'rgb(var(--primary-rgb) / 0.1)', color: 'var(--primary)' }}
          >
            <Users size={22} />
          </span>
          <p className="max-w-[38ch] text-[13px] leading-relaxed" style={{ color: muted(0.6) }}>
            Browse curated teams for marketing, engineering, research and more, then deploy the one
            that fits. It only takes a moment.
          </p>
        </div>
      </OnboardingScreen>

      <CreateTeamModal
        isOpen={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onCreated={(teamId) => {
          setBrowseOpen(false)
          onDeployed(teamId ?? null)
        }}
        presatisfyOnboardingGate
        allowStartFromScratch={false}
        preferRuntime={primaryRuntime}
      />
    </>
  )
}
