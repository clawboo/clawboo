import { create } from 'zustand'

// Imperative confirmation dialog — the design-system replacement for the native,
// unstyleable `window.confirm`. A caller does:
//   if (!(await confirm({ message, tone: 'danger', confirmLabel: 'Delete' }))) return
// The <ConfirmDialog/> mounted at the app root reads this store, renders the modal,
// and resolves the promise on OK / Cancel / Escape / scrim-click.

export interface ConfirmOptions {
  /** Optional bold title above the message. */
  title?: string
  /** The body copy. */
  message: string
  /** Primary button label (default "Confirm"). */
  confirmLabel?: string
  /** Secondary button label (default "Cancel"). */
  cancelLabel?: string
  /** `danger` gives the primary button the destructive (red) styling. */
  tone?: 'default' | 'danger'
}

interface ConfirmStore {
  open: boolean
  /** Kept through the exit animation; overwritten on the next `confirm()`. */
  options: ConfirmOptions | null
  resolver: ((value: boolean) => void) | null
  confirm: (options: ConfirmOptions) => Promise<boolean>
  /** Resolve the pending promise and close (OK = true, Cancel/Escape = false). */
  settle: (value: boolean) => void
}

export const useConfirmStore = create<ConfirmStore>((set, get) => ({
  open: false,
  options: null,
  resolver: null,
  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      // If one is somehow already open, cancel it before opening the new one.
      get().resolver?.(false)
      set({ open: true, options, resolver: resolve })
    }),
  settle: (value) => {
    const r = get().resolver
    // Keep `options` so the modal renders correctly through its exit animation.
    set({ open: false, resolver: null })
    r?.(value)
  },
}))

/** Imperative confirm — `await confirm({ message, tone: 'danger', confirmLabel: 'Delete' })`.
 *  Resolves `true` on the primary action, `false` on cancel / Escape / scrim. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().confirm(options)
}
