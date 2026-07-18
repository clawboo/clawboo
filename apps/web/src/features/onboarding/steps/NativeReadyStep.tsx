// "Your team is ready" — the native first-run landing INSIDE the wizard.
//
// Renders the SHARED `MeetYourTeamCard`, the same card the marketplace path shows in
// `TeamOnboardingGate` phase A, so the two presentations of a freshly-deployed team
// cannot drift. Because this step IS the "meet your team" beat, `CreateTeamModal`
// pre-satisfies only the gate's welcome phase — the gate then opens directly on the
// user's self-introduction rather than replaying an identical welcome.
//
// The single primary action drops the user into the dashboard, landing in their team.

import { useEffect, useState } from 'react'
import { ArrowRight } from 'lucide-react'

import { listAgents } from '@clawboo/control-client'
import { NATIVE_STEPS } from '../StepIndicator'
import { OnboardingPrimary, OnboardingScreen } from '../OnboardingScreen'
import { MeetYourTeamCard, type TeamMemberLite } from '@/features/teams/MeetYourTeamCard'

export interface NativeReadyStepProps {
  /** The deployed team id (null only if the deploy somehow returned none). */
  teamId: string | null
  /** Enter the dashboard, landing in the deployed team. */
  onOpenDashboard: () => void
}

export function NativeReadyStep({ teamId, onOpenDashboard }: NativeReadyStepProps) {
  const [roster, setRoster] = useState<TeamMemberLite[]>([])
  const [booZeroAgent, setBooZeroAgent] = useState<TeamMemberLite | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        // Deliberately UNFILTERED: `listAgents({ teamId })` would filter out Boo Zero,
        // which is teamless by design — and Boo Zero is exactly what the card's
        // "Led by …" badge needs. Filter the roster client-side instead.
        const { agents, defaultId } = await listAgents()
        if (!alive) return

        const members = agents
          .filter((a) => teamId && a.teamId === teamId)
          .map((a) => ({ id: a.id, name: a.displayName }))
        if (members.length > 0) setRoster(members)

        // `defaultId` is the server's resolved Boo Zero (override → native → OpenClaw).
        // It only names the NATIVE leader because the team's agents were assigned
        // before this step ran, which is what makes `teamAgentPOST` create Boo Zero
        // eagerly. Absent that, this would read the OpenClaw `main` fallback.
        const bz = defaultId ? agents.find((a) => a.id === defaultId) : undefined
        if (bz) setBooZeroAgent({ id: bz.id, name: bz.displayName })
      } catch {
        /* best-effort — the card renders without the badge if this fails */
      }
    })()
    return () => {
      alive = false
    }
  }, [teamId])

  return (
    <OnboardingScreen
      testId="native-ready-step"
      step="ready"
      steps={NATIVE_STEPS}
      align="center"
      title="Your team is ready"
      subtitle={
        roster.length > 0
          ? `${roster.length} agent${roster.length === 1 ? '' : 's'} deployed and ready to work. Say hi whenever you are.`
          : 'Your team is deployed and ready to work. Say hi whenever you are.'
      }
    >
      {/* The shared card — title/body omitted because `OnboardingScreen` above
          already renders this step's heading and subtitle. */}
      <MeetYourTeamCard teamAgents={roster} booZeroAgent={booZeroAgent}>
        <OnboardingPrimary
          testId="native-open-dashboard"
          onClick={onOpenDashboard}
          className="w-full sm:w-auto"
        >
          Open my dashboard <ArrowRight size={16} />
        </OnboardingPrimary>
      </MeetYourTeamCard>
    </OnboardingScreen>
  )
}
