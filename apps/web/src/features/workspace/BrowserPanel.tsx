// What the agent is looking at — the agent-detail tab's version.
//
// Deliberately the CHEAP version: the newest screenshot the agent captured,
// re-fetched on a short interval. Not a video stream. The field's own evidence
// is that a screencast is a large amount of transport engineering for something
// people watch as a takeover hatch rather than as a monitor, and that the
// projects with the most-loved surfaces shipped exactly this — an `<img>` fed
// from tool results.
//
// This one FILLS its pane and labels the frame, because it is a tab with a pane
// to fill. `BrowserDock` renders the same frame bare. Both read the same probe
// (`useAgentScreenshot`), so they can never disagree about which frame is current.

import { useAgentScreenshot } from './useAgentScreenshot'

export function BrowserPanel({ agentId }: { agentId: string }) {
  const { meta, checked, src } = useAgentScreenshot(agentId)

  if (!checked) return null

  if (!meta || !src) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-[42ch] text-center text-[12px] leading-relaxed text-muted-foreground">
          Nothing captured yet. This shows the most recent screenshot this agent took, once it calls
          a tool that returns one.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {meta.toolName}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {new Date(meta.ts).toLocaleTimeString()}
        </span>
      </div>
      {/* The frame is CONTAINED and centred, never stretched to fill. A browser
          screenshot is landscape and this pane is portrait, so `w-full` left two
          thirds of the surface as dead white below the image — which reads as a
          broken layout rather than a viewer. */}
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto rounded-lg bg-foreground/[0.04] p-3">
        <img
          // `ts` in the key remounts the element on a new frame. The URL is
          // stable by design (it is "the latest frame"), so without this the
          // panel would show the first screenshot for the rest of the run.
          key={meta.ts}
          src={src}
          alt={`Screenshot captured by ${meta.toolName}`}
          className="max-h-full max-w-full rounded-md border border-border object-contain shadow-sm"
        />
      </div>
    </div>
  )
}
