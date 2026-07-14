// The agent's runtime icon fused with its model control as ONE element: a
// runtime-tinted icon cell + a divider + either the editable model dropdown
// (native / OpenClaw / Hermes, which honor a per-agent model — Hermes routes every
// model through OpenRouter, editable here like native) OR a framed "runtime-managed
// model" note (Codex / Claude Code, which run on their account / SDK default). Showing
// the OpenClaw model dropdown for the note runtimes was misleading, so a note replaces it.

import { MarkGlyph, resolveRuntimeMark } from '@/features/runtimes/RuntimeBrand'
import type { ModelGroup } from '@/lib/modelCatalog'

import { AgentModelSelector } from './AgentModelSelector'

/** Runtimes whose model is NOT editable in the agent-detail selector — a framed note
 *  replaces the dropdown (native + OpenClaw are absent → they keep the dropdown). */
const RUNTIME_MODEL_NOTE: Record<string, { pill: string; tip: string }> = {
  codex: {
    pill: 'Codex default',
    tip: "This agent runs on your Codex account's model — change it with the Codex CLI.",
  },
  'claude-code': {
    pill: 'Claude Code default',
    tip: "This agent runs on Claude Code's default model.",
  },
}

interface AgentModelControlProps {
  runtime?: string | null
  currentModel: string | null
  defaultModel: string | null
  onModelChange: (model: string | null) => void
  groups?: ModelGroup[]
  configuredProviders?: Set<string>
  hideDefault?: boolean
}

export function AgentModelControl({ runtime, ...selectorProps }: AgentModelControlProps) {
  const mark = resolveRuntimeMark(runtime)
  const note = runtime ? RUNTIME_MODEL_NOTE[runtime] : undefined
  return (
    <div
      className="inline-flex items-stretch rounded-lg border border-border bg-surface"
      style={{ height: 28 }}
    >
      {/* Runtime icon cell — brand-tinted, with a hairline divider to the model control. */}
      <span
        title={`Runtime: ${mark.label}`}
        aria-label={`Runtime: ${mark.label}`}
        className="flex shrink-0 items-center justify-center"
        style={{
          width: 30,
          borderRight: '1px solid var(--border)',
          borderRadius: '7px 0 0 7px',
          background: `color-mix(in srgb, ${mark.color} 14%, transparent)`,
          color: mark.color,
        }}
      >
        <MarkGlyph glyph={mark.glyph} size={15} />
      </span>
      {/* Editable dropdown (native / OpenClaw) OR a runtime-managed note. */}
      {note ? (
        <span
          title={note.tip}
          className="flex items-center whitespace-nowrap text-[11px] text-foreground/45"
          style={{ padding: '0 10px', maxWidth: 180 }}
        >
          {note.pill}
        </span>
      ) : (
        <AgentModelSelector bare {...selectorProps} />
      )}
    </div>
  )
}
