import { create } from 'zustand'

/**
 * Shared liveness flag for the interactive capability tour (CapabilityTour).
 *
 * The tour is a spotlight coach-mark walkthrough that dims the shell and guides
 * the user across the sidebar surfaces. While it's running it OWNS the first-run
 * guidance, so the standing `FirstRunNudge` ("Your team is ready" → Open the
 * Board) must stay hidden — otherwise both stack on the dashboard at once (the
 * cluttered double-popup the redesign fixes). The tour ends on a dedicated
 * "You're all set → Open the Board" step that replaces the nudge for tour-takers.
 *
 * Kept as a standalone one-field store (not folded into the view/settings
 * stores) so any surface can read tour liveness without importing the tour
 * module or its framer-motion payload.
 */
interface TourStore {
  active: boolean
  setActive: (active: boolean) => void
}

export const useTourStore = create<TourStore>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}))
