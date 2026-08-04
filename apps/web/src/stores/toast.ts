import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
  id: string
  message: string
  type: ToastType
}

/**
 * What the screen-reader live region reads. Held OUTSIDE `toasts` on purpose:
 * the visual list is driven by `AnimatePresence` (exiting nodes stay mounted
 * through their spring, then vanish), so a live region derived from `toasts`
 * would re-announce a lingering toast on every expiry — and when one expires the
 * array shrinks, so "the newest toast" would jump BACK to an older message.
 * Written exactly once per `addToast`, cleared only by the toast that wrote it.
 */
export interface ToastAnnouncement {
  id: string
  type: ToastType
  text: string
}

interface ToastStore {
  toasts: Toast[]
  announcement: ToastAnnouncement | null
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
}

/** How long a toast stays on screen. */
export const TOAST_TTL_MS = 3000

// Tone rides in the announced TEXT because the only visual tone cue is the
// leading icon's colour — and that icon is aria-hidden. Without this, "Saved"
// and "Couldn't save" are indistinguishable to a screen reader (WCAG 1.4.1).
const TONE_PREFIX: Record<ToastType, string> = {
  success: 'Success: ',
  error: 'Error: ',
  info: '',
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  announcement: null,
  addToast: (t) => {
    const id = crypto.randomUUID()
    set((s) => ({
      toasts: [...s.toasts, { ...t, id }],
      announcement: { id, type: t.type, text: `${TONE_PREFIX[t.type]}${t.message}` },
    }))
    setTimeout(() => {
      set((s) => ({
        toasts: s.toasts.filter((x) => x.id !== id),
        // Drop the announcement too — unless a newer toast already replaced it.
        // Clearing a live region does not announce anything; this just keeps
        // stale text out of the AT tree for someone browsing with a virtual cursor.
        announcement: s.announcement?.id === id ? null : s.announcement,
      }))
    }, TOAST_TTL_MS)
  },
  removeToast: (id) =>
    set((s) => ({
      toasts: s.toasts.filter((x) => x.id !== id),
      announcement: s.announcement?.id === id ? null : s.announcement,
    })),
}))
