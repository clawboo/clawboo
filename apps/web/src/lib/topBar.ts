import { NAV_VIEWS, type NavView, type ViewMode } from '@/stores/view'

// Single source of truth for "does this view host the GitHub Star pill inline?"
//
// Every nav view renders <GitHubStarButton/> in its own header row, and the
// agent / booZero / groupChat views host it in their identity / team header.
// The global `AppTopBar` (a 44 px strip whose ONLY content is the Star pill)
// would therefore be a DUPLICATE in those views — it is shown ONLY for `welcome`,
// the one view without a header of its own.
//
// Built from `NAV_VIEWS` so a newly-added nav view can never be silently left out
// (which is exactly the bug this replaces: new dashboard tabs rendered both the
// AppTopBar and their inline pill → two Star buttons). The `topBar.test.ts` suite
// enforces full coverage.
export const NAV_WITH_INLINE_STAR: ReadonlySet<NavView> = new Set(NAV_VIEWS)

/** Whether the global AppTopBar (Star-pill-only strip) should render for a view. */
export function shouldShowGlobalTopBar(viewMode: ViewMode): boolean {
  if (viewMode.type === 'nav') return !NAV_WITH_INLINE_STAR.has(viewMode.view)
  // agent / booZero / groupChat host the Star inline; only `welcome` falls back
  // to the global bar.
  return viewMode.type === 'welcome'
}
