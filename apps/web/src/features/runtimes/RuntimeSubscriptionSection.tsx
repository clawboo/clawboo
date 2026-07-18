// The "add your ChatGPT subscription" section for an ALREADY-CONNECTED Hermes /
// OpenClaw runtime — the later, add-anytime counterpart to the initial-connect
// sign-in. The subscription is an ADDITIONAL credential (Hermes gains
// openai-codex models beside its OpenRouter key; OpenClaw gains an oauth profile
// its agents can run on), so it stays offer-able after the runtime is connected.
//
// Three detection-gated states, no new backend:
//   - connected (the sub is already present) → a calm confirmation, no action.
//   - addable (Codex is connected, this runtime lacks the sub) → the existing
//     ChatGptSignIn flow; on success the host re-probes and this flips to
//     connected with no reload.
//   - Codex not connected → a subtle "connect Codex first" hint (Codex is
//     connected on its own row / the Providers panel).

import { ArrowRight } from 'lucide-react'

import { ChatGptConnected, ChatGptSignIn } from './ChatGptSignIn'
import type { CliLoginTool } from '@clawboo/control-client'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

export interface RuntimeSubscriptionSectionProps {
  tool: Extract<CliLoginTool, 'hermes' | 'openclaw'>
  /** Display name of the host runtime (e.g. "Hermes", "OpenClaw"). */
  name: string
  /** The manual terminal command, shown by ChatGptSignIn on failure. */
  loginCommand: string
  /** The runtime already has the subscription credential (Hermes codexAuth /
   *  OpenClaw oauth profile). */
  connected: boolean
  /** Codex itself is connected — the prerequisite for reusing the subscription. */
  codexReady: boolean
  /** Re-probe after a successful sign-in (flips `connected` true). */
  onChanged: () => void | Promise<void>
}

export function RuntimeSubscriptionSection({
  tool,
  name,
  loginCommand,
  connected,
  codexReady,
  onChanged,
}: RuntimeSubscriptionSectionProps) {
  if (connected) {
    return (
      <ChatGptConnected
        title="Running on your ChatGPT subscription"
        detail={`${name} can use your ChatGPT plan for OpenAI models, alongside its own key.`}
        testId={`runtime-${tool}-subscription-connected`}
      />
    )
  }

  if (!codexReady) {
    return (
      <p
        className="flex items-start gap-1.5 text-[11.5px] leading-relaxed"
        style={{ color: muted(0.5) }}
        data-testid={`runtime-${tool}-subscription-needs-codex`}
      >
        <ArrowRight size={12} className="mt-0.5 shrink-0 opacity-60" />
        Connect Codex first (its own row above, or the Providers tab) to reuse your ChatGPT
        subscription here.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`runtime-${tool}-subscription-add`}>
      <p className="text-[11.5px] leading-relaxed" style={{ color: muted(0.55) }}>
        <span className="font-medium" style={{ color: muted(0.75) }}>
          Codex is connected.
        </span>{' '}
        Run {name} on your ChatGPT subscription for OpenAI models. Each runtime keeps its own
        sign-in, so connect it here too.
      </p>
      <ChatGptSignIn
        tool={tool}
        loginCommand={loginCommand}
        onLoggedIn={() => void onChanged()}
        label="Use my ChatGPT subscription"
      />
    </div>
  )
}
