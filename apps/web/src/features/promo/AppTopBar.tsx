import { GitHubStarButton } from './GitHubStarButton'

// AppTopBar — slim in-flow top strip (44 px) rendered above `ContentArea`
// inside the main column. Hosts the GitHub Star pill on the right.
//
// Why in-flow instead of an overlay:
//   - Overlay tried to share the row with each view's existing top-right
//     content (Atlas's Re-layout/Team-halos/Connect, Group Chat's
//     Brief & Rules gear, Cost's Frugal Mode, Agent Detail's model
//     selector). Even after matching the pill's height to those buttons,
//     the VERTICAL CENTER of each view's first row differs (each has its
//     own padding / row height), so a fixed-top pill could never align
//     with all four at once.
//   - An in-flow bar lives in its own row, fully aligned by construction.
//     Costs 44 px of always-on chrome, which is acceptable — the bar is
//     a natural slot for future global CTAs (Discord, docs, notifications).
//
// Height kept tight at 44 px (button 32 px + 6 px top/bottom padding).

export function AppTopBar() {
  return (
    <div
      data-testid="app-top-bar"
      className="flex h-11 shrink-0 items-center justify-end border-b border-border bg-background px-3"
    >
      <GitHubStarButton />
    </div>
  )
}
